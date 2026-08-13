// node --test scripts/
//
// Covers the redaction rules only. They are the part of this project that can
// fail silently and publicly: if stripPrivateLinks stops matching, the page
// still builds and still looks correct, it just fills with links that 404 for
// every visitor. Uses node:test so this stays dependency-free.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  stripPrivateLinks,
  pickCurrentDeployment,
  fetchDeployments,
  probeProd,
  resolveTagIndex,
  buildBanner,
  computeServiceBanner,
  toPublicSection,
  gatherReleases,
} from './fetch.mjs'
import { escapeHtml, renderPage } from './render.mjs'

const OWNER = 'UKi-Hub-Center'
const REPOS = ['uki-tutor-ui', 'uki-tutor-service', 'uki-admin-service']
const strip = md => stripPrivateLinks(md, OWNER, REPOS)

test('demotes a commit link into a private repo to plain text', () => {
  const body =
    '* release the certificate blob when its tab closes ' +
    '([058d379](https://github.com/UKi-Hub-Center/uki-tutor-ui/commit/058d379))'
  const out = strip(body)
  assert.ok(!out.includes('https://github.com'), `link survived: ${out}`)
  assert.ok(out.includes('058d379'), 'the sha text should remain')
})

test('demotes a PR link and strips the release-please compare footer', () => {
  const body = [
    '### Features',
    '',
    '* **payouts:** ask Stripe whether onboarding finished ' +
      '([#51](https://github.com/UKi-Hub-Center/uki-tutor-ui/issues/51))',
    '',
    'Full Changelog: https://github.com/UKi-Hub-Center/uki-tutor-ui/compare/v0.1.0...v0.2.0',
  ].join('\n')
  const out = strip(body)
  assert.ok(!out.includes('github.com'), `a private URL survived: ${out}`)
  assert.ok(out.includes('#51'), 'the PR reference text should remain')
  assert.ok(out.includes('ask Stripe whether onboarding finished'))
})

test('leaves links to public destinations alone', () => {
  const body = 'See [semver](https://semver.org/) and [the spec](https://www.conventionalcommits.org/).'
  assert.equal(strip(body), body)
})

test('does not match a different org that merely shares a repo name', () => {
  const body = '[x](https://github.com/SomeoneElse/uki-tutor-ui/commit/abc)'
  assert.equal(strip(body), body)
})

test('escapeHtml neutralises markup in tag names and titles', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(escapeHtml(null), '')
})

test('renderPage emits a complete document and the freshness stamp', () => {
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-09T12:34:56.000Z',
    sections: [
      {
        name: 'uki-tutor-ui',
        title: 'Web & mobile app',
        blurb: 'React + Capacitor client',
        releases: [
          {
            tag: 'v0.1.0',
            name: 'v0.1.0',
            publishedAt: '2026-08-09T12:00:00Z',
            html: '<h3>Features</h3><ul><li>a thing</li></ul>',
          },
        ],
      },
      { name: 'uki-tutor-service', title: 'API', blurb: 'Go backend', releases: [] },
    ],
  })

  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('2026-08-09 12:34 UTC'), 'freshness stamp must be rendered')
  assert.ok(html.includes('v0.1.0'))
  assert.ok(html.includes('<h3>Features</h3>'), 'pre-rendered notes pass through')
  assert.ok(html.includes('No releases published yet.'), 'empty repo renders an honest empty state')
  assert.ok(html.includes('Web &amp; mobile app'), 'section titles are escaped')
  // Nothing may load from a third-party origin.
  assert.ok(!/<(script|link)\b/i.test(html), 'page must stay self-contained')
})

// ---------------------------------------------------------------------------
// "Now live" banners (Phase A)
//
// Fictional but realistically-shaped fixtures below: 40-hex shas, and — in
// the leak test — the exact internal hostnames/instance names named in the
// design brief, so a passing test is evidence against the real forbidden
// strings, not just "some string that looks sha-ish".

const SHA_V012 = 'c3'.repeat(20) // tagged uki-tutor-service-v0.1.2
const SHA_V013 = 'b2'.repeat(20) // tagged uki-tutor-service-v0.1.3
const SHA_V020 = 'a1'.repeat(20) // tagged uki-tutor-service-v0.2.0
const SHA_UNTAGGED_PROD = 'd4'.repeat(20) // no matching release
const SHA_UNTAGGED_DEV = 'e5'.repeat(20) // no matching release

