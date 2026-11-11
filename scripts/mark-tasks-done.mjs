// Write CLI, the counterpart to the read-only scripts/fetch-tasks.mjs — marks
// one or more Tasks-card items done once the code implementing them has
// merged. Matched by exact `text` (case-sensitive, whitespace included) —
// there is no id to pass from the command line, so an exact-text collision
// between two tasks marks both; that is a real but narrow risk worth taking
// over inventing a second lookup key nothing else on the page uses.
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
// other task passes through exactly as read. If nothing matches, nothing is
// posted — the store is a read-only pass-through in that case.
//
// Usage:
//   SITE_PASSWORD=... node scripts/mark-tasks-done.mjs "Exact task text" ["Another exact task text" ...]
//   SITE_PASSWORD=... TASK_TEXTS=$'Exact task text\nAnother exact task text' node scripts/mark-tasks-done.mjs
//
// TASK_TEXTS (newline-separated) takes precedence over argv when set — it's
// what mark-tasks-done.yml passes a multiline workflow_dispatch input
// through as, sidestepping shell quoting entirely for task text that
// contains an apostrophe or other shell-special character.

// VIKINGS_TASKS=1 targets the vikings.html Admin tab's own list instead
// (api/vikings.js ?resource=tasks); BANGERS_TASKS=1 the bangers.html one
// (api/bangers.js, same shape). That store takes per-task patches, so
// only the matched tasks are posted — no whole-document replace needed.
const BANGERS = process.env.BANGERS_TASKS === '1';
const VIKINGS = BANGERS || process.env.VIKINGS_TASKS === '1';
// The two small pages keep their own task lists behind their own endpoints.
const OWN_API = BANGERS ? 'bangers' : 'vikings';

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';

async function main() {
	const password = process.env.SITE_PASSWORD;
	if (!password) {
		console.error('SITE_PASSWORD is not set in the environment.');
		process.exitCode = 1;
		return;
	}

	const targets = (process.env.TASK_TEXTS
		? process.env.TASK_TEXTS.split('\n')
		: process.argv.slice(2)
	).map((s) => s.trim()).filter(Boolean);
	if (targets.length === 0) {
		console.error('Usage: node scripts/mark-tasks-done.mjs "Exact task text" ["Another exact task text" ...]');
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

	const getRes = await fetch(`${API_BASE}/api/${VIKINGS ? `${OWN_API}?resource=tasks` : 'plans'}`, { headers: { Authorization: `Bearer ${token}` } });
	const getBody = await getRes.json();
	if (!getRes.ok) {
		console.error(`Fetching plans failed (${getRes.status}): ${getBody.error || 'unknown error'}`);
		process.exitCode = 1;
		return;
	}
	const plans = VIKINGS ? { tasks: getBody.tasks || {} } : getBody.plans;
	const changed = {};

	const now = Date.now();
	const remaining = new Set(targets);
	let matched = 0;
	for (const [id, task] of Object.entries(plans.tasks || {})) {
		if (!remaining.has(task.text)) continue;
		remaining.delete(task.text);
		if (task.done) {
			console.log(`Already done: [${task.category || '(no category)'}] ${task.text}`);
			continue;
		}
		task.done = true;
		task.completedAt = now;
		matched++;
		changed[id] = task;
		console.log(`Marking done: [${task.category || '(no category)'}] ${task.text}`);
	}
	for (const text of remaining) {
		console.log(`Not found on the card, left untouched: ${text}`);
	}

	if (matched === 0) {
		console.log('Nothing to write.');
		return;
	}

	const postRes = await fetch(`${API_BASE}/api/${VIKINGS ? OWN_API : 'plans'}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(VIKINGS ? { resource: 'tasks', tasks: changed } : { plans, mode: 'replace' }),
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
