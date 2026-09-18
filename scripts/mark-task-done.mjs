// Temporary, one-off CLI: flips a single Tasks-card entry to done, matched
// by an exact-substring on its text (and, unlike fetch-tasks.mjs, a required
// category, so a loose substring can't accidentally land on the wrong item).
//
// fetch-tasks.mjs is deliberately read-only ("not something to bake into a
// read tool that might get reused ... later" — see its own header). This
// script is NOT meant to become a permanent fixture alongside it: the Tasks
// card's own checkbox in myffl.html is the designed way to mark something
// done, and this exists only because the manager asked Claude to flip one
// entry from a sandbox with no browser and no network path to Vercel.
//
// Reads the whole plans document, edits exactly one task's `done` field, and
// posts the whole document back with mode: 'replace' — the same shape the
// page itself uses (fetch -> local edit -> full replace), since mergePlans'
// own merge mode has `stored` win ties, which would silently discard a
// `done: true` written over an already-stored `done: false`. Not doing this
// through a JSON.parse/patch of a file, because the document does not live
// in the repo at all — see api/plans.js's own header on why plans are kept
// out of it.
//
// Usage:
//   SITE_PASSWORD=... node scripts/mark-task-done.mjs "Bugs" "some distinctive substring of the task text"

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

async function main() {
	const password = process.env.SITE_PASSWORD;
	const category = process.argv[2];
	const matchText = process.argv[3];
	if (!password || !category || !matchText) {
		console.error('Usage: SITE_PASSWORD=... node scripts/mark-task-done.mjs "<category>" "<substring of task text>"');
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

	const getRes = await fetch(`${API_BASE}/api/plans`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const getBody = await getRes.json();
	if (!getRes.ok) {
		console.error(`Fetching plans failed (${getRes.status}): ${getBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}
	const plans = getBody.plans;
	const tasks = plans.tasks || {};

	const matches = Object.entries(tasks).filter(
		([, t]) => (t.category || '') === category && !t.done && (t.text || '').includes(matchText),
	);
	if (matches.length === 0) {
		console.error(`No open task in category "${category}" matched "${matchText}".`);
		process.exitCode = 1;
		return;
	}
	if (matches.length > 1) {
		console.error(`${matches.length} open tasks matched — narrow the substring:`);
		for (const [, t] of matches) console.error(`  - ${t.text}`);
		process.exitCode = 1;
		return;
	}

	const [id, task] = matches[0];
	console.log(`Marking done: [${category}] ${task.text}`);
	plans.tasks = { ...tasks, [id]: { ...task, done: true, completedAt: Date.now() } };

	const postRes = await fetch(`${API_BASE}/api/plans`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ mode: 'replace', plans }),
	});
	const postBody = await postRes.json();
	if (!postRes.ok) {
		console.error(`Save failed (${postRes.status}): ${postBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}
	console.log('Saved.');
}

main();
