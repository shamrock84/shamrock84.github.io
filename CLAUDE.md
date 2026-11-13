# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

**This file and `.claude/rules/*.md` are an index of rules, not the reasoning behind them.** The source is 30–47% comments, and the comment at the code is the authority. Each entry states the rule, names what to read, and says how breaking it fails silently. When you change something, update the comment at the code first; touch these files only when a *rule* changes.

**Keep it short.** This file is loaded in full every session; it holds only what every task needs (deployment, the data paths, config, how to verify). Subsystem invariants go in `.claude/rules/`, which load on demand. An entry is two to four sentences; history ("shipped wrong once", probe run narratives) belongs at the code or in the probe header. `syntax-check.yml` fails a PR that takes this file past 16,000 bytes or the rules files past 45,000 in total. Near either, compress an existing entry rather than raising the limit. The single-file version twice drifted past 90KB.

## What this repo is

A personal static site (`melbostads.com`) whose only real application is **`myffl.html`**, a fantasy football dashboard over 18 leagues on MyFantasyLeague (MFL), ESPN and Sleeper. Every other page is a stub, an iframe around a Google Sheet, or a redirect. `myffl_v1.html` is the retired predecessor.

There is **no build step, no test framework, no linter and no dependencies**. `package.json` sets `"type": "module"` and pins `engines.node` to `24.x`, which Vercel obeys over its project setting; every workflow uses Node 24 to match. Tests are plain `node scripts/test-*.mjs` files run by `syntax-check.yml`.

## Two deployment targets, one repository

| Path | Deploys to | Serving |
| --- | --- | --- |
| `*.html`, `data/`, images | GitHub Pages, via `deploy-pages.yml` | `melbostads.com` (`CNAME`) |
| `api/*.js` | Vercel | `shamrock84-github-io.vercel.app` |

`myffl.html` calls Vercel by absolute URL (constants near the top of its script), so every request is cross-origin; `api/_lib/cors.mjs` holds the allowlist.

- **Secrets live in two independent places.** GitHub Actions secrets power the sync; Vercel env vars power `api/`. Adding a credential means deciding which half needs it. Upstash credentials are Vercel-only.
- **`.vercelignore` is a storage quota, not tidiness.** Vercel stores the whole upload per deployment, and the repo is ~172MB, almost all `mfl/` and `images/`; unignored it filled the free 10GB once. `ignoreCommand` skips the build, not the upload. Anything `api/` reads by path must stay (`config/leagues.json`, `scripts/lib/`), and the `!scripts/lib/` negation must stay. Verify with `git ls-files -i -c --exclude-from=.vercelignore`. Known and accepted: the Vercel copy of `myffl.html` can't fetch `data/`.
- **Shared `api/` helpers live in `api/_lib/`; the underscore is load-bearing.** Vercel makes every other file under `api/` a function, and Hobby caps a deployment at 12. Twelve endpoints today, which is the cap: fold two together before adding one.
- **`vercel.json`'s `ignoreCommand` skips deploys** unless something changed since the last *successful* deployment (`$VERCEL_GIT_PREVIOUS_SHA`, not `HEAD^`, which missed multi-commit pushes) in `api/`, `scripts/lib/providers.mjs`, `scripts/lib/fantasypros.mjs`, `config/leagues.json`, `package.json` or `vercel.json`. Any uncertainty (no previous sha, sha outside the clone) builds. **If `api/` starts importing a new module, add it there**, or Vercel silently skips deploys that need to ship. A dashboard Redeploy of an unchanged commit is skipped too: env-var changes need a commit touching `api/`.
- **Pages is published by `deploy-pages.yml`, which strips comments from `myffl.html` at deploy** (`scripts/strip-page-comments.mjs`; ~250KB → ~75KB gzipped). Comments are cut out, never re-printed, so the shipped page is the source minus comments, proven token-for-token. The workflow re-runs the test suite on the stripped copy, so **no test may assert on `myffl.html`'s comments**. It **never blocks a publish**: a strip failure or a stripping-only test regression publishes the original page and fails the `report` job. Bot pushes don't trigger `push`, so it also chains off the sync and both backfills via `workflow_run` — a new workflow that commits to `main` must be added there.

