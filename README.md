# uki-releases

Publishes the public release-notes page for the UKi-Tutor platform:
**https://uki-hub-center.github.io/uki-releases/**

**This repository contains no product source code.** It holds a small
generator and one workflow. Everything it publishes is read at build time from
the GitHub Releases of the product repositories.

## Why it exists as its own repository

The product repositories are private, and GitHub Pages cannot publish from a
private repository on this organisation's plan — *"If the account that owns the
repository uses GitHub Free or GitHub Free for organizations, the repository
must be public."* Rather than making a product repository public, the page is
built here, from a repository whose entire contents are the thing being served.

## How it works

1. `repos.json` names the repositories to include. It is an explicit allowlist,
   not an org-wide scan, so a new private repository can never appear here by
   being created.
2. `scripts/fetch.mjs` reads each repository's most recent releases, discards
   drafts and prereleases, applies the redaction rules below, and asks GitHub's
   own `/markdown` endpoint to render the notes (which also sanitises them).
3. `scripts/render.mjs` turns that data into a single self-contained
   `site/index.html`.
4. `.github/workflows/publish.yml` deploys `site/` to GitHub Pages.

It runs when a product repository reports a new release (`repository_dispatch`),
on every push here, nightly as a backstop, and on demand.

## Keeping something off the page

The notes come from commit subjects, so assume anything you write in a `feat:`
or `fix:` subject will be read by a customer. To retract something:

- **A whole release** — edit its GitHub release body and add
  `<!-- uki-releases:hide -->` anywhere in it.
- **A single line** — append `[skip-public]` to that bullet.

Security fixes deserve particular care. The web app updates itself, but the
iOS and Android builds do not, so a released note describing a vulnerability
can describe a live one in binaries users are still running. Give those a
neutral subject, or hide the release until the mobile build has shipped.

## Running it locally

Requires Node 22+ and a fine-grained PAT with **Contents: Read-only** on the
repositories in `repos.json`.

```bash
GH_TOKEN=github_pat_... node scripts/build.mjs
open site/index.html
```

The redaction rules have tests, which need no token and run in the publish
workflow before anything is deployed:

```bash
node --test 'scripts/*.test.mjs'
```

There are no dependencies to install, and there is deliberately no
`package.json`: this is the one repository in the organisation that anyone can
read, so it carries no supply-chain surface.

## Secrets

| Name | Where | Scope |
|---|---|---|
| `UKI_RELEASES_READ_PAT` | this repo | fine-grained, Contents: Read-only on the repos in `repos.json` |

The product repositories hold a separate, narrower token that can only fire the
`repository_dispatch` event at this repository.
