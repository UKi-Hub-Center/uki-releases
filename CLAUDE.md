# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A ~350-line static-site generator that publishes the UKi-Tutor platform's public
release-notes page to GitHub Pages (https://uki-hub-center.github.io/uki-releases/).
It contains **no product source code**. Everything it publishes is read at build
time from the GitHub Releases of three private product repos named in `repos.json`.

It exists as its own repository because GitHub Pages cannot publish from a private
repo on the org's Free plan, and every product repo is private. **This is the one
repository in the organisation that anyone can read** — that constraint drives most
of the decisions below.

## Commands

```bash
# Full build (needs a fine-grained PAT with Contents: Read-only and
# Deployments: Read on repos.json's repos — Deployments: Read powers the
# "now live" banners; without it the build still succeeds, banners just
# degrade to omitted, see computeServiceBanner in fetch.mjs)
GH_TOKEN=github_pat_... UKI_TUTOR_SERVICE_PROBE_URL=https://... node scripts/build.mjs && open site/index.html

# Tests — no token needed, run in CI before anything is deployed
node --test 'scripts/*.test.mjs'
node --test scripts/redaction.test.mjs      # a single file
```

Node 22+. There is **deliberately no `package.json`, no dependencies, and no
lockfile** — a dependency here would be a supply-chain surface on a public repo.
Do not add one, and do not reach for a test framework, bundler, or CSS library;
use `node:test` and inline everything.

## Architecture

`build.mjs` → `fetch.mjs` (all network I/O) → `render.mjs` (pure) → `site/`.

- **`repos.json`** — an explicit allowlist, not an org scan, so a newly created
  private repo can never appear on the page by accident.
- **`fetch.mjs`** — the only module that touches the network. Calls the GitHub REST
  API via global `fetch` (not `gh`), so a laptop and a runner behave identically
  given the same `GH_TOKEN`. Applies the redaction rules, then POSTs the cleaned
  markdown to GitHub's `/markdown` endpoint, which renders *and sanitises* it —
  that is why nothing downstream has to trust release bodies.
- **`render.mjs`** — data in, one HTML string out. No network, no filesystem, so it
  is testable without a token.
- **`site/`** — build output, gitignored and regenerated on every publish. Never
  commit it; the workflow uploads it as a Pages artifact.

### Invariants the tests enforce

These are the parts that fail *silently and publicly* — the page still builds and
still looks correct while being wrong. `redaction.test.mjs` guards them; keep it
passing and extend it alongside any change here.

1. **No links into the private repos.** `stripPrivateLinks` demotes release-please's
   commit/PR links and compare footer to plain text, because those URLs 404 for every
   visitor. The org name is part of the match — a different org sharing a repo name
   must not be stripped.
2. **`mode: 'markdown'`, never `'gfm'`** in `renderMarkdown` — gfm autolinks bare
   `#123` references into the private source repo.
3. **The page stays self-contained.** No `<script>` or `<link>` tags, styles inlined.
   Relative asset URLs break under the `/uki-releases/` path prefix, and the page's
   whole point is that it is boring and always loads.
4. **The `generatedAt` stamp is load-bearing**, not decoration: if the read PAT
   expires, Pages keeps serving the last good build and that line is the only signal.

## Publishing and redaction

`.github/workflows/publish.yml` triggers on `repository_dispatch`
(`release-published`, fired by each product repo after release-please), every push to
`main`, nightly at 06:00 UTC as a backstop, and manually. The dispatch ping is
best-effort by design — a failed dispatch must never turn a completed release red in
the repo that produced it. `client_payload` is deliberately never read: what gets
published is decided by `repos.json` here, not by whoever fired the event.

Release notes come from commit subjects, so **assume anything written in a `feat:` or
`fix:` subject will be read by a customer.** To retract:

- whole release — add `<!-- uki-releases:hide -->` to its GitHub release body
- one line — append `[skip-public]` to that bullet

Security fixes need particular care: the web app self-updates but the iOS and Android
builds do not, so a note describing a vulnerability may describe a live one in binaries
users are still running. Give those a neutral subject, or hide the release until the
mobile build has shipped.

Secrets:

- `UKI_RELEASES_READ_PAT` (this repo, fine-grained, **Contents: Read-only and
  Deployments: Read** on the repos in `repos.json`). A 404 from the API on a
  private repo nearly always means the PAT does not cover it or its grant was
  not approved — `fetch.mjs` says so in the error, since the API will not.
  Deployments: Read is what powers the "now live" banners (Phase A); if this
  token is ever rotated without that scope, every banner silently disappears
  — `computeServiceBanner` degrades to `null` and logs why, but nothing turns
  red, so check the Actions log after a rotation.
- `UKI_TUTOR_SERVICE_PROBE_URL` (this repo) — the API's health-check URL,
  read via `repos.json`'s `probeUrlEnv` indirection rather than being a value
  in `repos.json` itself. This repo is public and its git history is
  permanent; a Cloud Run hostname committed directly would stay readable
  forever even after a later commit removed it. It is not a credential (the
  endpoint is publicly invocable), but it is an internal address the page
  itself must never print, so `repos.json` names the *variable* and the
  value arrives only at build time from this secret.
- There is deliberately no `UKI_ADMIN_SERVICE_PROBE_URL`. The admin service's
  `repos.json` entry has no `probeUrl`/`probeUrlEnv` at all — its banner
  shows a version with no status dot, by decision: a public liveness signal
  for an internal payouts panel serves no reader of this page. Don't add the
  scaffolding back to "fix" the missing dot.