const RELEASES_3 = [
  { tag: 'uki-tutor-service-v0.2.0', publishedAt: '2026-08-13T02:46:52Z' },
  { tag: 'uki-tutor-service-v0.1.3', publishedAt: '2026-08-12T05:10:27Z' },
  { tag: 'uki-tutor-service-v0.1.2', publishedAt: '2026-08-11T12:59:48Z' },
]

const TAG_INDEX_3 = new Map([
  [SHA_V020, 'uki-tutor-service-v0.2.0'],
  [SHA_V013, 'uki-tutor-service-v0.1.3'],
  [SHA_V012, 'uki-tutor-service-v0.1.2'],
])

// --- pickCurrentDeployment -------------------------------------------------

test('pickCurrentDeployment prefers the newest success over an older inactive', () => {
  const deployments = [
    { sha: 'newer', state: 'inactive' },
    { sha: 'newest-success', state: 'success' },
    { sha: 'oldest', state: 'success' },
  ]
  assert.equal(pickCurrentDeployment(deployments)?.sha, 'newest-success')
})

test('pickCurrentDeployment falls back to the newest inactive when nothing succeeded since', () => {
  const deployments = [
    { sha: 'newest-failed', state: 'failure' },
    { sha: 'last-good', state: 'inactive' },
  ]
  assert.equal(pickCurrentDeployment(deployments)?.sha, 'last-good')
})

test('pickCurrentDeployment returns null for an empty or all-failed list', () => {
  assert.equal(pickCurrentDeployment([]), null)
  assert.equal(pickCurrentDeployment([{ sha: 'x', state: 'failure' }]), null)
})

// --- buildBanner (pure) -----------------------------------------------------

test('buildBanner: tagged prod, differently-tagged dev — dev line shown', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: { sha: SHA_V020, deployedAt: '2026-08-13T02:47:31Z' },
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  assert.equal(banner.prod.version, 'uki-tutor-service-v0.1.2')
  assert.equal(banner.prod.untagged, false)
  assert.equal(banner.prod.reachable, true)
  assert.ok(banner.dev, 'dev line should be present when versions differ')
  assert.equal(banner.dev.version, 'uki-tutor-service-v0.2.0')
  assert.equal(banner.dev.date, '2026-08-13T02:47:31Z')
})

test('buildBanner: dev deploys the identical sha as prod — dev line omitted', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: { sha: SHA_V012, deployedAt: '2026-08-12T00:00:00Z' },
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  assert.equal(banner.dev, null)
})

test('buildBanner: prod and dev resolve to the same tag via different shas — dev line omitted', () => {
  // Contrived (two shas mapped to the same tag) but exercises the "same tag,
  // different build" branch independently of the "identical sha" branch.
  const tagIndex = new Map([
    [SHA_V012, 'uki-tutor-service-v0.1.2'],
    [SHA_UNTAGGED_DEV, 'uki-tutor-service-v0.1.2'],
  ])
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: { sha: SHA_UNTAGGED_DEV, deployedAt: '2026-08-12T00:00:00Z' },
    releases: RELEASES_3,
    tagIndex,
    publicUrl: undefined,
    prodReachable: true,
  })
  assert.equal(banner.dev, null)
})

