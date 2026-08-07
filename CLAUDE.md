# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal static site (`melbostads.com`) whose only real application is **`myffl.html`** — a fantasy football dashboard aggregating ~18 leagues across MyFantasyLeague (MFL), ESPN, and Sleeper. Every other page is a stub, an iframe wrapper around a Google Sheet, or a redirect. `myffl_v1.html` is the retired predecessor, kept for reference.

There is **no build step, no test framework, no linter, and no dependencies**. `package.json` exists only to set `"type": "module"` for the `.mjs`/`.js` files under `scripts/` and `api/`. Do not add `npm test`/`npm run build` scripts expecting them to be wired to anything.

## Two deployment targets, one repository

This is the single most important thing to understand before changing anything:

| Path | Deploys to | Serving |
| --- | --- | --- |
| `*.html`, `data/`, images | GitHub Pages | `melbostads.com` (see `CNAME`) |
| `api/*.js` | Vercel | `shamrock84-github-io.vercel.app` |

`myffl.html` is served from Pages but calls Vercel by **absolute URL** (constants near the top of its script block). That cross-origin hop is why every file in `api/` carries an identical `ALLOWED_ORIGINS` allowlist — add a new endpoint and you must copy that CORS preamble, or the browser blocks it.

Consequences that bite:

- **Secrets exist in two independent places.** GitHub Actions secrets power the scheduled sync; Vercel project environment variables power the API functions. They are not shared. Adding a credential means setting it in both, or deciding which half needs it.
- **`vercel.json`'s `ignoreCommand` skips the Vercel build** unless the commit touched `api/`, `scripts/lib/providers.mjs`, or `config/leagues.json`. If you make `api/` import a *new* shared module (say `scripts/lib/fantasypros.mjs`, which today only the sync uses), you **must** add that path to `ignoreCommand` or Vercel will silently skip deploys that need to ship.

## Two data paths, deliberately separate

**Slow path — snapshot, committed to the repo.** `sync-mfl-rosters.yml` runs every 4 hours (and on demand), executes `scripts/fetch-rosters.mjs`, and commits the result to `data/rosters.json`. This carries rosters, standings, scoring, and lineups. `myffl.html` fetches that file directly with a cache-buster.

**Fast path — live, never written down.** `api/live-scoring.js` is polled roughly every 30s while the Scoring tab is open. It only answers requests; it writes nothing. It keeps a module-level cache (MFL cookie ~20 min, franchise names ~1 hour) that survives warm invocations and resets on cold start.

Both paths import the same fetch logic from **`scripts/lib/providers.mjs`** (~37k, the largest source file here). `fetch-rosters.mjs` is orchestration only — provider quirks belong in `providers.mjs`.

`api/trigger-sync.js` bridges the two: the page's "Last synced" link dispatches the sync workflow via a repo-scoped PAT, behind a 2-minute cooldown so the button can't be used to hammer MFL/ESPN.

## `config/leagues.json` is the control plane

Adding, removing, or reclassifying a league is a config edit, never a code edit. The file's own `_readme` array is the authoritative schema — **read it before touching anything league-shaped, and update it when you change the schema.** It documents `provider`, `type`/`format`, `lineupPilot`, `tags`, `rankingType`, `scoring`, and the non-obvious rules behind them (for instance: salary-cap leagues intentionally use DRAFT rankings rather than DYNASTY). Array order is display order across every tab.

Three providers are supported: `mfl` (the default when `provider` is omitted), `espn`, and `sleeper`. Provider selection is a three-way ternary repeated at each stage of `fetch-rosters.mjs` (roster, standings, scoring, lineup), so adding a fourth means updating `providers.mjs` *and* each of those call sites.

## Invariants worth preserving

- **The sync degrades, it never fails.** `fetch-rosters.mjs` wraps every league in try/catch and falls back to the previous `data/rosters.json` entry (`previousById`), recording an `error` field the page renders. One dead league must never blank out the other seventeen. FantasyPros rankings are layered on last and are likewise never allowed to fail the run — with no `FANTASYPROS_API_KEY` the ECR column simply goes blank.
- **`submit-lineup.js` uses an allowlist, not a denylist.** It accepts a league only if `lineupPilot` is set *and* the provider is MFL or unset. Sleeper leagues can carry `lineupPilot: true` (their starters render read-only, since Sleeper's public API has no write endpoint). The in-file comment explains the reasoning: a future read-only provider must fail closed by default. Do not invert this.
- **Both test workflows are `workflow_dispatch`-only, deliberately.** `test-set-lineup.yml` exercises a write against a real MFL team; `test-login-endpoint.yml` probes the deployed login endpoint. Never add a `schedule` trigger to either.
- **Auth is stateless and password-free after login.** `SITE_PASSWORD` gates `api/login.js`, which returns an HMAC-signed 30-day token (`api/lib/auth.mjs`) that the client replays as a Bearer token on writes. There is no database and no session store. MFL credentials live only on the server and are never sent to the browser.

## Verifying changes

Network egress from a cloud sandbox is restricted: **`myfantasyleague.com` and `api.sleeper.app` are unreachable here, though `api.github.com` is.** You therefore cannot run `node scripts/fetch-rosters.mjs` end-to-end locally, which is exactly why the manual workflows exist. Verify against real providers by dispatching `test-set-lineup.yml` or `test-login-endpoint.yml` from GitHub Actions, or by triggering `sync-mfl-rosters.yml`.

What *does* work locally:

```bash
node --check scripts/fetch-rosters.mjs        # syntax
python3 -m http.server 8000                   # then open /myffl.html
```

Serve over HTTP rather than opening the file directly — `myffl.html` fetches `data/rosters.json` with a relative URL, which fails under `file://`. The committed `data/rosters.json` is real synced data, so the page renders fully offline; pure rendering changes can be checked this way without any provider access.

## Front-end conventions

`myffl.html` is a single ~2000-line file: vanilla JS, no framework, no bundler, styles and markup and logic all inline. Rendering is a set of `renderCard` / `renderStandingsCard` / `renderScoringCard` / `renderAnalyticsCard` functions driven by a tab and sub-tab system built from the league list at runtime. Match the existing idiom rather than introducing a framework or a build step — the no-toolchain property is what lets GitHub Pages serve this directly.
