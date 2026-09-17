// Deletes stale claude/ branches so they don't pile up forever. Every
// branch this project's automation creates — the weekly Tasks Card Sweep,
// or any other Claude session working a task — is prefixed `claude/` (see
// CLAUDE.md's branch-naming convention), so that prefix is the entire
// scope: main and anything named differently is never touched.
//
// A branch is deleted only if BOTH hold: its latest commit is more than
// BRANCH_MAX_AGE_DAYS old, and it has no open pull request. An open PR
// protects a branch regardless of age — this only clears out branches
// whose PR merged or closed without GitHub's auto-delete enabled, and
// genuinely abandoned ones that never got a PR at all.
//
// Talks to the GitHub REST API directly with fetch (no git operations,
// no dependencies), matching this project's no-dependency rule and
// api/trigger-sync.js's existing style for calling that API.
//
// Usage (as run by cleanup-branches.yml):
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/cleanup-branches.mjs [--dry-run]

const BRANCH_PREFIX = 'claude/';
const BRANCH_MAX_AGE_DAYS = 2;
const API_BASE = 'https://api.github.com';

function ghHeaders(token) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	};
}

async function ghJson(url, token) {
	const res = await fetch(url, { headers: ghHeaders(token) });
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
	}
	return res.json();
}

async function listBranches(repo, token) {
	const branches = [];
	for (let page = 1; ; page++) {
		const batch = await ghJson(`${API_BASE}/repos/${repo}/branches?per_page=100&page=${page}`, token);
		branches.push(...batch);
		if (batch.length < 100) break;
	}
	return branches;
}

async function hasOpenPr(repo, branchName, token) {
	const [owner] = repo.split('/');
	const prs = await ghJson(`${API_BASE}/repos/${repo}/pulls?state=open&head=${owner}:${branchName}&per_page=1`, token);
	return prs.length > 0;
}

async function main() {
	const token = process.env.GITHUB_TOKEN;
	const repo = process.env.GITHUB_REPOSITORY;
	const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

	if (!token || !repo) {
		console.error('GITHUB_TOKEN and GITHUB_REPOSITORY must be set in the environment.');
		process.exitCode = 1;
		return;
	}

	const cutoff = Date.now() - BRANCH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
	const branches = await listBranches(repo, token);
	const candidates = branches.filter((b) => b.name.startsWith(BRANCH_PREFIX));

	let deleted = 0;
	let kept = 0;

	for (const branch of candidates) {
		const commit = await ghJson(`${API_BASE}/repos/${repo}/commits/${branch.commit.sha}`, token);
		const committedAt = new Date(commit.commit.committer.date).getTime();
		if (committedAt > cutoff) {
			console.log(`[keep] ${branch.name} — last commit ${commit.commit.committer.date} (under ${BRANCH_MAX_AGE_DAYS}d old)`);
			kept++;
			continue;
		}

		if (await hasOpenPr(repo, branch.name, token)) {
			console.log(`[keep] ${branch.name} — has an open pull request`);
			kept++;
			continue;
		}

		if (dryRun) {
			console.log(`[would delete] ${branch.name} — last commit ${commit.commit.committer.date}, no open PR`);
			deleted++;
			continue;
		}

		const delRes = await fetch(`${API_BASE}/repos/${repo}/git/refs/heads/${branch.name}`, {
			method: 'DELETE',
			headers: ghHeaders(token),
		});
		if (!delRes.ok) {
			const body = await delRes.text();
			console.error(`[error] Failed to delete ${branch.name}: ${delRes.status} ${body.slice(0, 200)}`);
			continue;
		}
		console.log(`[deleted] ${branch.name} — last commit ${commit.commit.committer.date}, no open PR`);
		deleted++;
	}

	console.log(`\n${dryRun ? 'Would delete' : 'Deleted'} ${deleted} branch(es); kept ${kept}.`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
