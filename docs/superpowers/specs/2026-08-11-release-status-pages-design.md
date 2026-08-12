# Release & status pages — design

**Date:** 2026-08-11
**Status:** approved
**Repos touched:** `uki-releases` (public), `uki-tutor-infra` (private), `uki-tutor-service`, `uki-admin-service`, `uki-tutor-ui` (dispatch ping only)

## Goal

Make "what is running where, and is it healthy" visible at three levels of trust,
without leaking operational detail to the public:

- **A. Public release page** (`uki-releases` → GitHub Pages) — customers see release
  notes plus "now live" versions for prod and dev. No URLs beyond the product's own,
  no shas, no infrastructure detail.
- **B. Internal status snapshot** (`uki-tutor-infra`) — `docs/STATUS.md`
  auto-refreshed on deploys + nightly, viewable by org members on github.com, plus a
  local live HTML dashboard (`live.mjs`).
- **C. Live admin status page** (`uki-admin-service`) — `/api/admin/status` + a
  Status page in the admin panel, behind the existing Firebase + `admin_users` gate.

Reference for look/feel of the internal/admin views: the NewWave4 status page
(tabs: Overview / tests; per-env version, commit, image tag, health latency,
stable vs prerelease).

## Non-goals

- No JS, tabs, or client-side fetching on the **public** page. It stays
  self-contained, `<script>`-free, and "boring and always loads".
- No cross-repo writes: the infra repo never feeds the public repo; each repo
  builds its own output.
- No uptime history / time-series storage. Every view renders current state
  (plus GitHub's own deployment history). If we want history later, that is a
  separate design.
- No status for infrastructure not named in the static config (schedulers,
  buckets appear as console links only).

## The shared data model

One JSON shape, `status.json`, produced independently by each collector (JS in A
and B, Go in C). The shape is the contract; it is documented in
`uki-tutor-infra/scripts/status/` next to `environments.json`, which is its
static half.

```jsonc
{
  "generatedAt": "2026-08-12T02:00:00Z",
  "services": [
    {
      "id": "uki-tutor-service",          // repo name
      "title": "API",
      "kind": "cloud-run",                 // or "pages" (SPA)
      "environments": {
        "prod": {
          "url": "https://uki-tutor-api-prod-…run.app",   // internal-only for services
          "deployment": {                  // GitHub Deployments API, newest successful per env
            "sha": "c03ccba…",
            "tag": "v0.1.2",               // sha mapped to release tag; null if untagged
            "deployedAt": "2026-08-11T23:19:51Z",
            "imageTag": "c03ccba…"         // full sha = Artifact Registry tag, per deploy.yml
          },
          "health": {                      // live GET /health (or GET / for the SPA)
            "reachable": true, "httpStatus": 200, "latencyMs": 518,
            "status": "ok", "database": "ok",
            "version": "0.1.2+c03ccba",    // null until /health exposes SERVICE_VERSION
            "checkedAt": "…"
          },
          "db": { "instance": "uki-tutor-db-prod-e448", "tier": "db-f1-micro" },
          "console": "https://console.cloud.google.com/run?project=uki-tutor"
        },
        "dev": { /* same shape */ }
      },
      "ci": {                              // latest completed run per key workflow
        "deploy": { "conclusion": "success", "sha": "…", "runUrl": "…", "finishedAt": "…" },
        "tests":  { "conclusion": "success", "runUrl": "…", "finishedAt": "…" }
      },
      "releases": [ /* existing uki-releases shape: tag, name, publishedAt, html */ ]
    }
  ]
}
```

### Sources

| Source | Auth | A (public) | B (infra) | C (admin) |
|---|---|---|---|---|
| GitHub Releases | PAT Contents:R | ✅ (exists today) | ✅ | ✅ |
| GitHub Deployments | PAT Deployments:R | ✅ tag + date only | ✅ full | ✅ full |
| `/health` probes | none (URLs are publicly invocable) | prod liveness only | ✅ + latency | ✅ live |
| GitHub Actions runs | PAT Actions:R | ❌ | ✅ | ✅ |
| Static env config | file per repo | prod public URLs only | `environments.json` (full) | full |

### sha → tag mapping

Deployments record shas; releases record tags. The collector resolves each release
tag to its commit sha (one API call per tag, already-fetched releases bound the
set) and matches. A deployed sha with no tag renders internally as
"untagged build `c03ccba`"; publicly it falls back to the newest release whose
date ≤ the deployment's date, annotated "(a newer build is live)". No sha ever
reaches public output.

### The public/internal boundary

The public page may show: versions and dates for prod and dev, a green/amber
liveness dot for prod, and the product's own public URL (uki-tutor.com — SPA
section only). It never shows: shas, image tags, Cloud Run URLs, `pages.dev`
URLs, dev URLs of any kind, DB names or status, latency, or CI state. Everything
below that line exists only in B (GitHub org membership) and C (Firebase admin
gate, `admin_users` table).

