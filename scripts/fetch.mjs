// Pulls release notes out of the (private) product repos and returns plain
// data. Makes every network call this project makes; render.mjs is pure.
//
// Uses the GitHub REST API directly via global fetch rather than shelling out
// to `gh`, so `node scripts/build.mjs` behaves identically on a laptop and on
// a runner given the same GH_TOKEN.

const API = 'https://api.github.com'

/** Marker you can paste into a GitHub release body to retract it from the public site. */
const HIDE_MARKER = '<!-- uki-releases:hide -->'
/** Marker on a single bullet to drop just that line. */
const SKIP_LINE_MARKER = '[skip-public]'

function token() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!t) {
    throw new Error(
      'GH_TOKEN is not set. This needs a fine-grained PAT with Contents: Read-only ' +
        'on the repos listed in repos.json — the product repos are private.',
    )
  }
  return t
}

async function gh(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token()}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    // 404 on a private repo almost always means the PAT does not grant it,
    // not that the repo is missing — say so, because the API will not.
    const hint =
      res.status === 404
        ? ' (for a private repo this usually means the PAT does not include it, or its grant was not approved)'
        : ''
    throw new Error(`GitHub ${method} ${path} -> ${res.status} ${res.statusText}${hint}`)
  }
  return accept.includes('json') ? res.json() : res.text()
}

/**
 * release-please fills its notes with links to commits and PRs inside the
 * source repo. Those repos are private, so every one of those links is a 404
 * for a visitor. Demote them to their own text rather than shipping dead links.
 */
export function stripPrivateLinks(markdown, owner, repoNames) {
  const repoAlternation = repoNames.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const linkToPrivateRepo = new RegExp(
    `\\[([^\\]]*)\\]\\(https://github\\.com/${owner}/(?:${repoAlternation})/[^)]*\\)`,
    'g',
  )
  return markdown
    .replace(linkToPrivateRepo, '$1')
    // Bare compare/commit URLs appear in the release-please footer too.
    .replace(new RegExp(`https://github\\.com/${owner}/(?:${repoAlternation})/\\S+`, 'g'), '')
}

function dropSkippedLines(markdown) {
  return markdown
    .split('\n')
    .filter(line => !line.includes(SKIP_LINE_MARKER))
    .join('\n')
}

/** GitHub renders and sanitizes the HTML for us, so nothing here has to trust the body. */
async function renderMarkdown(text) {
  if (!text.trim()) return ''
  // mode 'markdown', not 'gfm': gfm autolinks bare #123 references into the
  // source repo, which is private, producing links that 404 for the public.
  return gh('/markdown', {
    method: 'POST',
    body: { text, mode: 'markdown' },
    accept: 'text/html',
  })
}

export async function gatherReleases(config) {
  const { owner, repos, maxReleasesPerRepo = 10 } = config
  const repoNames = repos.map(r => r.name)
  const sections = []

  for (const repo of repos) {
    const raw = await gh(
      `/repos/${owner}/${repo.name}/releases?per_page=${maxReleasesPerRepo}`,
    )

    const releases = []
    for (const rel of raw) {
      if (rel.draft || rel.prerelease) continue
      const body = rel.body || ''
      if (body.includes(HIDE_MARKER)) continue

      const cleaned = stripPrivateLinks(dropSkippedLines(body), owner, repoNames)
      releases.push({
        tag: rel.tag_name,
        name: rel.name || rel.tag_name,
        publishedAt: rel.published_at,
        html: await renderMarkdown(cleaned),
      })
    }

    // I1: buildBanner can throw on an unexpected shape or malformed date, and
    // computeServiceBanner is supposed to degrade every such failure to null
    // itself — but a bug there must still never take down the whole publish,
    // so this is defense in depth, not the primary guard.
    let banner
    try {
      banner = await computeServiceBanner(owner, repo, releases)
    } catch (err) {
      console.log(`  ${repo.name}: banner computation failed unexpectedly (${err.message}) — omitting "now live" banner`)
      banner = null
    }
    sections.push(toPublicSection(repo, releases, banner))
    console.log(`  ${repo.name}: ${releases.length} release(s)`)
  }

  return { owner, sections, generatedAt: new Date().toISOString() }
}

/**
 * Shapes the object render.mjs consumes and build.mjs publishes verbatim as
 * site/releases.json — a raw `repos.json` entry is not safe to publish as-is,
 * since `probeUrl`/`probeUrlEnv` describe internal probe configuration (a
 * Cloud Run URL, or the name of the env var that holds one). Strip both at
 * this boundary so neither can reach the published artifact or this public
 * repo's permanent git history, no matter what else lands in repos.json later.
 */
export function toPublicSection(repo, releases, banner) {
  const { probeUrl, probeUrlEnv, ...publicRepo } = repo
  return { ...publicRepo, releases, banner }
}

