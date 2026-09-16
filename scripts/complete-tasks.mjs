// Write counterpart to fetch-tasks.mjs: marks one or more Tasks-card entries
// done in the shared store (api/plans.js -> Upstash), by exact task text,
// instead of asking the manager to open the page and click each one after
// Claude finishes the work they describe.
//
// Requires SITE_PASSWORD in the environment, same as fetch-tasks.mjs and for
// the same reason — there is no way to read or write the store without it.
//
// Read-modify-write, not a partial PATCH: api/plans.js's mode:'replace' posts
// the ENTIRE tasks object as the new truth (see mergePlans/mergeTasks there
// — mode:'merge' would have the *stored* copy win over this write for every
// task id that already exists, which is the opposite of what an update
// needs). So this fetches the full current document first and only flips
// `done`/`completedAt` on the matching entries, then pushes everything back
// — sending anything less would delete every other task in the store.
//
// Matching is by exact, case-sensitive task text because that's the only
// stable handle this script has (ids are opaque and not shown by
// fetch-tasks.mjs's output) — a task already marked done, or no exact match
// found, is reported rather than silently skipped, so a typo'd title doesn't
// look like a no-op success.
//
// Usage:
//   SITE_PASSWORD=... node scripts/complete-tasks.mjs "Exact task text" ["Another task"...]

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

async function main() {
	const password = process.env.SITE_PASSWORD;
	if (!password) {
		console.error('SITE_PASSWORD is not set in the environment.');
		process.exitCode = 1;
		return;
	}

	const targets = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
	if (targets.length === 0) {
		console.error('Usage: node scripts/complete-tasks.mjs "Exact task text" ["Another task"...]');
		process.exitCode = 1;
		return;
	}

	const loginRes = await fetch(`${API_BASE}/api/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	const loginBody = await loginRes.json();
	if (!loginRes.ok) {
		console.error(`Login failed (${loginRes.status}): ${loginBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}
	const auth = { Authorization: `Bearer ${loginBody.token}` };

	const getRes = await fetch(`${API_BASE}/api/plans`, { headers: auth });
	const getBody = await getRes.json();
	if (!getRes.ok) {
		console.error(`Fetching plans failed (${getRes.status}): ${getBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}

	const plans = getBody.plans || {};
	const tasks = plans.tasks || {};
	const remaining = new Set(targets);
	let changed = 0;

	for (const [id, t] of Object.entries(tasks)) {
		if (!remaining.has(t.text)) continue;
		remaining.delete(t.text);
		if (t.done) {
			console.log(`Already done: ${t.text}`);
			continue;
		}
		tasks[id] = { ...t, done: true, completedAt: Date.now() };
		changed++;
		console.log(`Marking done: ${t.text}`);
	}

	for (const missed of remaining) {
		console.error(`No exact match found for: ${missed}`);
	}

	if (changed === 0) {
		console.log('Nothing to save.');
		process.exitCode = remaining.size > 0 ? 1 : 0;
		return;
	}

	// mode: 'replace' — see the header comment on why this must be the full
	// document, not just the changed entries.
	const postRes = await fetch(`${API_BASE}/api/plans`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/json' },
		body: JSON.stringify({ plans: { ...plans, tasks }, mode: 'replace' }),
	});
	const postBody = await postRes.json();
	if (!postRes.ok) {
		console.error(`Saving plans failed (${postRes.status}): ${postBody.error || 'unknown error'}`);
		if (postBody.details) console.error(postBody.details.join('\n'));
		process.exitCode = 1;
		return;
	}

	console.log(`Saved. ${changed} task(s) marked done.`);
	process.exitCode = remaining.size > 0 ? 1 : 0;
}

main();