## Phase B — internal generator in `uki-tutor-infra` (ships first)

Dependency-free Node 22+, mirroring `uki-releases` style. No `package.json`.

```
scripts/status/
  environments.json   # static truth: services × envs → URLs, DB instances, consoles, workflow names
  collect.mjs         # all I/O: GitHub API + health probes → status.json
  render-md.mjs       # pure: status.json → STATUS.md
  render-html.mjs     # pure: status.json → self-contained dashboard.html (light/dark)
  build.mjs           # collect → write docs/STATUS.md
  live.mjs            # collect → render-html → temp file → open; --watch re-collects every 30 s
  status.test.mjs     # node:test; renderers + sha→tag mapping against fixtures; no token
.github/workflows/status.yml
```

**STATUS.md** (at `docs/STATUS.md`, beside ENVIRONMENTS.md):

1. At-a-glance table — service × env → version, health ✅/❌, deployed-when.
2. Per-service detail — deployment (sha, image tag, actor, run link), health
   (status, database, latency), latest CI runs with links, DB instance, console links.
3. Freshness stamp (load-bearing, same rationale as the public page's).

**Workflow `status.yml`** triggers:

- `repository_dispatch: deploy-finished` — each product repo's deploy workflow
  gains a best-effort ping step (same pattern the repos already use toward
  `uki-releases`; a failed ping never fails a deploy).
- `schedule:` nightly (06:30 UTC — after the `uki-releases` nightly, so the two
  snapshots agree most mornings).
- `workflow_dispatch`.

It commits `docs/STATUS.md` only when content excluding the timestamp changed.
No 30-minute polling — refresh is deploy-driven plus the nightly backstop, so the
infra repo's history is not flooded with bot commits.

**Secrets:** one fine-grained PAT `UKI_STATUS_PAT` — Contents:R, Deployments:R,
Actions:R on `uki-tutor-ui`, `uki-tutor-service`, `uki-admin-service` — stored in
the infra repo. `live.mjs` reads the same env var locally.

## Phase A — public page in `uki-releases`

- **`fetch.mjs`** gains `fetchDeployments(repo)` (newest successful deployment
  per env; sha→tag via releases already in hand) and `probeProd(url)` (single
  GET, records reachable/unreachable only). PAT gains **Deployments: Read-only**.
- **`render.mjs`**: each service section gets a "now live" banner above its
  release cards:

  > **v0.1.2** live in production since 11 Aug 2026 · ✅ operational — *uki-tutor.com*
  > next up: **v0.2.0** on dev since 12 Aug

  Rules: the URL appears only in the SPA section; API/admin name no URLs. Dev
  line = version + date only; omitted when dev == prod. Untagged prod build →
  "latest release v0.1.2 (a newer build is live)". An untagged dev build that
  resolves to no newer tag than prod counts as dev == prod: line omitted. Probe failure → amber dot
  with "status unknown"; deployments failure → banner omitted entirely.
- **No JS, no tabs** — the self-contained/no-`<script>` invariant holds; tabs
  belong to the internal/admin views.
- **Redaction tests extend** (`redaction.test.mjs`): rendered public HTML must
  never contain `run.app`, `pages.dev`, a 7- or 40-hex-char sha, the Cloud Run
  URL infixes (`sgwblipyaa`, `q2omqw3zpa`), or DB instance names. These run in
  the publish workflow before deploy, as today.
- **Failure behavior:** any enrichment source failing degrades to today's page
  (release notes only) rather than failing the publish.

## Phase C — live admin status page

**Enabler (both Go services, may ship any time before C):** `/health` adds
`"version": SERVICE_VERSION` (env var already stamped by deploy.yml). Running
version becomes ground truth from the process, not inference from CI. Accepted
trade-off: the version string (`0.1.2+sha`) is world-readable on an already
publicly-invocable endpoint. If that sha exposure is unwanted, return only the
semver prefix.

**Backend (`uki-admin-service`):** `GET /api/admin/status`, behind the existing
Firebase-token + `admin_users` middleware. Handler concurrently:

- probes all four Cloud Run `/health` URLs + both SPA URLs (2 s timeout, one
  retry, latency recorded);
- calls GitHub (deployments, releases, latest CI runs) with a fine-grained PAT
  read from Secret Manager (new secret `uki-tutor-github-status-pat-{env}`,
  same scopes as `UKI_STATUS_PAT`);
- returns the shared `status.json` shape; in-memory cache ~60 s to respect
  GitHub rate limits with a dashboard left open.

**Frontend (admin panel):** a **Status** page — NewWave4-style. Header:
"all systems ✅ / N issues". Tabs:

- **Overview** — service × env matrix: version, health, latency, deployed-when.
- **Deployments** — per-env history: sha, tag, image tag, actor, workflow-run links.
- **CI & Tests** — latest runs per repo, pass/fail, links.

Auto-refresh every 60 s while open.

The Go collector deliberately reimplements `collect.mjs` (different language,
no shared runtime); the documented JSON shape is the contract between them.

## Security summary

| Data | Public page | STATUS.md (org members) | Admin /status (admin_users) |
|---|---|---|---|
| Versions + dates, prod & dev | ✅ | ✅ | ✅ |
| Prod product URL (uki-tutor.com) | ✅ SPA only | ✅ | ✅ |
| Cloud Run / dev URLs, shas, image tags | ❌ | ✅ | ✅ |
| Health detail, DB status, latency, DB instances | ❌ (green dot only) | ✅ | ✅ live |
| CI runs, console links | ❌ | ✅ | ✅ |

- Least-privilege PATs per repo; no PAT gains write anywhere.
- `client_payload` of every `repository_dispatch` remains unread; what gets
  built is decided by config committed in the receiving repo.
- `uki-releases` stays dependency-free and fully self-describing; nothing
  private flows into it beyond version tags and dates.

## Error handling

One rule everywhere: **a failing source degrades its section, never the build.**

- Public: banner omitted / amber dot.
- STATUS.md: "⚠️ unavailable (reason)" in the affected cell — a failed probe is
  itself signal, and the nightly run keeps the page from going stale silently.
- Admin: HTTP 200 with per-cell error states in the JSON.
- Probes: 2 s timeout, one retry, then recorded as unreachable.

## Testing

- Renderers are pure → `node:test`, tokenless, run in CI before any publish
  (existing `uki-releases` pattern, replicated in infra).
- Public-page redaction tests are the release gate for phase A (list above).
- Collector logic (sha→tag mapping, newest-successful-deployment selection)
  tested against checked-in fixture JSON.
- Go: handler tests with fake GitHub/HTTP clients; middleware test proving
  non-admins receive 403.

## Rollout

1. **B** — infra collector + STATUS.md + live.mjs. Pure tooling, zero product risk.
2. **A** — public "now live" banners + redaction tests.
3. **Enabler** — `version` in both `/health` responses.
4. **C** — admin endpoint + Status page.

Each phase is independently shippable and reversible. Dispatch pings from
product repos (for B) ride along with whichever phase first touches those repos.