## Two data paths, deliberately separate

**Slow path — committed snapshot.** `sync-fantasy-rosters.yml` runs `scripts/fetch-rosters.mjs` every 4 hours and commits `data/rosters.json`: rosters, standings, scoring, lineups, FantasyPros pools, free agents. The page downloads the whole file on every load (~650KB, ~100KB gzipped), which is the budget any new field spends. **All three writers go through `serializeSnapshot`** (one line per league, for readable diffs) — never `JSON.stringify(…, null, 2)`.

**Fast path — live, never written down.** `api/live-scoring.js`, polled while the Scoring tab is open; it writes nothing and keeps a module-level cache that resets on cold start.

Both import fetch logic from **`scripts/lib/providers.mjs`**; `fetch-rosters.mjs` is orchestration only. `api/trigger-sync.js` lets the page's sync button dispatch the sync, and **the 4-hourly run is a cron-job.org POST to it** (`Authorization: Bearer GAMETIME_CHECK_SECRET`, `17 */4 * * *`); the workflow has no `schedule:`, so never add one back. A cooldown hit from cron answers 200 `skipped`. **Otherwise it is login-gated** (Bearer token checked before the cooldown, button hidden when logged out) and has a **5-minute cooldown held in the Upstash store**. Keep the cooldown longer than a sync run (60–120s): the workflow queues dispatches, so a shorter gap lets syncs run back to back.

## `config/leagues.json` is the control plane

Adding, removing or reclassifying a league is a config edit, usually made in the **Admin tab** (visible when logged in), which saves through `api/save-leagues.js`. Prefer pointing the user there over hand-editing. That endpoint **commits straight to `main`**, bypassing PRs and CI, so its validation is the only guardrail; extend `test-save-leagues.mjs` with any schema change. **A save from a stale copy is refused**: the page sends the git blob sha of the bytes it loaded (`gitBlobSha`) and the server 409s on a mismatch (`isStaleBase`); a missing sha is never stale.

The file's `_readme` array is the authoritative schema — read it before touching anything league-shaped, and update it with the schema. Array order is display order everywhere.

- `mergeLeague` passes unknown fields through, or a field added later would be erased on the next Save. `RETIRED_KEYS` is how a field is removed for good (today `format`, `commishEmail`).
- `serialize` keeps one league per line so an Admin commit is a one-line diff.
- **`type: 'bestball'` was renamed `'draftonly'`.** Best Ball is a scoring system several salary-cap leagues use, and lives in `tags`. Nothing in code records this rename.
- `type: 'salarycap'` also drives the Salary/Yrs columns, the cap summary, and fetching cap adjustments.
- **Cap room charges IR at a share of salary, not zero** (`capSummaryNumbers`, `mflIrSalaryPercent`, `test-waivers.mjs`, `test-ir-salary-percent.mjs`). The share is, in order, config's `irSalaryPercent` override, MFL's own `includeIRWithSalary` (shipped as `irSalaryPercentMfl`), then 50; a real `0` means free (read with `??`, never `||`). MFL serves no cap total or room (`probe-mfl-cap-totals.mjs` RUN 1), so the page computes them. **Taxi never counts toward the cap, confirmed by the manager — don't add a taxi charge or field.** `injuredReserve`/`taxiSquad` in `TYPE=league` are slot limits, not percentages.
- Providers: `mfl` (default), `espn`, `sleeper`. Selection is a three-way ternary at each stage of `fetch-rosters.mjs`, so a fourth provider touches every stage.

## Invariants worth preserving

The invariants live in `.claude/rules/`, one file per subsystem. Claude Code loads each one automatically when a file matching its `paths:` frontmatter is read, so a session pays only for the subsystems it touches. **Test files (`scripts/test-*.mjs`) trigger none of them, and neither does a brand-new file: read the matching rule file yourself before editing those.** A new rule goes in the file for its subsystem; a new source file a rule governs gets added to that file's `paths:`.

