# MFL Developer Program docs

Two PDFs sit in this directory. Everything else in `mfl/` is static art
(logos, banners, PSDs — see `.vercelignore`'s own note on this folder);
these two are different: MyFantasyLeague's own developer documentation,
provided by the league manager on 2026-09-12 while investigating whether
the Scoring tab's Stat Breakdown popover (see `CLAUDE.md`, "A starter's
score is a button opening a stat breakdown...") could be extended to MFL
leagues.

- `MFL Developers Program - General Info.pdf` — program rules, Terms of
  Service, request URL format, auth (login API / cookies / APIKEY), and
  rate-limiting guidance.
- `MFL Developers Program - Request Details.pdf` — the full request
  reference: every `TYPE=...` export call, its description, and its
  arguments.

## The load-bearing fact: raw NFL stats are contractually forbidden

General Info, "General Rules and Terms of Service," item 7 (verbatim):

> We can not and will not under any circumstance make raw NFL player
> stats available, as that's forbidden per our stats licensing
> agreement.

This is *why* `updatedStats` on `TYPE=liveScoring` always reads as an
empty string (confirmed against 8 real scored players, week 1 2026 —
`probe-live-scoring-players.mjs` RUN 2) and why `TYPE=weeklyResults`
carries no stat detail at all (RUN 3). It was never a matter of finding
the right call: no MFL endpoint will ever hand back something like "74
receiving yards" for anyone, registered client or not. **Read this
before spending another probe run chasing a raw-stat source on MFL** —
the absence is policy, not a gap in this project's code.

**RUN 4 checked the one thing that might still have gotten around that
wall — and it doesn't.** A PER-RULE POINT total would be MFL's own
derived number, not the licensed raw stat, so item 7 wouldn't obviously
cover it. `TYPE=playerScores` takes a `RULES=1` argument —
"re-calculates the fantasy score for each player according to that
league's rules" — a call this project had never tried before. Against
real week-1 2026 data (league 26696), its entries carry only
`{id, isAvailable, score, week}` — a single recalculated total, same
shape as `weeklyResults`' score from a different call, **no per-rule
breakdown of any kind**. That was the last plausible candidate in the
Request Reference. `liveScoring` (`updatedStats`), `weeklyResults`, and
`playerScores&RULES=1` have now all been checked and every one of them
carries nothing between "the final score" and the raw stat item 7
forbids outright.

**Conclusion: MFL's own API cannot support the Scoring tab's
stat-breakdown popover through any documented, triable endpoint.** This
isn't "not yet found" — it's the platform's own contractual limit,
confirmed from two directions (their stated policy, and exhausting the
endpoints that could plausibly have carried something short of it). If
MFL's terms or API surface ever change, this file is where to start —
but **don't re-probe MFL for this again** on the strength of a new idea
alone; the wall above is categorical, not a matter of trying harder.

## What shipped instead: ESPN's public boxscore, not MFL's API

The manager asked whether ESPN's own stats — reachable regardless of
which platform a given league actually runs on — could stand in for the
raw stat MFL refuses to expose. They can, and this project built it:
`mflStatBreakdownFromBoxscore` in `providers.mjs` joins ESPN's PUBLIC
site API (`fetchEspnBoxscore`, `GET .../summary?event=<id>` — the same
unauthenticated host `fetchNflGames` already reads for game clocks,
**never** their fantasy API) against this league's own MFL scoring
rules (`fetchMflSkillPositionRates`, decoded via the `TYPE=allRules`
labels confirmed above). This is a genuinely different data source than
MFL's own — the ToS restriction above has nothing to say about it.

Confirmed via RUN 5/6 of the same probe: `boxscore.players[]` carries a
real per-athlete stat line (`passing`/`rushing`/`receiving`/`defensive`/
`kicking`/... categories, each with parallel `keys` and per-athlete
`stats` arrays) by the athlete's real name, for any NFL game. RUN 7
confirmed the exact `allRules` wording for the codes this join uses
(`RY`="Rushing Yards", `#R`="Number of Rushing TDs", `CY`="Receiving
Yards", `#C`="Number of Receiving TDs", `CC`="Receptions" — `PY`/`#P`/
`IN` were already confirmed by RUN 4).

Scope and known gaps, all deliberate:
- **Skill-position offense only** (passing/rushing/receiving yards,
  TDs, INTs thrown) — same boundary the ESPN/Sleeper breakdowns already
  draw, for the same reason: kicking needs FG-distance buckets this
  project has no confident source for, and team defense is a
  team-scoped stat that would need a different join entirely (by team,
  not by player name).
- **Joined by normalized player name**, since MFL and ESPN share no
  player-id space — the same class of join `fetchProjections`' `byName`
  already uses for ESPN/Sleeper against FantasyPros.
- **Not reconciled against the real MFL score.** RUN 5 itself surfaced
  a real ESPN-side discrepancy — one player's individual passing-yards
  line (178) disagreed with his own team's total row (168) by 10 yards
  in the same response. An independently-computed breakdown is not
  guaranteed to sum to the score a manager sees above it even when
  every rate is right. This project chose to ship without a
  reconciliation check rather than hold the feature on one; revisit if
  a visibly-wrong sum turns out to be common in practice.
- **One new global request shape per poll**: every NFL game still `'in'`
  progress or already `'post'` gets fetched (not per MFL league — one
  merged index shared across all of them, since MFL rosters any NFL
  team). `api/live-scoring.js` caches a game's boxscore permanently once
  captured as `'post'` — it will never change again — and only refetches
  ones still live, the same live-vs-static split `nflClocks` already
  draws.

Pinned by `test-mfl-boxscore-breakdown.mjs`.

## Other things confirmed from the Request Reference (RUN 4)

- `TYPE=allRules` — the authoritative event-code → description mapping
  for `TYPE=rules`'s abbreviations. Confirmed real and rich: e.g.
  `PY` = "Passing Yards", `#P` = "Number of Passing TDs", `IN` = "Pass
  Interceptions Thrown", `TSK` = "QB Sacked", each with a one-line
  `shortDescription` and a full `detailedDescription`. This upgrades
  `fetchMflReceptionPoints`'s own "CC is the reception event" comment
  from behavior-inferred to documented — useful for describing a
  league's *scoring rules* in the abstract (e.g. a hypothetical "what do
  these abbreviations mean" reference), but it says nothing about what
  any player actually did in any given week, so it can't feed a
  per-player breakdown either. Full response captured in
  `probe-live-scoring-players.mjs`'s own RUN 4 job log if the shape is
  needed again.
- `TYPE=liveScoring` takes a `DETAILS=1` argument that returns
  non-starters too. `mflLiveStarters` currently filters to starters only
  regardless of what's in the response.
- `TYPE=playerScores` (without `RULES`) — "All player scores for a given
  league/week, including all rostered players as well as all free
  agents." Given RUN 4's finding on the `RULES=1` variant's shape, this
  is presumably the same `{id, score, ...}` shape without the
  rule-recalculation — not independently probed, since there was no
  remaining reason to expect a richer one.
- `TYPE=projectedScores` — projects a player's expected fantasy points
  from FantasySharks' raw-stat projections, recalculated under a given
  league's own rules. Not the same thing as an in-week actual breakdown
  (and likely subject to the same shape as playerScores, unconfirmed),
  but a candidate if MFL's own projection numbers are ever wanted
  instead of FantasyPros'.
- The API has been rate-limited per-IP since 2020; unregistered clients
  get a lower ceiling (documented as roughly 2.5x lower than a
  registered client), and 429 is the throttle signal. This is consistent
  with — but predates and was independently reverse-engineered from
  production 429s ahead of — `providers.mjs`'s own MFL pacing rules
  (`setMflRequestInterval`/`paceMflRequest`); nothing here changes those.
