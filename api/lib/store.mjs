// The Upstash REST calls shared by the endpoints that remember what they
// already sent (game-time-check.js, weekly-results.js). Plain fetch, no client
// library — see resolveStore in api/plans.js for the credential naming.

export async function storeGet(store, key) {
  const res = await fetch(`${store.url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${store.token}` } });
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
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]),
  });
  if (!res.ok) throw new Error(`Store write failed (${res.status})`);
}
