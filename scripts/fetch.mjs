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

    sections.push({ ...repo, releases })
    console.log(`  ${repo.name}: ${releases.length} release(s)`)
  }

  return { owner, sections, generatedAt: new Date().toISOString() }
}