| Rules file | Covers | Loads on |
| --- | --- | --- |
| `sync.md` | Sync degradation, MFL pacing, seasons, draft freeze, workflow checkout rules | sync scripts, `scripts/lib/`, probes, workflows |
| `rankings-power.md` | FantasyPros rankings, projections, power ranks, the four sync/page duplicates | sync scripts, `myffl.html` |
| `analytics-waivers.md` | Top Available, merged Analytics cards, exposure, Waivers tab | sync scripts, `myffl.html`, `api/waivers.js` |
| `history.md` | Brackets, placements, payouts, history backfill | sync scripts, `myffl.html`, backfill workflows |
| `page.md` | Admin tab, problems digest, Scoring drawer, Watchlist, NFL tab, cron endpoints | `myffl.html`, its `api/` endpoints |
| `auth-plans.md` | Login, plans sync, the login gate, favorites | `myffl.html`, `api/login.js`, `api/plans.js` |
| `small-apps.md` | myVST, myBangers, myFAM | their pages, endpoints and data files |

## Where the reasoning lives

| Subsystem | Read |
| --- | --- |
| Provider quirks, XML shapes, rate limits | `scripts/lib/providers.mjs` |
| Rankings, projections, power, sleepers | `scripts/lib/fantasypros.mjs` |
| Brackets, placements | `scripts/lib/history.mjs` (and `scripts/probe-league-history.mjs`) |
| Orchestration, budgets, backfills, seasons | `scripts/fetch-rosters.mjs` |
| Config schema / validation | `config/leagues.json` `_readme` / `api/save-leagues.js` |
| What a provider actually returns | the matching `scripts/probe-*.mjs` header |
| MFL's own limits and the bench-points history | `mfl/README.md` |
| Anything on screen | `myffl.html`, at the `render*` function |

## Verifying changes

**`myfantasyleague.com` and `api.sleeper.app` are unreachable from a cloud sandbox** (`api.github.com` works), so verify against real providers by dispatching a workflow (`sync-fantasy-rosters.yml`, `test-login-endpoint.yml`, a probe).

```bash
node --check scripts/fetch-rosters.mjs
for f in scripts/test-*.mjs; do node "$f"; done   # skip test-set-lineup.mjs (real MFL write)
python3 -m http.server 8000                        # open /myffl.html; file:// can't fetch data/
```

The committed snapshot is real, so the page renders offline. To see logged-in UI, set `localStorage.setItem('mflAuthToken', 'anything')` before loading. For a headless browser, Chromium is installed; add Playwright with `--no-save` and delete `node_modules` afterwards.

## Working through the Tasks card

The manager files work for Claude in the Tasks card (`renderTasksCard`).

- **Fetch it with `scripts/fetch-tasks.mjs`** (needs `SITE_PASSWORD`), or dispatch `fetch-tasks.yml` when the sandbox can't reach Vercel — don't ask the user to paste it.
- **Only act on `Bug` and `Site Enhancement`.** Other categories are the manager's own.
- **File new tasks with `scripts/add-tasks.mjs` / `add-tasks.yml`** (default category `Site Enhancement`). It posts `mode: 'merge'` with brand-new ids only, so it can add but never alter a task, and skips any exact text already present.
- **Once merged, mark done with `scripts/mark-tasks-done.mjs` / `mark-tasks-done.yml`**, matched by exact `text`. It must POST `mode: 'replace'` after re-fetching the whole document, because `merge` lets the stored copy win.

## Front-end conventions

`myffl.html` is one ~17,000-line file of vanilla JS, CSS and markup with no framework or bundler; keep it that way. The only deploy-time step is comment stripping, which changes nothing else, so the source is what runs. Cards are built by `render*Card` functions; tabs and sub-tab pills are derived at render time from the cards present (`data-league-type`), which is why logging out removes the Analytics and Admin tabs for free.

- Shared: `appendAnalyticsTable` (paginated tables), `makeTableSort`, `makePopover`, `.popover` CSS. Content stays at the call site.
- Not shared: two features sharing a visual form get separate classes (`.results-*` vs `.finances-*`).
- A clickable number that opens a popover is an idiom: `.salary-link`, `.needs-link`, `.starters-link`, `.finances-link`.
- Colour: `--accent` purple = notable; gold = taxi squad, with `--gold-chip-text` (not `--gold-text`, which vanishes in dark mode); `--ir-text` red = needs a look.