test('buildBanner: untagged prod build falls back to the newest release at-or-before its deploy date, no sha anywhere', () => {
  const banner = buildBanner({
    // Between v0.1.2 (published 12:59:48) and v0.1.3 (published next day).
    prod: { sha: SHA_UNTAGGED_PROD, deployedAt: '2026-08-11T23:20:00Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  assert.equal(banner.prod.untagged, true)
  assert.equal(banner.prod.version, 'uki-tutor-service-v0.1.2')
  assert.ok(
    !JSON.stringify(banner).includes(SHA_UNTAGGED_PROD),
    'the deployed sha must never appear in the banner object handed to render.mjs',
  )
})

test('buildBanner: untagged dev that resolves to no newer tag than prod counts as dev == prod', () => {
  const releasesUpToV013 = RELEASES_3.filter(r => r.tag !== 'uki-tutor-service-v0.2.0')
  const tagIndex = new Map([[SHA_V013, 'uki-tutor-service-v0.1.3']])
  const banner = buildBanner({
    prod: { sha: SHA_V013, deployedAt: '2026-08-12T05:10:27Z' },
    // Untagged, deployed after prod, but no newer release exists yet.
    dev: { sha: SHA_UNTAGGED_DEV, deployedAt: '2026-08-12T06:00:00Z' },
    releases: releasesUpToV013,
    tagIndex,
    publicUrl: undefined,
    prodReachable: true,
  })
  assert.equal(banner.dev, null)
})

test('buildBanner: untagged dev that resolves to a genuinely newer release than prod — dev line shown', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    // Untagged, deployed after v0.2.0 was published — dev is ahead.
    dev: { sha: SHA_UNTAGGED_DEV, deployedAt: '2026-08-13T03:00:00Z' },
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  assert.ok(banner.dev)
  assert.equal(banner.dev.version, 'uki-tutor-service-v0.2.0')
})

test('buildBanner: no prod deployment — banner omitted entirely', () => {
  assert.equal(
    buildBanner({
      prod: null,
      dev: { sha: SHA_V020, deployedAt: '2026-08-13T02:47:31Z' },
      releases: RELEASES_3,
      tagIndex: TAG_INDEX_3,
      publicUrl: undefined,
      prodReachable: true,
    }),
    null,
  )
})

test('buildBanner: prod deployment predates every known release — banner omitted entirely', () => {
  const banner = buildBanner({
    prod: { sha: SHA_UNTAGGED_PROD, deployedAt: '2020-01-01T00:00:00Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  assert.equal(banner, null)
})

test('buildBanner: a failed probe normalises to reachable: false, an absent one to null', () => {
  const base = {
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
  }

  // Probed and did not answer — the page says so.
  assert.equal(buildBanner({ ...base, prodReachable: false }).prod.reachable, false)

  // Never probed (no probe configured for this service) — the page says
  // nothing, which is different from saying "unknown". Keeping these two
  // apart is the whole point: an unprobed service must not look degraded.
  assert.equal(buildBanner({ ...base, prodReachable: null }).prod.reachable, null)
  assert.equal(buildBanner({ ...base, prodReachable: undefined }).prod.reachable, null)

  // Anything else truthy-but-not-true is still not a success claim.
  assert.equal(buildBanner({ ...base, prodReachable: 'yes' }).prod.reachable, false)
})

// --- probeProd ---------------------------------------------------------------

test('probeProd: no url configured — returns false without attempting a fetch', async () => {
  let called = false
  const result = await probeProd(undefined, { fetchFn: async () => { called = true; return { ok: true } } })
  assert.equal(result, false)
  assert.equal(called, false)
})

test('probeProd: reachable — returns true', async () => {
  const result = await probeProd('https://example.test', { fetchFn: async () => ({ ok: true }) })
  assert.equal(result, true)
})

test('probeProd: every attempt fails — retries once, then returns false without throwing', async () => {
  let calls = 0
  const fetchFn = async () => { calls++; throw new Error('boom') }
  const result = await probeProd('https://example.test', { fetchFn, timeoutMs: 10, retries: 1 })
  assert.equal(result, false)
  assert.equal(calls, 2, 'initial attempt plus exactly one retry')
})

test('probeProd: never throws even against a malformed URL', async () => {
  await assert.doesNotReject(() => probeProd('not a valid url', { retries: 0 }))
  assert.equal(await probeProd('not a valid url', { retries: 0 }), false)
})

// --- resolveTagIndex ----------------------------------------------------------

test('resolveTagIndex: a failed lookup for one tag does not lose matches for the others, but is still reported', async () => {
  const releases = [
    { tag: 'broken-tag', publishedAt: '2026-08-12T00:00:00Z' },
    { tag: 'good-tag', publishedAt: '2026-08-11T00:00:00Z' },
  ]
  const ghFn = async path => {
    if (path.includes('broken-tag')) throw new Error('404')
    return { sha: SHA_V012 }
  }
  const { index, failed } = await resolveTagIndex('owner', 'repo', releases, [SHA_V012], ghFn)
  assert.equal(index.get(SHA_V012), 'good-tag')
  // C3: the match still resolved, but the caller must still be told a lookup
  // failed — it cannot tell "resolved" apart from "one failure happened to
  // not matter this time" without this count.
  assert.equal(failed, 1)
})

test('resolveTagIndex: no failures reports failed: 0', async () => {
  const releases = [{ tag: 'good-tag', publishedAt: '2026-08-11T00:00:00Z' }]
  const ghFn = async () => ({ sha: SHA_V012 })
  const { index, failed } = await resolveTagIndex('owner', 'repo', releases, [SHA_V012], ghFn)
  assert.equal(index.get(SHA_V012), 'good-tag')
  assert.equal(failed, 0)
})

// C3 — regression guard: a failed tag lookup must never make the page assert
// something false. Before this fix, resolveTagIndex swallowed every
// per-release lookup error into `sha = null`, so a transient 403 made every
// deployed sha "resolve" as untagged — and the page then claimed "a newer
// build is live" for a service that was, in fact, running exactly the
// tagged release the lookup failed to recognise. The fix must make this
// indistinguishable, at the call site, from any other degradation: no
// banner, release notes still render.
test('C3: a 403 on one release-tag lookup omits the banner rather than rendering a false "newer build" claim', async () => {
  const ghFn = async path => {
    if (path.includes('/deployments?environment=prod')) {
      return [{ id: 1, sha: SHA_V012, created_at: '2026-08-11T23:19:51Z' }]
    }
    if (path.includes('/deployments?environment=dev')) return []
    if (path.includes('/deployments/1/statuses')) return [{ state: 'success' }]
    // Every tag lookup 403s — the real failure mode from tonight's rate limit.
    if (path.includes('/commits/')) throw new Error('GitHub GET ... -> 403 Forbidden')
    throw new Error(`unexpected path in test: ${path}`)
  }

  const banner = await computeServiceBanner(
    'UKi-Hub-Center',
    { name: 'uki-tutor-service' },
    RELEASES_3,
    { gh: ghFn },
  )
  assert.equal(banner, null, 'a failed tag lookup must omit the banner, not render an untagged guess')

  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [
      {
        name: 'uki-tutor-service',
        title: 'API',
        blurb: 'Go backend',
        releases: [
          { tag: 'uki-tutor-service-v0.1.2', name: 'v0.1.2', publishedAt: '2026-08-11T12:59:48Z', html: '<p>notes</p>' },
        ],
        banner,
      },
    ],
  })
  assert.ok(!html.includes('class="banner"'), 'no banner markup should be emitted')
  assert.ok(!html.includes('a newer build is live'), 'must never assert a false "newer build" claim')
  assert.ok(html.includes('uki-tutor-service-v0.1.2'), 'release cards must still render')
})

// --- computeServiceBanner (orchestration, network mocked) --------------------

test('computeServiceBanner: deployments fetch failing (e.g. PAT lacks Deployments: Read) degrades to no banner', async () => {
  const ghFn = async () => { throw new Error('GitHub GET ... -> 403 Forbidden') }
  const banner = await computeServiceBanner(
    'UKi-Hub-Center',
    { name: 'uki-tutor-service' },
    RELEASES_3,
    { gh: ghFn },
  )
  assert.equal(banner, null)
})

test('computeServiceBanner: end-to-end happy path resolves probeUrlEnv and produces the expected banner', async () => {
  process.env.TEST_PHASE_A_PROBE_URL = 'https://internal.example.invalid/health'
  try {
    const ghFn = async path => {
      if (path.includes('/deployments?environment=prod')) {
        return [{ id: 1, sha: SHA_V012, created_at: '2026-08-11T23:19:51Z' }]
      }
      if (path.includes('/deployments?environment=dev')) {
        return [{ id: 2, sha: SHA_V020, created_at: '2026-08-13T02:47:31Z' }]
      }
      if (path.includes('/deployments/1/statuses')) return [{ state: 'success' }]
      if (path.includes('/deployments/2/statuses')) return [{ state: 'success' }]
      if (path.includes('uki-tutor-service-v0.2.0')) return { sha: SHA_V020 }
      if (path.includes('uki-tutor-service-v0.1.3')) return { sha: SHA_V013 }
      if (path.includes('uki-tutor-service-v0.1.2')) return { sha: SHA_V012 }
      throw new Error(`unexpected path in test: ${path}`)
    }
    let probedUrl = null
    const probeFn = async url => { probedUrl = url; return true }

    const banner = await computeServiceBanner(
      'UKi-Hub-Center',
      { name: 'uki-tutor-service', probeUrlEnv: 'TEST_PHASE_A_PROBE_URL' },
      RELEASES_3,
      { gh: ghFn, probeProd: probeFn },
    )

    assert.equal(probedUrl, 'https://internal.example.invalid/health')
    assert.equal(banner.prod.version, 'uki-tutor-service-v0.1.2')
    assert.equal(banner.prod.reachable, true)
    assert.equal(banner.dev.version, 'uki-tutor-service-v0.2.0')
  } finally {
    delete process.env.TEST_PHASE_A_PROBE_URL
  }
})

// --- render-level: banner markup and the public/internal boundary ------------

// C2 — this deliberately does NOT include a sha pattern. 69 distinct 7-hex
// commit shas appear on the real page today, inside release-note bodies —
// that is pre-existing, approved behaviour: stripPrivateLinks demotes
// `[058d379](…/commit/058d379)` to the bare text `058d379` rather than
// stripping it (see "the sha text should remain" above and the invariant in
// CLAUDE.md), because the sha itself is a legitimate reference even though
// the link it lived in is not. Applying a page-wide sha check here would
// either always fail (correctly, on real content) or — as it did before this
// fix — pass for the wrong reason, because every fixture's release `html`
// happened to be sha-free. The sha check belongs on the banner region only
// (SHA_PATTERN / assertBannerHasNoShas below), because deployment shas are
// new-in-Phase-A data that must never reach render.mjs's output at all.
const forbiddenPatterns = {
  'a run.app hostname': /run\.app/i,
  'a pages.dev hostname': /pages\.dev/i,
  'the Cloud Run URL infix sgwblipyaa': /sgwblipyaa/i,
  'the Cloud Run URL infix q2omqw3zpa': /q2omqw3zpa/i,
  'the prod DB instance name': /uki-tutor-db-prod-e448/i,
  'the dev DB instance name': /uki-tutor-db-dev-80d0/i,
}

function assertNoForbiddenPatterns(html, patterns = forbiddenPatterns) {
  for (const [label, pattern] of Object.entries(patterns)) {
    assert.ok(!pattern.test(html), `leaked ${label} into rendered output`)
  }
}

// Regex, not a literal — a future change that renders a *different* sha (not
// one of the fixture values used elsewhere in this file) must still fail
// this check. Deliberately narrower in scope than forbiddenPatterns above:
// applied to banner markup only, never to the page as a whole.
const SHA_PATTERN = /\b[0-9a-f]{40}\b|\b[0-9a-f]{7}\b/i

function bannerBlocks(html) {
  return html.match(/<div class="banner">[\s\S]*?<\/div>/g) ?? []
}

function assertBannerHasNoShas(html) {
  for (const block of bannerBlocks(html)) {
    assert.ok(!SHA_PATTERN.test(block), `a commit sha leaked into a banner region: ${block}`)
  }
}

test('renderPage never leaks deployment/infra detail even when a section carries it as extra fields', () => {
  const apiBanner = buildBanner({
    prod: { sha: SHA_UNTAGGED_PROD, deployedAt: '2026-08-11T23:20:00Z' },
    dev: { sha: SHA_V020, deployedAt: '2026-08-13T02:47:31Z' },
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined, // API section: no URL may ever be shown
    prodReachable: true,
  })
  const spaBanner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: 'uki-tutor.com',
    prodReachable: false,
  })

  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [
      {
        // Simulates the real shape gatherReleases would produce via `...repo`
        // — extra config fields riding along on the section that render.mjs
        // must never read, carrying exactly the strings the brief forbids.
        name: 'uki-tutor-service',
        title: 'API',
        blurb: 'Go backend',
        probeUrl: 'https://uki-tutor-api-prod-sgwblipyaa-uc.a.run.app/health',
        probeUrlEnv: 'UKI_TUTOR_SERVICE_PROBE_URL',
        db: { instance: 'uki-tutor-db-prod-e448' },
        devDb: { instance: 'uki-tutor-db-dev-80d0' },
        devUrl: 'https://uki-tutor-api-dev-q2omqw3zpa-uc.a.run.app/health',
        deployedSha: SHA_UNTAGGED_PROD,
        releases: [
          { tag: 'uki-tutor-service-v0.1.2', name: 'v0.1.2', publishedAt: '2026-08-11T12:59:48Z', html: '<p>notes</p>' },
        ],
        banner: apiBanner,
      },
      {
        name: 'uki-tutor-ui',
        title: 'Web & mobile app',
        blurb: 'React + Capacitor client',
        devUrl: 'https://uki-tutor-ui-dev.pages.dev',
        releases: [
          { tag: 'uki-tutor-ui-v0.2.1', name: 'v0.2.1', publishedAt: '2026-08-10T16:32:41Z', html: '<p>notes</p>' },
        ],
        banner: spaBanner,
      },
    ],
  })

  assertNoForbiddenPatterns(html)
  assertBannerHasNoShas(html)
  assert.ok(!/<(script|link)\b/i.test(html), 'page must stay self-contained even with banners present')
  // Sanity: the banners actually rendered something, so the clean grep above
  // is not just an artifact of the banner being empty.
  assert.ok(html.includes('latest release'), 'untagged prod fallback text should render')
  assert.ok(html.includes('uki-tutor.com'), 'the SPA public URL should render')
})

