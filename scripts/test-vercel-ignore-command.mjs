// Pins vercel.json's ignoreCommand: Vercel rejects the whole deployment if it is
// over 256 characters (schema validation, no build runs), and treats only exit 0
// (skip) and 1 (build) as valid, so git's exit 128 on a sha missing from the
// shallow clone must be turned into 1.
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const cmd = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).ignoreCommand;
assert.ok(cmd.length <= 256, `ignoreCommand is ${cmd.length} chars; Vercel's limit is 256`);

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const run = sha => spawnSync('sh', ['-c', cmd], { env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: sha } }).status;

assert.equal(run(''), 1, 'no previous sha builds');
assert.equal(run('0123456789abcdef0123456789abcdef01234567'), 1, 'sha missing from clone builds, never exit 128');
assert.equal(run(head), 0, 'nothing changed since HEAD skips');
console.log('vercel ignoreCommand ok');
