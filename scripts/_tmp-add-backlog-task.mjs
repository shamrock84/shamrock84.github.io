// One-off, temporary script — adds a single Backlog task to the shared
// plans store, then this file and its workflow are deleted in the same PR.
// Not meant to stick around: unlike fetch-tasks.mjs (a real, reusable read
// tool CLAUDE.md documents), there's no ongoing need to write tasks from a
// script — tasks are normally added through the page's own UI.
//
// Safety: posts in `mode: 'merge'` only, which api/plans.js documents as a
// pure union that "can't destroy anything" — the new task's id is a fresh
// makeTaskId()-shaped id (timestamp + random suffix), so there is no
// collision risk with any existing task, and every other plan kind is
// omitted from the payload entirely (mergePlans treats an omitted kind as
// empty, which unions to a no-op against whatever's already stored).
//
// Requires SITE_PASSWORD in the environment, same as fetch-tasks.mjs.

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

const TASK_TEXT =
	"Scoring tab: ESPN/Sleeper flip to the new week (showing 0-0, nobody's played) as soon as the prior week is fully scored, while MFL holds the completed week until its own games start. Considered holding ESPN/Sleeper on the prior week too until their new week's games actually start; declined for now. Full reasoning (unproven whether ESPN's API can even answer for a past scoring period once it rolls, a freshness-vs-staleness tradeoff, and a cold-start risk that would make a naive cache silently unreliable) is in CLAUDE.md and providers.mjs's fetchEspnScoring/fetchSleeperScoring comments.";

function makeTaskId() {
	return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

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

	const now = Date.now();
	const id = makeTaskId();
	const task = { text: TASK_TEXT, category: 'Backlog', done: false, order: now, createdAt: now, completedAt: null };

	const postRes = await fetch(`${API_BASE}/api/plans`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ plans: { tasks: { [id]: task } }, mode: 'merge' }),
	});
	const postBody = await postRes.json();
	if (!postRes.ok) {
		console.error(`Adding task failed (${postRes.status}): ${postBody.error || 'unknown error'}`);
		if (postBody.details) console.error(postBody.details.join('\n'));
		process.exitCode = 1;
		return;
	}

	const stored = postBody.plans?.tasks?.[id];
	if (!stored) {
		console.error('Push succeeded but the new task id is not present in the response — something is wrong.');
		process.exitCode = 1;
		return;
	}
	console.log(`Added task ${id} (category: ${stored.category}):`);
	console.log(stored.text);
	console.log(`\nTotal tasks in store now: ${Object.keys(postBody.plans.tasks).length}`);
}

main();
