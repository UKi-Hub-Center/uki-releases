#!/usr/bin/env node
// Builds site/ from the release notes of the repos named in repos.json.
//
// Run locally with a read-scoped PAT to preview exactly what gets published:
//   GH_TOKEN=github_pat_... node scripts/build.mjs && open site/index.html
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gatherReleases } from './fetch.mjs'
import { renderPage } from './render.mjs'

const OUT = 'site'

const config = JSON.parse(readFileSync('repos.json', 'utf8'))
console.log(`Fetching releases for ${config.repos.length} repo(s) in ${config.owner}…`)

const data = await gatherReleases(config)

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(`${OUT}/index.html`, renderPage(data))
// Published alongside the page so the data is consumable without scraping it.
writeFileSync(`${OUT}/releases.json`, JSON.stringify(data, null, 2))

const total = data.sections.reduce((n, s) => n + s.releases.length, 0)
console.log(`Wrote ${OUT}/index.html — ${total} release(s) across ${data.sections.length} section(s).`)