// ---------------------------------------------------------------------------
// "Now live" banners (Phase A)
//
// GitHub Deployments and health probes are the two new data sources here, and
// both can carry operational detail (shas, Cloud Run hostnames, environment
// URLs) that must never reach the public page. The discipline mirrors
// stripPrivateLinks above: fetchDeployments/resolveTagIndex return raw data
// that still contains shas, but buildBanner — the only place that assembles
// what render.mjs receives — never copies a sha into its output, only a
// resolved tag (or an explicit "untagged" fallback) and a date. There is no
// field in the banner shape a sha could hide in.

/**
 * GitHub marks a deployment's *previous* successful status 'inactive' once a
 * newer one supersedes it, so the currently-live deployment is the newest
 * annotated 'success' — or, if newer attempts since then failed, the newest
 * 'inactive'. `deployments` must be newest-first.
 */
export function pickCurrentDeployment(deployments) {
  return (
    deployments.find(d => d.state === 'success') ??
    deployments.find(d => d.state === 'inactive') ??
    null
  )
}

/**
 * Newest live deployment per environment. Walks each environment's
 * deployments newest-first, fetching one status at a time and stopping as
 * soon as pickCurrentDeployment can give a final answer — mirrors the lazy
 * walk in uki-tutor-infra/scripts/status/collect.mjs so a 'success' three
 * deployments back never costs fetching statuses for the other seven.
 *
 * Returns `{ [env]: { sha, deployedAt } | null }`. Throws on a GitHub API
 * error (e.g. the PAT lacks Deployments: Read) — callers that want to
 * degrade instead of fail must catch (see computeServiceBanner).
 */
export async function fetchDeployments(owner, repo, environments = ['prod', 'dev'], ghFn = gh) {
  const result = {}
  for (const env of environments) {
    const list = await ghFn(
      `/repos/${owner}/${repo}/deployments?environment=${encodeURIComponent(env)}&per_page=10`,
    )
    const annotated = []
    let current = null
    for (const d of list) {
      const statuses = await ghFn(`/repos/${owner}/${repo}/deployments/${d.id}/statuses?per_page=1`)
      annotated.push({ sha: d.sha, createdAt: d.created_at, state: statuses[0]?.state ?? 'unknown' })
      current = pickCurrentDeployment(annotated)
      if (current?.state === 'success') break
    }
    result[env] = current ? { sha: current.sha, deployedAt: current.createdAt } : null
  }
  return result
}

/**
 * A single liveness GET. Records reachable/unreachable only — no status
 * code, no latency, nothing that would be internal detail on a public page.
 * Never throws: an unreachable prod is a result to render (amber dot), not a
 * build failure.
 */
export async function probeProd(url, { timeoutMs = 2000, retries = 1, fetchFn = fetch } = {}) {
  if (!url) return false
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
      return res.ok
    } catch {
      if (attempt >= retries) return false
    }
  }
}

/**
 * Resolves the release tag for each deployed sha, by asking GitHub what
 * commit each already-fetched release's tag points at. Walks releases
 * newest-first and stops once every sha in `shas` has been matched (or the
 * list runs out) rather than resolving all of them — most builds are a
 * handful of releases behind, not ten.
 *
 * Returns `{ index, failed }` rather than a bare Map (C3): a per-release
 * lookup failure (a transient 403, a rate limit) must never be swallowed
 * into "this release is untagged" — that reads to computeServiceBanner as a
 * confident, false "a newer build is live" claim instead of what it actually
 * is, a lookup that never happened. `failed` is the count of lookups that
 * errored; callers must treat any nonzero count as "the index is
 * incomplete, do not trust it" and degrade, exactly like a thrown error.
 */
export async function resolveTagIndex(owner, repo, releases, shas, ghFn = gh) {
  const remaining = new Set(shas.filter(Boolean))
  const index = new Map()
  let failed = 0
  if (remaining.size === 0 || !Array.isArray(releases)) return { index, failed }

  for (const release of releases) {
    if (remaining.size === 0) break
    let sha = null
    try {
      const commit = await ghFn(`/repos/${owner}/${repo}/commits/${encodeURIComponent(release.tag)}`)
      sha = commit?.sha ?? null
    } catch {
      failed++
      continue
    }
    if (sha && !index.has(sha)) {
      index.set(sha, release.tag)
      remaining.delete(sha)
    }
  }
  return { index, failed }
}

/**
 * Resolves one environment's deployment to a display tag.
 *
 * If the deployed sha matches a known release exactly, that release is the
 * tag. Otherwise the build is untagged: it falls back to the newest release
 * published at or before the deployment, per the design spec's sha→tag
 * mapping rule ("falls back to the newest release whose date <= the
 * deployment's date"). `index` is this release's position in `releases`
 * (0 = newest) — used only to compare recency between prod and dev, never
 * rendered. Returns null when no release exists at or before the deployment
 * (nothing meaningful to display).
 */
