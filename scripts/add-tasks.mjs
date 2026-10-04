// Add counterpart to fetch-tasks.mjs and mark-tasks-done.mjs: appends new
// Tasks-card entries to the shared store (api/plans.js -> Upstash), so Claude
// can file follow-up work for the manager without anyone opening the page.
//
// Requires SITE_PASSWORD in the environment, same as the other task scripts.
//
// Uses mode:'merge' — unlike mark-tasks-done.mjs, which needs 'replace' to
// UPDATE tasks the store already holds. A merge is a union where the stored
// copy wins any id collision (mergeTasks in api/plans.js), and every id sent
// here is brand new, so this can only ever ADD: it cannot overwrite, reorder
// or delete an existing task, and it sends no other plan kind at all, so
// contract/salary/cut plans are untouched by construction.
//
// Idempotent by text: a task whose exact text already exists (any category,
// open or done) is skipped and reported, so re-running a workflow can't file
// duplicates.
//
// Usage:
//   SITE_PASSWORD=... TASK_CATEGORY="Site Enhancement" TASK_TEXTS=$'First task\nSecond task' \
//     node scripts/add-tasks.mjs
// TASK_TEXTS is newline-separated, one task per line. TASK_CATEGORY defaults
// to "Site Enhancement".

const API_BASE = process.env.MYFFL_API_BASE || 'https://shamrock84-github-io.vercel.app';
const DEFAULT_CATEGORY = 'Site Enhancement';

// Same shape the page's makeTaskId produces, so a task added here is
// indistinguishable from one added on the Tasks card.
function makeTaskId(now) {
	return `t${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Pure: which of `texts` are new against the stored `tasks`, as the entries
// to send. `order` follows each other so they land at the bottom of the
// category in the order given (the page sorts open tasks by order).
export function planNewTasks(tasks, texts, category, now) {
	const existing = new Set(Object.values(tasks || {}).map((t) => t && t.text));
	const added = {};
	const skipped = [];
	let i = 0;
	for (const raw of texts) {
		const text = raw.trim();
		if (!text) continue;
		if (existing.has(text)) {
			skipped.push(text);
			continue;
		}
		existing.add(text);
		const stamp = now + i++;
		added[makeTaskId(stamp)] = { text, category, done: false, order: stamp, createdAt: stamp, completedAt: null };
	}
	return { added, skipped };
}

async function main() {
	const password = process.env.SITE_PASSWORD;
	if (!password) {
		console.error('SITE_PASSWORD is not set in the environment.');
		process.exitCode = 1;
		return;
	}
	const category = (process.env.TASK_CATEGORY || DEFAULT_CATEGORY).trim();
	const texts = (process.env.TASK_TEXTS || '').split('\n');
	if (!texts.some((t) => t.trim())) {
		console.error('TASK_TEXTS is empty — pass the task text, one task per line.');
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

	const { added, skipped } = planNewTasks(getBody.plans?.tasks, texts, category, Date.now());
	for (const text of skipped) console.log(`Already exists, skipped: ${text}`);
	const count = Object.keys(added).length;
	if (count === 0) {
		console.log('Nothing to add.');
		return;
	}

	const postRes = await fetch(`${API_BASE}/api/plans`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/json' },
		body: JSON.stringify({ plans: { tasks: added }, mode: 'merge' }),
	});
	const postBody = await postRes.json();
	if (!postRes.ok) {
		console.error(`Saving failed (${postRes.status}): ${postBody.error || 'unknown error'}`);
		if (postBody.details) console.error(postBody.details.join('\n'));
		process.exitCode = 1;
		return;
	}
	for (const t of Object.values(added)) console.log(`Added [${category}]: ${t.text}`);
	console.log(`Saved. ${count} task(s) added.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
