// Pins scripts/push-snapshot.sh, the sync's commit-and-push step.
//
// The failure it exists for: a PR merged to main while a sync was running, the
// sync's plain `git push` was rejected ("fetch first"), the run went red and
// that sync's data was lost. These tests use real git — a bare origin and
// shallow, blobless, sparse clones shaped like the workflow's checkout — and
// race a second writer against the sync, because a mocked git could not show
// that the recovery works on a one-commit shallow history (where a plain
// `git pull --rebase` cannot).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./push-snapshot.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'push-snapshot-'));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function identify(dir) {
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.com');
}

// A fresh origin with one commit on main, and a helper to clone it the way the
// workflow does (depth 1, blob:none, sparse to the directories the sync needs).
function makeOrigin(name) {
  const bare = join(root, `${name}.git`);
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const seed = join(root, `${name}-seed`);
  git(root, 'clone', '-q', bare, seed);
  identify(seed);
  mkdirSync(join(seed, 'data'));
  mkdirSync(join(seed, 'config'));
  mkdirSync(join(seed, 'docs'));
  writeFileSync(join(seed, 'data/rosters.json'), '{"generatedAt":"v1"}\n');
  writeFileSync(join(seed, 'config/leagues.json'), '{"leagues":["a"]}\n');
  writeFileSync(join(seed, 'docs/readme.md'), 'outside the sparse set\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  return { bare, seed };
}

function workflowClone(bare, name) {
  const dir = join(root, name);
  git(root, 'clone', '-q', '--depth=1', '--filter=blob:none', '--no-checkout', `file://${bare}`, dir);
  git(dir, 'sparse-checkout', 'set', 'data', 'config');
  git(dir, 'checkout', '-q', 'main');
  identify(dir);
  return dir;
}

const runScript = (cwd, env = {}) =>
  spawnSync('bash', [SCRIPT], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

const originFile = (bare, path) => git(bare, 'show', `main:${path}`);
const originLog = (bare) => git(bare, 'log', '--format=%s', 'main').split('\n');

try {
  // ---- nothing changed: no commit, no push --------------------------------
  {
    const { bare } = makeOrigin('nochange');
    const clone = workflowClone(bare, 'nochange-clone');
    const before = git(bare, 'rev-parse', 'main');
    const run = runScript(clone);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /No changes to commit/);
    assert.equal(git(bare, 'rev-parse', 'main'), before, 'main is untouched');
  }

  // ---- the ordinary case: first push goes through --------------------------
  {
    const { bare } = makeOrigin('plain');
    const clone = workflowClone(bare, 'plain-clone');
    writeFileSync(join(clone, 'data/rosters.json'), '{"generatedAt":"sync"}\n');
    const run = runScript(clone);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(originFile(bare, 'data/rosters.json'), '{"generatedAt":"sync"}');
    assert.deepEqual(originLog(bare), ['Update MFL rosters data', 'seed']);
  }

  // ---- main moved mid-run: the push is rejected, then re-applied -----------
  {
    const { bare, seed } = makeOrigin('race');
    const clone = workflowClone(bare, 'race-clone');

    // The sync "runs", and meanwhile someone merges a change to another file.
    writeFileSync(join(clone, 'data/rosters.json'), '{"generatedAt":"sync"}\n');
    writeFileSync(join(seed, 'config/leagues.json'), '{"leagues":["a","b"]}\n');
    git(seed, 'commit', '-q', '-am', 'someone else merged');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');

    // A plain push fails here — this is the bug. Proving it keeps the test honest.
    git(clone, 'add', 'data/rosters.json');
    git(clone, 'commit', '-q', '-m', 'probe');
    const plain = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: clone, encoding: 'utf8' });
    assert.notEqual(plain.status, 0, 'a plain push is rejected when main moved');
    git(clone, 'reset', '-q', '--soft', 'HEAD~1');
    git(clone, 'reset', '-q');

    const run = runScript(clone);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /re-applying data\/rosters\.json data\/mfl-league-meta\.json onto the new tip/);
    assert.equal(originFile(bare, 'data/rosters.json'), '{"generatedAt":"sync"}', "the sync's snapshot landed");
    assert.equal(originFile(bare, 'config/leagues.json'), '{"leagues":["a","b"]}', "the other writer's change was not lost");
    assert.equal(originFile(bare, 'docs/readme.md'), 'outside the sparse set', 'files outside the sparse checkout are intact');
    assert.deepEqual(originLog(bare), ['Update MFL rosters data', 'someone else merged', 'seed'], 'history stays linear');
  }

  // ---- both files, with the cache file new on this run, and main moved ------
  // The league-meta cache is committed beside the snapshot. On its first run it
  // does not exist at origin at all; on later runs it does. Both must survive
  // the re-apply, and a run that changes only the cache (no snapshot change) is
  // still a commit.
  {
    const { bare, seed } = makeOrigin('twofiles');
    const clone = workflowClone(bare, 'twofiles-clone');
    writeFileSync(join(clone, 'data/rosters.json'), '{"generatedAt":"sync"}\n');
    writeFileSync(join(clone, 'data/mfl-league-meta.json'), '{"version":1,"leagues":{}}\n');
    writeFileSync(join(seed, 'config/leagues.json'), '{"leagues":["a","b"]}\n');
    git(seed, 'commit', '-q', '-am', 'someone else merged');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const run = runScript(clone);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(originFile(bare, 'data/rosters.json'), '{"generatedAt":"sync"}');
    assert.equal(originFile(bare, 'data/mfl-league-meta.json'), '{"version":1,"leagues":{}}', 'a cache file that did not exist at origin is added');
    assert.equal(originFile(bare, 'config/leagues.json'), '{"leagues":["a","b"]}', "the other writer's change was not lost");

    // Next run: the cache exists at origin and only it changes.
    const second = workflowClone(bare, 'twofiles-clone-2');
    writeFileSync(join(second, 'data/mfl-league-meta.json'), '{"version":1,"leagues":{"1":{}}}\n');
    const run2 = runScript(second);
    assert.equal(run2.status, 0, `${run2.stdout}\n${run2.stderr}`);
    assert.equal(originFile(bare, 'data/mfl-league-meta.json'), '{"version":1,"leagues":{"1":{}}}', 'a cache-only change is committed');
    assert.equal(originFile(bare, 'data/rosters.json'), '{"generatedAt":"sync"}', 'and the snapshot is untouched');
  }

  // ---- main moved to a tip that already has this exact snapshot ------------
  {
    const { bare, seed } = makeOrigin('same');
    const clone = workflowClone(bare, 'same-clone');
    writeFileSync(join(clone, 'data/rosters.json'), '{"generatedAt":"sync"}\n');
    writeFileSync(join(seed, 'data/rosters.json'), '{"generatedAt":"sync"}\n');
    writeFileSync(join(seed, 'config/leagues.json'), '{"leagues":["z"]}\n');
    git(seed, 'commit', '-q', '-am', 'same snapshot, other change');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const run = runScript(clone);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /already carries this snapshot/);
  }

  // ---- a push that can never succeed fails the run, loudly -----------------
  {
    const { bare } = makeOrigin('refused');
    const clone = workflowClone(bare, 'refused-clone');
    const hook = join(bare, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "refused by test" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    writeFileSync(join(clone, 'data/rosters.json'), '{"generatedAt":"sync"}\n');
    const run = runScript(clone, { SNAPSHOT_PUSH_ATTEMPTS: '2' });
    assert.notEqual(run.status, 0, 'gives up with a failure after the last attempt');
    assert.match(run.stdout + run.stderr, /Could not push data\/rosters\.json data\/mfl-league-meta\.json to main after 2 attempts/);
    assert.equal(originFile(bare, 'data/rosters.json'), '{"generatedAt":"v1"}', 'main is untouched');
  }

  // ---- the workflow actually uses it ---------------------------------------
  {
    const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/sync-fantasy-rosters.yml', import.meta.url)), 'utf8');
    assert.ok(workflow.includes('bash scripts/push-snapshot.sh'), 'the sync workflow calls the script');
    assert.ok(!/^\s*git push\s*$/m.test(workflow), 'and no longer pushes with a bare `git push`');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('test-push-snapshot: ok');
