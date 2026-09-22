// One-off write CLI, the counterpart to the read-only scripts/fetch-tasks.mjs
// — marks a fixed list of Tasks-card items done after the code implementing
// them has been merged. Not meant to be a general "mark any task done" tool:
// TARGETS below is edited per use, matched by exact (category, text) so a
// near-miss (a task edited slightly since it was read) is silently skipped
// rather than marking the wrong one.
//
// Requires SITE_PASSWORD in the environment, same as fetch-tasks.mjs.
//
// Unlike fetch-tasks.mjs this WRITES to the shared store, and has to use
// api/plans.js's `mode: 'replace'` to do it: `mode: 'merge'` (the default)
// has `stored` win on any key already present (see mergeTasks in
// api/plans.js), which would silently no-op an update to an EXISTING task's
// `done` field — merge can only ever add tasks the store has never seen, not
// change one it has. `replace` mode replaces the whole plans document, not
// just tasks, so this fetches the current document first and round-trips it
// unchanged except for the matched tasks' `done`/`completedAt` — every other
// plan kind (contractPlans/salaryPlans/cutPlans/resultOverrides) and every
// other task passes through exactly as read.
//
// Usage:
//   SITE_PASSWORD=... node scripts/mark-tasks-done.mjs

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

const TARGETS = [
	{
		category: 'Site Enhancement',
		text: 'Add a collapse all link to each tab that will collapse all cards. Also an expand all that expands all cards.',
	},
	{
		category: 'Site Enhancement',
		text: 'Append team’s record to the quick link at the top. Share a screenshot before merging this one. Worried about space.',
	},
	{
		category: 'Site Enhancement',
		text: 'On scores tab under show details and show bench each player name should link to their FP profile.',
	},
];

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
	const token = loginBody.token;

	const getRes = await fetch(`${API_BASE}/api/plans`, { headers: { Authorization: `Bearer ${token}` } });
	const getBody = await getRes.json();
	if (!getRes.ok) {
		console.error(`Fetching plans failed (${getRes.status}): ${getBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}
	const plans = getBody.plans;

	const now = Date.now();
	let matched = 0;
	let alreadyDone = 0;
	for (const task of Object.values(plans.tasks || {})) {
		const hit = TARGETS.some((t) => t.category === (task.category || '') && t.text === task.text);
		if (!hit) continue;
		if (task.done) {
			alreadyDone++;
			console.log(`Already done: [${task.category}] ${task.text}`);
			continue;
		}
		task.done = true;
		task.completedAt = now;
		matched++;
		console.log(`Marking done: [${task.category}] ${task.text}`);
	}

	const unmatched = TARGETS.length - matched - alreadyDone;
	if (unmatched > 0) {
		console.log(`${unmatched} target(s) not found on the card (text may have changed) — left untouched.`);
	}

	if (matched === 0) {
		console.log('Nothing to write.');
		return;
	}

	const postRes = await fetch(`${API_BASE}/api/plans`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ plans, mode: 'replace' }),
	});
	const postBody = await postRes.json();
	if (!postRes.ok) {
		console.error(`Saving plans failed (${postRes.status}): ${postBody.error || 'unknown error'}`);
		if (postBody.details) console.error(postBody.details.join('\n'));
		process.exitCode = 1;
		return;
	}
	console.log(`Marked ${matched} task(s) done.`);
}

main();