// C2 — regression guard: proves the split assertion is honest. Before this
// fix, the sha pattern was checked page-wide but every test supplying it
// used trivial release `html` fixtures, so the check passed vacuously and
// never actually exercised the one thing that matters: that a *deployment*
// sha (new-in-Phase-A data) never reaches the banner, while a *release-note*
// sha (pre-existing, approved — see stripPrivateLinks) is free to survive
// anywhere else on the page.
test('C2: a release-note sha survives on the page while the banner region stays provably sha-free', () => {
  const noteSha = '058d379'
  const releaseHtml =
    `<ul><li><strong>profile:</strong> release the certificate blob when its tab closes (${noteSha})</li></ul>`

  // Untagged prod/dev, both resolved via a sha that must never itself reach
  // the rendered banner — buildBanner's contract, exercised here end to end.
  const banner = buildBanner({
    prod: { sha: SHA_UNTAGGED_PROD, deployedAt: '2026-08-11T23:20:00Z' },
    dev: { sha: SHA_UNTAGGED_DEV, deployedAt: '2026-08-13T02:47:31Z' },
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })

  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [
      {
        name: 'uki-tutor-ui',
        title: 'Web & mobile app',
        blurb: 'React + Capacitor client',
        releases: [
          { tag: 'uki-tutor-ui-v0.1.0', name: 'v0.1.0', publishedAt: '2026-08-10T02:06:55Z', html: releaseHtml },
        ],
        banner,
      },
    ],
  })

  assert.ok(html.includes(noteSha), 'the release-note sha is a deliberate, approved exception and must survive')
  assert.ok(bannerBlocks(html).length > 0, 'sanity: a banner actually rendered')
  assertBannerHasNoShas(html)
})

