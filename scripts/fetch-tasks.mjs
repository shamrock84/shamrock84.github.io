// Read-only CLI: pulls the Tasks card's data straight out of the shared
// store (api/plans.js -> Upstash) instead of the user retyping or
// copy-pasting task text into a chat by hand. Never posts back, so it can't
// collide with a save made from the page — it hits the same GET the page
// itself makes on every load.
//
// Requires SITE_PASSWORD in the environment (the same password api/login.js
// checks) — there is no way to read the store without it, by design (see
// api/plans.js's own comment on why plans are never in the repo). Point at a
// non-default deployment with MYFFL_API_BASE if one is ever needed.
//
// Deliberately does not filter by category — this script only fetches, and
// which categories are worth acting on is a judgment call made by whoever
// reads the output (see CLAUDE.md's note on this script for the current
// standing rule), not something to bake into a read tool that might get
// reused for other categories later. Pass a category on the command line to
// filter this one run.
//
// Usage:
//   SITE_PASSWORD=... node scripts/fetch-tasks.mjs
//   SITE_PASSWORD=... node scripts/fetch-tasks.mjs "Bugs"

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

async function main() {
	const password = process.env.SITE_PASSWORD;
	if (!password) {
		console.error('SITE_PASSWORD is not set in the environment.');
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

	const plansRes = await fetch(`${API_BASE}/api/plans`, {
		headers: { Authorization: `Bearer ${loginBody.token}` },
	});
	const plansBody = await plansRes.json();
	if (!plansRes.ok) {
		console.error(`Fetching plans failed (${plansRes.status}): ${plansBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}

	const tasks = plansBody.plans?.tasks || {};
	const categoryFilter = process.argv[2] ? process.argv[2].trim().toLowerCase() : null;
	const entries = Object.entries(tasks).filter(
		([, t]) => !categoryFilter || (t.category || '').trim().toLowerCase() === categoryFilter,
	);
	// order falls back to createdAt the same way taskOrderValue does in
	// myffl.html, for a task written before priority ordering existed.
	entries.sort((a, b) => (a[1].order ?? a[1].createdAt ?? 0) - (b[1].order ?? b[1].createdAt ?? 0));

	if (entries.length === 0) {
		console.log(categoryFilter ? `No tasks in category "${process.argv[2]}".` : 'No tasks.');
		return;
	}

	for (const [id, t] of entries) {
		const status = t.done ? 'done' : 'open';
		const category = t.category ? ` (${t.category})` : '';
		console.log(`[${status}]${category} ${t.text}`);
	}
}

main();
