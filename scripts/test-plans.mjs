// Unit tests for api/plans.js's pure parts — the validation that is the only
// guard on what reaches the plan store, and the merge whose direction is what
// stops a second device from wiping the first device's plans.
//
// Run: node scripts/test-plans.mjs

import { validatePlans, mergePlans, emptyDocument, resolveStore, validateTasks, mergeTasks } from '../api/plans.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
}

console.log('validatePlans');
eq('accepts a well-formed document', validatePlans({
  contractPlans: { 30641: { 16148: '2' } },
  salaryPlans: { 30641: { 16148: '25' } },
  cutPlans: { 30641: { 16148: '1' } },
}), []);
eq('accepts an empty object', validatePlans({}), []);
eq('accepts numbers (older browsers wrote them)', validatePlans({
  contractPlans: { 30641: { 16148: 2 } },
}), []);
check('rejects a non-object', validatePlans(null).length === 1);
check('rejects an array', validatePlans([]).length === 1);
check('rejects a non-object plan kind', validatePlans({ contractPlans: 'nope' }).length === 1);
check('rejects a non-object league', validatePlans({ contractPlans: { 30641: 5 } }).length === 1);
check('rejects an object value', validatePlans({
  contractPlans: { 30641: { 16148: { years: 2 } } },
}).length === 1);
check('rejects an over-long value', validatePlans({
  contractPlans: { 30641: { 16148: '123456789' } },
}).length === 1);
check('rejects too many leagues', validatePlans({
  contractPlans: Object.fromEntries([...Array(201)].map((_, i) => [i, { 1: '2' }])),
}).length === 1);
check('rejects too many entries in one league', validatePlans({
  contractPlans: { 30641: Object.fromEntries([...Array(401)].map((_, i) => [i, '2'])) },
}).length === 1);
check('ignores unknown top-level keys', validatePlans({ somethingElse: 5 }).length === 0);

check('rejects a non-object cutPlans kind', validatePlans({ cutPlans: 'nope' }).length === 1);
check('accepts a well-formed resultOverrides document',
  validatePlans({ resultOverrides: { 30641: { 2024: '2' } } }).length === 0);
check('rejects a non-object resultOverrides kind', validatePlans({ resultOverrides: 'nope' }).length === 1);

check('accepts a well-formed watchlist document',
  validatePlans({ watchlist: { 30641: { 16148: '1' } } }).length === 0);
check('rejects a non-object watchlist kind', validatePlans({ watchlist: 'nope' }).length === 1);

console.log('validateTasks');
eq('accepts a well-formed task', validateTasks({
  t1: { text: 'Set lineups', category: 'Weekly', done: false, createdAt: 1000, completedAt: null },
}), []);
eq('accepts a task with no category or completedAt', validateTasks({
  t1: { text: 'Set lineups', done: true, createdAt: 1000 },
}), []);
eq('accepts a task with an order', validateTasks({
  t1: { text: 'Set lineups', done: false, createdAt: 1000, order: 0 },
}), []);
eq('undefined is accepted (nothing to validate)', validateTasks(undefined), []);
check('rejects a non-object', validateTasks('nope').length === 1);
check('rejects an array', validateTasks([]).length === 1);
check('rejects a non-object task', validateTasks({ t1: 'nope' }).length === 1);
check('rejects an empty text', validateTasks({ t1: { text: '', done: false, createdAt: 1 } }).length === 1);
check('rejects an over-long text', validateTasks({ t1: { text: 'x'.repeat(201), done: false, createdAt: 1 } }).length === 1);
check('rejects an over-long category', validateTasks({ t1: { text: 'x', category: 'x'.repeat(41), done: false, createdAt: 1 } }).length === 1);
check('rejects a non-boolean done', validateTasks({ t1: { text: 'x', done: 'yes', createdAt: 1 } }).length === 1);
check('rejects a non-number createdAt', validateTasks({ t1: { text: 'x', done: false, createdAt: 'now' } }).length === 1);
check('rejects a non-number, non-null completedAt', validateTasks({ t1: { text: 'x', done: false, createdAt: 1, completedAt: 'now' } }).length === 1);
check('rejects a non-number order', validateTasks({ t1: { text: 'x', done: false, createdAt: 1, order: 'first' } }).length === 1);
check('rejects too many tasks', validateTasks(Object.fromEntries(
  [...Array(301)].map((_, i) => [i, { text: 'x', done: false, createdAt: 1 }]),
)).length === 1);