test('banner: API/Admin sections never render a URL of any kind', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [{ name: 'uki-tutor-service', title: 'API', blurb: 'Go backend', releases: [], banner }],
  })
  const bannerMarkup = html.slice(html.indexOf('class="banner"'), html.indexOf('</div>', html.indexOf('class="banner"')))
  assert.ok(!/https?:\/\//i.test(bannerMarkup), `API banner must not contain a URL: ${bannerMarkup}`)
  assert.ok(!bannerMarkup.includes('uki-tutor.com'))
})

test('banner: the SPA section shows its public URL', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: 'uki-tutor.com',
    prodReachable: true,
  })
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [{ name: 'uki-tutor-ui', title: 'Web & mobile app', blurb: '', releases: [], banner }],
  })
  assert.ok(html.includes('uki-tutor.com'))
})

test('banner: untagged prod renders "(a newer build is live)" with the fallback version and no sha', () => {
  const banner = buildBanner({
    prod: { sha: SHA_UNTAGGED_PROD, deployedAt: '2026-08-11T23:20:00Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [{ name: 'uki-tutor-service', title: 'API', blurb: '', releases: [], banner }],
  })
  assert.ok(html.includes('latest release'))
  assert.ok(html.includes('(a newer build is live)'))
  assert.ok(html.includes('uki-tutor-service-v0.1.2'))
  assert.ok(!/\b[0-9a-f]{40}\b|\b[0-9a-f]{7}\b/i.test(html))
})

test('banner: probe failure renders an amber "status unknown" dot, never a red error', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: null,
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: false,
  })
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [{ name: 'uki-tutor-service', title: 'API', blurb: '', releases: [], banner }],
  })
  const bannerMarkup = html.slice(html.indexOf('<div class="banner"'), html.indexOf('</div>', html.indexOf('<div class="banner"')))
  assert.ok(bannerMarkup.includes('status unknown'))
  assert.ok(!bannerMarkup.includes('operational'))
  assert.ok(!/error/i.test(bannerMarkup))
  assert.ok(bannerMarkup.includes('dot-unknown'))
  assert.ok(!bannerMarkup.includes('dot-ok'), `dot-ok class must not appear on an unreachable prod: ${bannerMarkup}`)
})

