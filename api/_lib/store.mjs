// The Upstash REST calls shared by the endpoints that keep state between
// invocations: what game-time-check.js and weekly-results.js already sent,
// login.js's failed-attempt counters and trigger-sync.js's cooldown. Plain
// fetch, no client library — see resolveStore in api/plans.js for the
// credential naming.

export async function storeGet(store, key) {
  const res = await fetch(`${store.url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${store.token}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Store read failed (${res.status})`);
  const { result } = await res.json();
  return result ? JSON.parse(result) : null;
}

export async function storeSet(store, key, value, ttlSeconds) {
  // Upstash's REST API takes a raw command as a JSON array, which is the
  // simplest way to attach the expiry.
  const res = await fetch(store.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]),
  });
  if (!res.ok) throw new Error(`Store write failed (${res.status})`);
}

// Several commands in one round trip. Not a transaction — Upstash runs them in
// order but another client's command can land between them — so callers only
// pair commands where that interleaving is harmless.
async function storePipeline(store, commands) {
  const res = await fetch(`${store.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Store pipeline failed (${res.status})`);
  const results = await res.json();
  const failed = results.find((r) => r && r.error);
  if (failed) throw new Error(`Store command failed: ${failed.error}`);
  return results.map((r) => r.result);
}

// Takes `key` for ttlSeconds unless someone already holds it (SET NX), and
// reports the milliseconds left on whichever claim stands afterwards. Returns
// { claimed: true } or { claimed: false, remainingMs }. Atomic where it
// matters: two callers racing for the same key can't both get `claimed`.
export async function storeClaim(store, key, ttlSeconds) {
  const [set, pttl] = await storePipeline(store, [
    ['SET', key, '1', 'NX', 'EX', String(ttlSeconds)],
    ['PTTL', key],
  ]);
  return set === 'OK' ? { claimed: true } : { claimed: false, remainingMs: Math.max(0, Number(pttl) || 0) };
}

export async function storeRelease(store, key) {
  await storePipeline(store, [['DEL', key]]);
}

// Reads several counters at once; a missing key reads as 0.
export async function storeCounts(store, keys) {
  const results = await storePipeline(store, keys.map((k) => ['GET', k]));
  return results.map((r) => Number(r) || 0);
}

// Bumps each counter and (re)sets its expiry in one round trip. Resetting the
// expiry on every bump makes it a window that slides from the LAST increment,
// which is the right shape for a failure counter: it only drains once the
// failures stop. INCR and EXPIRE travel together so a counter can never be
// left behind with no expiry at all.
export async function storeBump(store, entries) {
  const commands = [];
  for (const { key, ttlSeconds } of entries) {
    commands.push(['INCR', key], ['EXPIRE', key, String(ttlSeconds)]);
  }
  await storePipeline(store, commands);
}