console.log('mergeTasks');
// Key order is Set-iteration order, not meaningful here (unlike
// leagueId/playerId keys elsewhere in this file, task ids are never
// integer-like, so JS won't auto-sort them the way the "unions across
// leagues" case below relies on) — checked per-id rather than as one
// whole-object eq so the assertion doesn't depend on it either.
const unionResult = mergeTasks({ t1: { text: 'a', category: '', done: false, createdAt: 1, completedAt: null } }, { t2: { text: 'b', category: '', done: false, createdAt: 2, completedAt: null } });
eq('unions tasks present on only one side — t1 survives, order backfilled from createdAt', unionResult.t1, { text: 'a', category: '', done: false, order: 1, createdAt: 1, completedAt: null });
eq('unions tasks present on only one side — t2 survives, order backfilled from createdAt', unionResult.t2, { text: 'b', category: '', done: false, order: 2, createdAt: 2, completedAt: null });
eq('stored wins a real id collision',
  mergeTasks(
    { t1: { text: 'stored version', category: '', done: true, createdAt: 1, completedAt: 5 } },
    { t1: { text: 'incoming version', category: '', done: false, createdAt: 1, completedAt: null } },
  ),
  { t1: { text: 'stored version', category: '', done: true, order: 1, createdAt: 1, completedAt: 5 } });
eq('a real order value is carried through rather than backfilled',
  mergeTasks({}, { t1: { text: 'a', category: '', done: false, order: 5, createdAt: 1, completedAt: null } }),
  { t1: { text: 'a', category: '', done: false, order: 5, createdAt: 1, completedAt: null } });
eq('a deleted task (absent from incoming, merging against empty stored) stays gone',
  mergeTasks({}, { t1: null }),
  {});
eq('an empty incoming document never erases a stored task',
  mergeTasks({ t1: { text: 'a', category: '', done: false, createdAt: 1, completedAt: null } }, {}),
  { t1: { text: 'a', category: '', done: false, order: 1, createdAt: 1, completedAt: null } });

console.log('emptyDocument');
eq('carries every plan kind plus tasks', emptyDocument(), { contractPlans: {}, salaryPlans: {}, cutPlans: {}, resultOverrides: {}, watchlist: {}, tasks: {}, updatedAt: null });

console.log('mergePlans');
// The case this endpoint exists for: a phone that has never synced posts an
// empty document, and the iPad's plans must survive it.
eq('an empty incoming document never erases stored plans',
  mergePlans({ contractPlans: { 30641: { 16148: '2' } }, salaryPlans: {} }, emptyDocument()).contractPlans,
  { 30641: { 16148: '2' } });
eq('an empty stored document takes the incoming plans',
  mergePlans(emptyDocument(), { contractPlans: { 30641: { 16148: '2' } } }).contractPlans,
  { 30641: { 16148: '2' } });
eq('unions across leagues',
  mergePlans(
    { contractPlans: { 30641: { 1: '1' } } },
    { contractPlans: { 34850: { 2: '2' } } },
  ).contractPlans,
  { 30641: { 1: '1' }, 34850: { 2: '2' } });
eq('unions within one league',
  mergePlans(
    { contractPlans: { 30641: { 1: '1' } } },
    { contractPlans: { 30641: { 2: '2' } } },
  ).contractPlans,
  { 30641: { 1: '1', 2: '2' } });
eq('stored wins a conflict — it synced more recently than an unpushed local',
  mergePlans(
    { contractPlans: { 30641: { 1: '3' } } },
    { contractPlans: { 30641: { 1: '1' } } },
  ).contractPlans,
  { 30641: { 1: '3' } });
