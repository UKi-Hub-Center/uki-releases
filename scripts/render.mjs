// Pure rendering: data in, one self-contained HTML string out. No network, no
// filesystem — so it can be reasoned about and tested without a token.
//
// Everything is inlined. A published Artifact-style page under a /uki-releases/
// path prefix breaks on relative asset URLs, and an external stylesheet would
// be a third-party request on a page whose whole point is that it is boring and
// always loads.

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

function formatDate(iso) {
  if (!iso) return 'unknown date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown date'
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function formatStamp(iso) {
  return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa;
  --surface: #ffffff;
  --border: #e4e4e1;
  --text: #1c1c1a;
  --muted: #6b6b66;
  --accent: #1f6f5c;
  --tag-bg: #e9f2ef;
  --status-ok: #2f9e63;
  --status-unknown: #c8932d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1210;
    --surface: #171b19;
    --border: #2a302d;
    --text: #e8eae8;
    --muted: #9aa19d;
    --accent: #6ee7c9;
    --tag-bg: #1d2b27;
    --status-ok: #4fd68b;
    --status-unknown: #e0ac4c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
header.top { border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; margin-bottom: 2.5rem; }
header.top h1 { margin: 0 0 .35rem; font-size: 1.6rem; letter-spacing: -0.02em; }
header.top p { margin: 0; color: var(--muted); font-size: .92rem; }
section.repo { margin-bottom: 3.5rem; }
section.repo > h2 { font-size: 1.15rem; margin: 0 0 .2rem; }
section.repo > .blurb { margin: 0 0 1.5rem; color: var(--muted); font-size: .9rem; }
article.release {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: .7rem;
  padding: 1.1rem 1.3rem;
  margin-bottom: 1rem;
}
article.release > h3 { margin: 0; font-size: 1rem; display: flex; align-items: baseline; gap: .7rem; flex-wrap: wrap; }
.tag {
  font: 600 .8rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--tag-bg);
  color: var(--accent);
  padding: .3rem .5rem;
  border-radius: .3rem;
}
.when { color: var(--muted); font-size: .85rem; font-weight: 400; }
.notes { font-size: .94rem; }
.notes h2, .notes h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 1.2rem 0 .4rem; }
.notes ul { margin: .3rem 0; padding-left: 1.2rem; }
.notes li { margin: .2rem 0; }
.notes a { color: var(--accent); }
.notes code { font-size: .85em; background: var(--tag-bg); padding: .1rem .3rem; border-radius: .25rem; }
.notes pre { overflow-x: auto; }
.empty { color: var(--muted); font-style: italic; font-size: .92rem; }
.banner {
  border: 1px solid var(--border);
  border-radius: .7rem;
  padding: .75rem 1rem;
  margin-bottom: 1rem;
  background: var(--tag-bg);
  font-size: .88rem;
}
.banner p { margin: 0; }
.banner p + p { margin-top: .3rem; }
.banner .dot {
  display: inline-block;
  width: .55rem;
  height: .55rem;
  border-radius: 50%;
  margin-right: .3rem;
  background: var(--status-unknown);
}
.banner .dot-ok { background: var(--status-ok); }
.banner .banner-dev { color: var(--muted); }
.banner a { color: var(--accent); }
footer { border-top: 1px solid var(--border); padding-top: 1.25rem; color: var(--muted); font-size: .82rem; }
`

function renderRelease(release) {
  return `      <article class="release">
        <h3><span class="tag">${escapeHtml(release.tag)}</span>
          <time class="when" datetime="${escapeHtml(release.publishedAt)}">${escapeHtml(formatDate(release.publishedAt))}</time>
        </h3>
        <div class="notes">${release.html}</div>
      </article>`
}

/**
 * The "now live" banner. `section.banner` is the shape produced by
 * fetch.mjs's buildBanner — it carries only a resolved version, a date, and
 * a reachable boolean, never a sha or any deployment URL. Whether a URL may
 * be shown at all is decided upstream, in repos.json/computeServiceBanner
 * (only the SPA entry sets `publicUrl`) — this function never has an
 * internal URL available to render even by mistake, and it makes that
 * decision by presence of `publicUrl`, not by section identity.
 */
function renderBanner(banner) {
  if (!banner || !banner.prod) return ''

  const { prod, dev, publicUrl } = banner
  // `reachable === null` means the service was never probed — it carries no
  // status on this page at all, so it gets no dot and no status text rather
  // than an amber "unknown" that would imply something is wrong.
  const probed = prod.reachable !== null && prod.reachable !== undefined
  const dotClass = prod.reachable ? 'dot-ok' : 'dot-unknown'
  const statusText = prod.reachable ? 'operational' : 'status unknown'
  const prodLabel = prod.untagged
    ? `latest release <strong>${escapeHtml(prod.version)}</strong> (a newer build is live)`
    : `<strong>${escapeHtml(prod.version)}</strong>`
  const urlSuffix = publicUrl
    ? ` — <a href="https://${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a>`
    : ''
  const devLine = dev
    ? `\n      <p class="banner-dev">next up: <strong>${escapeHtml(dev.version)}</strong> on dev since ${escapeHtml(formatDate(dev.date))}</p>`
    : ''

  const dot = probed ? `<span class="dot ${dotClass}" aria-hidden="true"></span>` : ''
  const status = probed ? ` &middot; ${statusText}` : ''

  return `    <div class="banner">
      <p class="banner-prod">${dot}${prodLabel} live in production since ${escapeHtml(formatDate(prod.date))}${status}${urlSuffix}</p>${devLine}
    </div>
`
}

function renderSection(section) {
  const bannerHtml = renderBanner(section.banner)
  const body = section.releases.length
    ? section.releases.map(renderRelease).join('\n')
    : '      <p class="empty">No releases published yet.</p>'
  return `    <section class="repo">
      <h2>${escapeHtml(section.title)}</h2>
      <p class="blurb">${escapeHtml(section.blurb)}</p>
${bannerHtml}${body}
    </section>`
}

export function renderPage(data) {
  // The timestamp is load-bearing, not decoration: if the token that reads the
  // private repos expires, this page keeps serving its last good build and this
  // line is the only thing that says so.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>UKi-Tutor releases</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <h1>UKi-Tutor releases</h1>
      <p>What has shipped across the platform. Updated ${escapeHtml(formatStamp(data.generatedAt))}.</p>
    </header>
${data.sections.map(renderSection).join('\n')}
    <footer>
      Generated from the GitHub Releases of each service. Versions follow
      <a href="https://semver.org/">Semantic Versioning</a> and are cut from
      <a href="https://www.conventionalcommits.org/">Conventional Commits</a>.
    </footer>
  </div>
</body>
</html>
`
}