test('banner: deployments failure omits the banner but release cards still render', () => {
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [
      {
        name: 'uki-tutor-service',
        title: 'API',
        blurb: 'Go backend',
        releases: [
          { tag: 'uki-tutor-service-v0.1.2', name: 'v0.1.2', publishedAt: '2026-08-11T12:59:48Z', html: '<p>notes</p>' },
        ],
        banner: null,
      },
    ],
  })
  assert.ok(!html.includes('class="banner"'), 'no banner markup should be emitted')
  assert.ok(!html.includes('live in production'))
  assert.ok(html.includes('uki-tutor-service-v0.1.2'), 'release cards must still render')
  assert.ok(html.includes('<p>notes</p>'))
})

test('banner: dev == prod renders only the prod line, no "next up"', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: { sha: SHA_V012, deployedAt: '2026-08-12T00:00:00Z' },
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [{ name: 'uki-tutor-service', title: 'API', blurb: '', releases: [], banner }],
  })
  assert.ok(html.includes('live in production'))
  assert.ok(!html.includes('next up'))
})

test('banner: dev != prod renders the "next up" dev line with its own version and date', () => {
  const banner = buildBanner({
    prod: { sha: SHA_V012, deployedAt: '2026-08-11T23:19:51Z' },
    dev: { sha: SHA_V020, deployedAt: '2026-08-13T02:47:31Z' },
    releases: RELEASES_3,
    tagIndex: TAG_INDEX_3,
    publicUrl: undefined,
    prodReachable: true,
  })
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T03:00:00Z',
    sections: [{ name: 'uki-tutor-service', title: 'API', blurb: '', releases: [], banner }],
  })
  assert.ok(html.includes('next up'))
  assert.ok(html.includes('uki-tutor-service-v0.2.0'))
  assert.ok(html.includes('13 Aug 2026'))
})