eq('all five PLAN_KINDS merge independently',
  mergePlans(
    { contractPlans: { 30641: { 1: '1' } }, salaryPlans: { 30641: { 9: '50' } }, cutPlans: { 30641: { 2: '1' } }, resultOverrides: { 30641: { 2024: '3' } }, watchlist: { 30641: { 3: '1' } } },
    { salaryPlans: { 30641: { 8: '25' } } },
  ),
  { contractPlans: { 30641: { 1: '1' } }, salaryPlans: { 30641: { 8: '25', 9: '50' } }, cutPlans: { 30641: { 2: '1' } }, resultOverrides: { 30641: { 2024: '3' } }, watchlist: { 30641: { 3: '1' } }, tasks: {}, updatedAt: null });
const mergedTasks = mergePlans(
  { tasks: { t1: { text: 'a', category: '', done: false, createdAt: 1, completedAt: null } } },
  { tasks: { t2: { text: 'b', category: '', done: false, createdAt: 2, completedAt: null } } },
).tasks;
eq('mergePlans merges tasks alongside the PLAN_KINDS loop — t1 survives', mergedTasks.t1, { text: 'a', category: '', done: false, order: 1, createdAt: 1, completedAt: null });
eq('mergePlans merges tasks alongside the PLAN_KINDS loop — t2 survives', mergedTasks.t2, { text: 'b', category: '', done: false, order: 2, createdAt: 2, completedAt: null });
eq('numbers are normalised to strings',
  mergePlans(emptyDocument(), { contractPlans: { 30641: { 1: 2 } } }).contractPlans,
  { 30641: { 1: '2' } });
eq('empty values are dropped rather than stored as blanks',
  mergePlans(emptyDocument(), { contractPlans: { 30641: { 1: '', 2: '2' } } }).contractPlans,
  { 30641: { 2: '2' } });
eq('a league left with no entries is pruned',
  mergePlans(emptyDocument(), { contractPlans: { 30641: { 1: '' } } }).contractPlans,
  {});
// Replace mode is merge against an empty document, so deletions propagate —
// this is what lets a cleared plan actually go away.
eq('replace (merge against empty) drops a key the store still has',
  mergePlans(emptyDocument(), { contractPlans: { 30641: { 2: '2' } } }).contractPlans,
  { 30641: { 2: '2' } });
eq('merge does not mutate its inputs', (() => {
  const stored = { contractPlans: { 30641: { 1: '1' } }, salaryPlans: {} };
  mergePlans(stored, { contractPlans: { 30641: { 2: '2' } } });
  return stored.contractPlans;
})(), { 30641: { 1: '1' } });

console.log('resolveStore');
eq('takes the KV_* pair', resolveStore({ KV_REST_API_URL: 'https://a', KV_REST_API_TOKEN: 't' }),
  { url: 'https://a', token: 't' });
eq('takes the UPSTASH_* pair', resolveStore({ UPSTASH_REDIS_REST_URL: 'https://b', UPSTASH_REDIS_REST_TOKEN: 'u' }),
  { url: 'https://b', token: 'u' });
eq('prefers KV_* when a project carries both',
  resolveStore({ KV_REST_API_URL: 'https://a', KV_REST_API_TOKEN: 't', UPSTASH_REDIS_REST_URL: 'https://b', UPSTASH_REDIS_REST_TOKEN: 'u' }),
  { url: 'https://a', token: 't' });
eq('strips a trailing slash so the built path has exactly one',
  resolveStore({ KV_REST_API_URL: 'https://a/', KV_REST_API_TOKEN: 't' }), { url: 'https://a', token: 't' });
check('returns null when nothing is set', resolveStore({}) === null);
check('a half-configured pair counts as absent', resolveStore({ KV_REST_API_URL: 'https://a' }) === null);
check('falls through a half KV_* pair to a complete UPSTASH_* one',
  resolveStore({ KV_REST_API_URL: 'https://a', UPSTASH_REDIS_REST_URL: 'https://b', UPSTASH_REDIS_REST_TOKEN: 'u' })?.token === 'u');

console.log(failures === 0 ? '\nAll plan tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
