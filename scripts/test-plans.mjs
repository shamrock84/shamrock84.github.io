// Unit tests for api/plans.js's pure parts — the validation that is the only
// guard on what reaches the plan store, and the merge whose direction is what
// stops a second device from wiping the first device's plans.
//
// Run: node scripts/test-plans.mjs

import { validatePlans, mergePlans, emptyDocument, resolveStore } from '../api/plans.js';

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
eq('both kinds merge independently',
  mergePlans(
    { contractPlans: { 30641: { 1: '1' } }, salaryPlans: { 30641: { 9: '50' } } },
    { salaryPlans: { 30641: { 8: '25' } } },
  ),
  { contractPlans: { 30641: { 1: '1' } }, salaryPlans: { 30641: { 8: '25', 9: '50' } }, updatedAt: null });
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