// ---- status is three-state, not two -----------------------------------------
// A repo with no probe configured (the admin panel) carries no status on this
// page at all: no dot, no text. A repo that *is* configured but whose URL did
// not arrive still says "status unknown", because that is a misconfiguration
// and hiding it would make the page quietly less truthful.

test('a service with no probe configured renders no dot and no status text', async () => {
  const banner = await computeServiceBanner(
    OWNER,
    { name: 'uki-admin-service', title: 'Admin', blurb: 'Go backend' },
    [{ tag: 'v0.1.1', publishedAt: '2026-08-12T00:00:00Z' }],
    {
      gh: async path => {
        if (path.includes('/deployments?')) {
          return path.includes('prod')
            ? [{ id: 1, sha: 'aaa1111', created_at: '2026-08-13T00:00:00Z' }]
            : []
        }
        if (path.includes('/statuses')) return [{ state: 'success' }]
        if (path.includes('/commits/')) return { sha: 'aaa1111' }
        return []
      },
      probeProd: async () => {
        throw new Error('must not probe a service with no probe configured')
      },
    },
  )
  assert.equal(banner.prod.reachable, null, 'unprobed reads as null, not false')

  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T00:00:00Z',
    sections: [{ name: 'uki-admin-service', title: 'Admin', blurb: 'b', releases: [], banner }],
  })
  assert.ok(!html.includes('status unknown'), 'no amber "unknown" for an unprobed service')
  assert.ok(!html.includes('operational'), 'and no green claim either')
  assert.ok(!/<span class="dot/.test(html), 'no status dot at all')
  assert.ok(html.includes('live in production since'), 'the version line still renders')
})