function resolveEnvEntry(deployment, releases, tagIndex) {
  const exactTag = tagIndex.get(deployment.sha) ?? null
  if (exactTag) {
    return { tag: exactTag, untagged: false, index: releases.findIndex(r => r.tag === exactTag) }
  }
  const deployedAt = new Date(deployment.deployedAt)
  const fallback = releases.find(r => new Date(r.publishedAt) <= deployedAt)
  if (!fallback) return null
  return { tag: fallback.tag, untagged: true, index: releases.findIndex(r => r.tag === fallback.tag) }
}

/**
 * Pure assembly of the banner render.mjs consumes, from already-resolved
 * inputs (no network here). This is the one place that decides what is safe
 * to hand to the renderer — notably, no sha ever enters the returned shape,
 * and `publicUrl` is only ever set to what the caller passed in, which for
 * API/Admin is always undefined (see repos.json / computeServiceBanner).
 *
 * Returns null when there is nothing safe/meaningful to show (no prod
 * deployment, or a prod deployment older than every known release) — the
 * caller omits the banner entirely in that case.
 */
export function buildBanner({ prod, dev, releases, tagIndex, publicUrl, prodReachable }) {
  if (!prod) return null

  const prodEntry = resolveEnvEntry(prod, releases, tagIndex)
  if (!prodEntry) return null

  const devEntry = dev ? resolveEnvEntry(dev, releases, tagIndex) : null
  const sameBuild = Boolean(dev) && dev.sha === prod.sha
  const sameTag = Boolean(prodEntry.tag && devEntry?.tag && prodEntry.tag === devEntry.tag)
  // "An untagged dev build that resolves to no newer tag than prod counts as
  // dev == prod": dev's resolved release is at the same position or older
  // (>= index, since 0 is newest) than prod's.
  const noNewerThanProd = Boolean(devEntry) && devEntry.index >= prodEntry.index
  const devEqualsProd = !devEntry || sameBuild || sameTag || noNewerThanProd

  return {
    prod: {
      version: prodEntry.tag,
      untagged: prodEntry.untagged,
      date: prod.deployedAt,
      // true = probed and answered · false = probed and did not · null = not
      // probed at all, so the renderer shows no status segment.
      reachable: prodReachable === null || prodReachable === undefined ? null : prodReachable === true,
    },
    dev: devEqualsProd ? null : { version: devEntry.tag, date: dev.deployedAt },
    publicUrl,
  }
}

/**
 * Orchestrates fetchDeployments + resolveTagIndex + probeProd + buildBanner
 * for one repo, degrading to `null` (banner omitted, release notes still
 * render) on any failure — most notably a PAT that has not yet been granted
 * Deployments: Read, which 403s/404s.
 */
export async function computeServiceBanner(owner, repo, releases, deps = {}) {
  const ghFn = deps.gh ?? gh
  const probeFn = deps.probeProd ?? probeProd
  // Three distinct states, not two. A repo with no probe configured at all
  // shows no status segment — the admin panel is internal, and telling the
  // public when it is up serves no reader of this page. A repo that *is*
  // configured but whose URL did not arrive (an unset secret) still renders
  // "status unknown", because that is a misconfiguration and hiding it would
  // make the page quietly less truthful.
  const probeConfigured = Boolean(repo.probeUrl || repo.probeUrlEnv)
  const probeUrl = repo.probeUrl ?? (repo.probeUrlEnv ? process.env[repo.probeUrlEnv] : undefined)

  let deployments
  try {
    deployments = await fetchDeployments(owner, repo.name, ['prod', 'dev'], ghFn)
  } catch (err) {
    console.log(`  ${repo.name}: deployments unavailable (${err.message}) — omitting "now live" banner`)
    return null
  }

  const shas = [deployments.prod?.sha, deployments.dev?.sha].filter(Boolean)
  let tagIndex
  try {
    const result = await resolveTagIndex(owner, repo.name, releases, shas, ghFn)
    // C3: any failed per-release lookup means the index cannot be trusted —
    // treat it exactly like the deployments-failure path above, not like a
    // legitimately-untagged build. The alternative is a page that asserts a
    // release is "a newer build" when the tagged release it failed to
    // recognise is precisely what is running.
    if (result.failed > 0) {
      console.log(
        `  ${repo.name}: ${result.failed} release-tag lookup(s) failed — omitting "now live" banner`,
      )
      return null
    }
    tagIndex = result.index
  } catch (err) {
    console.log(`  ${repo.name}: release-tag lookup failed (${err.message}) — omitting "now live" banner`)
    return null
  }

  // null, not false: false means "probed and did not answer".
  const prodReachable = probeConfigured ? await probeFn(probeUrl) : null

  // I1: buildBanner is pure but not infallible — an unexpected shape or a
  // malformed date can throw, and that must degrade this one banner, not
  // fail the whole build (unconditional per the spec's degradation rule).
  try {
    return buildBanner({
      prod: deployments.prod,
      dev: deployments.dev,
      releases,
      tagIndex,
      publicUrl: repo.publicUrl,
      prodReachable,
    })
  } catch (err) {
    console.log(`  ${repo.name}: banner assembly failed (${err.message}) — omitting "now live" banner`)
    return null
  }
}
