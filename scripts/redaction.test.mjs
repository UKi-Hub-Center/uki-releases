// node --test scripts/
//
// Covers the redaction rules only. They are the part of this project that can
// fail silently and publicly: if stripPrivateLinks stops matching, the page
// still builds and still looks correct, it just fills with links that 404 for
// every visitor. Uses node:test so this stays dependency-free.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripPrivateLinks } from './fetch.mjs'
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