test('a configured probe that fails still renders "status unknown"', () => {
  const html = renderPage({
    owner: OWNER,
    generatedAt: '2026-08-13T00:00:00Z',
    sections: [
      {
        name: 'uki-tutor-service',
        title: 'API',
        blurb: 'b',
        releases: [],
        banner: {
          prod: { version: 'v1', untagged: false, date: '2026-08-13T00:00:00Z', reachable: false },
          dev: null,
        },
      },
    ],
  })
  assert.ok(html.includes('status unknown'), 'a failed probe is surfaced, not hidden')
  assert.ok(/dot-unknown/.test(html), 'and carries the amber dot')
})

test('C1: toPublicSection strips probeUrl/probeUrlEnv before the section reaches render.mjs or releases.json', () => {
  const repo = {
    name: 'uki-tutor-service',
    title: 'API',
    blurb: 'Go backend',
    probeUrl: 'https://uki-tutor-api-prod-sgwblipyaa-uc.a.run.app/health',
    probeUrlEnv: 'UKI_TUTOR_SERVICE_PROBE_URL',
  }
  const section = toPublicSection(repo, [], null)

  assert.ok(!('probeUrl' in section), 'probeUrl key must not survive into the published section')
  assert.ok(!('probeUrlEnv' in section), 'probeUrlEnv key must not survive into the published section')
  assert.equal(section.title, 'API', 'unrelated public fields must still pass through')

  // This is what build.mjs actually writes to site/releases.json.
  const published = JSON.stringify({ owner: OWNER, sections: [section], generatedAt: '2026-08-13T00:00:00Z' })
  assertNoForbiddenPatterns(published)
  assert.ok(!published.includes('probeUrl'), 'probeUrl/probeUrlEnv keys must not appear in the published JSON at all')
  assert.ok(!published.includes('sgwblipyaa'), 'the Cloud Run URL that was in probeUrl must not leak into releases.json')
})

test('C1: gatherReleases never republishes probeUrl/probeUrlEnv (network stubbed — guards the real wiring, not just the helper)', async () => {
  // toPublicSection is correct in isolation but gatherReleases has to
  // actually call it; this exercises the real call site with global fetch
  // stubbed, so a future revert to `{ ...repo, releases, banner }` would be
  // caught here even if toPublicSection itself were untouched.
  const originalFetch = global.fetch
  const hadToken = 'GH_TOKEN' in process.env
  const priorToken = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'

  const jsonResponse = body => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) })

  global.fetch = async url => {
    const u = String(url)
    if (u.includes('/releases?')) return jsonResponse([])
    if (u.includes('/deployments?')) return jsonResponse([])
    if (u === 'https://internal.example.invalid/probe') return { ok: true }
    throw new Error(`unexpected fetch in test: ${u}`)
  }

  try {
    const data = await gatherReleases({
      owner: OWNER,
      maxReleasesPerRepo: 1,
      repos: [
        {
          name: 'uki-tutor-service',
          title: 'API',
          blurb: 'Go backend',
          probeUrl: 'https://internal.example.invalid/probe',
          probeUrlEnv: 'SOME_ENV_VAR',
        },
      ],
    })
    const published = JSON.stringify(data)
    assert.ok(!published.includes('probeUrl'), 'probeUrl must not survive gatherReleases into the published data')
    assert.ok(!published.includes('internal.example.invalid'), 'the probe URL value must not leak either')
  } finally {
    global.fetch = originalFetch
    if (hadToken) process.env.GH_TOKEN = priorToken
    else delete process.env.GH_TOKEN
  }
})

test('C1: repos.json on disk contains no internal hostname and no https:// URL other than uki-tutor.com', () => {
  // This is the gate that converts the probeUrlEnv indirection from a
  // convention into something enforced: it fails if anyone commits an
  // internal address (a Cloud Run/Cloudflare hostname, a raw IP-shaped
  // secret URL, anything) directly into repos.json instead of naming an env
  // var. uki-tutor.com is the one allowed exception — it is the product's
  // public marketing domain, safe to publish because it already is public.
  const reposJsonPath = new URL('../repos.json', import.meta.url)
  const reposJsonText = readFileSync(reposJsonPath, 'utf8')

  const reposJsonPatterns = {
    ...forbiddenPatterns,
    'an https:// URL other than uki-tutor.com': /https:\/\/(?!uki-tutor\.com\/?["\s])\S*/i,
  }
  assertNoForbiddenPatterns(reposJsonText, reposJsonPatterns)
})
