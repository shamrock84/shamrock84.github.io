// Write CLI — renames a Tasks-card category on every task that carries it,
// open and completed alike. One-off in spirit (it was written to turn "Bugs"
// into "Bug"), but takes the names as arguments so it is reusable.
//
// Requires SITE_PASSWORD in the environment, same as mark-tasks-done.mjs, and
// uses the same two write paths for the same reasons (see that script's
// header): myFFL's plans document needs `mode: 'replace'` because a merge lets
// the stored copy win, so this re-fetches the whole document and round-trips
// it unchanged except for the renamed tasks' `category`. The Vikings store
// takes per-task patches, so only the matched tasks are posted. Matching is
// exact and case-sensitive. If nothing matches, nothing is posted.
//
// Usage:
//   SITE_PASSWORD=... node scripts/rename-task-category.mjs "Bugs" "Bug"
//   SITE_PASSWORD=... FROM_CATEGORY=Bugs TO_CATEGORY=Bug node scripts/rename-task-category.mjs
//   VIKINGS_TASKS=1 ...   # the vikings.html Admin tab's own list instead

const VIKINGS = process.env.VIKINGS_TASKS === '1';
const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

// Pure, so the rename rule can be tested without a network: returns the
// changed tasks keyed by id, leaving the input untouched.
export function renameCategory(tasks, from, to) {
	const changed = {};
	for (const [id, task] of Object.entries(tasks || {})) {
		if (task && task.category === from) changed[id] = { ...task, category: to };
	}
	return changed;
}

async function main() {
	const password = process.env.SITE_PASSWORD;
	if (!password) {
		console.error('SITE_PASSWORD is not set in the environment.');
		process.exitCode = 1;
		return;
	}
	const from = (process.env.FROM_CATEGORY || process.argv[2] || '').trim();
	const to = (process.env.TO_CATEGORY || process.argv[3] || '').trim();
	if (!from || !to || from === to) {
		console.error('Usage: node scripts/rename-task-category.mjs "Old category" "New category"');
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

	const getRes = await fetch(`${API_BASE}/api/${VIKINGS ? 'vikings?resource=tasks' : 'plans'}`, { headers: { Authorization: `Bearer ${token}` } });
	const getBody = await getRes.json();
	if (!getRes.ok) {
		console.error(`Fetching tasks failed (${getRes.status}): ${getBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}
	const plans = VIKINGS ? { tasks: getBody.tasks || {} } : getBody.plans;
	const changed = renameCategory(plans.tasks, from, to);
	const ids = Object.keys(changed);
	if (ids.length === 0) {
		console.log(`No tasks in "${from}". Nothing to write.`);
		return;
	}
	for (const id of ids) {
		console.log(`Renaming (${changed[id].done ? 'done' : 'open'}): ${changed[id].text}`);
		plans.tasks[id] = changed[id];
	}

	const postRes = await fetch(`${API_BASE}/api/${VIKINGS ? 'vikings' : 'plans'}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(VIKINGS ? { resource: 'tasks', tasks: changed } : { plans, mode: 'replace' }),
	});
	const postBody = await postRes.json();
	if (!postRes.ok) {
		console.error(`Saving failed (${postRes.status}): ${postBody.error || 'unknown error'}`);
		if (postBody.details) console.error(postBody.details.join('\n'));
		process.exitCode = 1;
		return;
	}
	console.log(`Renamed ${ids.length} task(s) from "${from}" to "${to}".`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
