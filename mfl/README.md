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

**Conclusion: MFL cannot support the Scoring tab's stat-breakdown
popover through any documented, triable endpoint.** This isn't "not yet
found" — it's the platform's own contractual limit, confirmed from two
directions (their stated policy, and exhausting the endpoints that
could plausibly have carried something short of it). An MFL starter's
score stays plain, unclickable text in that popover, and should stay
that way rather than prompting another round of probing against this
same API. If MFL's terms or API surface ever change, this file is where
to start.

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
