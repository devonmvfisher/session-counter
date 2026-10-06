// Tests for session-counter on SYNTHETIC fixtures only (no real log is read).
// Run from the repo folder: node --test
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { count, parseTime, classify, roleOf } from '../counter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = p => path.join(ROOT, 'fixtures', p);

const zeroFailed = { count: 0, by_kind: {}, repeats_ignored: 0, incidents: 0, recovered: 0, gave_up: 0, unknown: 0 };
const zeroKills = { count: 0, last_attempt: 0, restarted: 0, no_final_record: 0, short_stops_not_counted: 0 };
const zeroLost = { count: 0, by_reason: {}, runs_marked_completed: 0 };
const zeroSilent = { count: 0, runs: 0, completed_runs_without_journal: 0 };
const base = (files, lines) => ({ tool: 'session-counter', version: '0.1.0', window: { since: null, until: null }, files, lines });
const oneFile = { transcripts: 1, agent_files: 0, run_records: 0, journals: 0, unreadable: 0 };
const projectFiles = { transcripts: 1, agent_files: 9, run_records: 4, journals: 3, unreadable: 0 };

// Hand-derived from the comments in fixtures/make-synthetic-fixtures.mjs.
const EXPECT_MAIN = {
  ...base(projectFiles, { parsed: 70, unreadable: 0 }),
  failed_requests: { count: 15, by_kind: { 'connection dropped': 13, timeout: 2 }, repeats_ignored: 2, incidents: 4, recovered: 2, gave_up: 1, unknown: 1 },
  retry_give_ups: 1,
  watchdog_kills: { count: 4, last_attempt: 2, restarted: 1, no_final_record: 1, short_stops_not_counted: 1 },
  agents_lost: { count: 3, by_reason: { 'connection dropped': 1, 'stalled (no progress)': 2 }, runs_marked_completed: 2 },
  never_reported_back: { count: 3, runs: 2, completed_runs_without_journal: 1 },
};
const EXPECT_DAY = {
  ...base(projectFiles, { parsed: 70, unreadable: 0 }),
  failed_requests: { count: 14, by_kind: { 'connection dropped': 12, timeout: 2 }, repeats_ignored: 2, incidents: 3, recovered: 1, gave_up: 1, unknown: 1 },
  retry_give_ups: 1,
  watchdog_kills: { count: 3, last_attempt: 1, restarted: 1, no_final_record: 1, short_stops_not_counted: 1 },
  agents_lost: { count: 2, by_reason: { 'connection dropped': 1, 'stalled (no progress)': 1 }, runs_marked_completed: 1 },
  never_reported_back: { count: 2, runs: 1, completed_runs_without_journal: 1 },
};

test('main synthetic fixture: every count', async () => {
  const c = await count([FX('synthetic-project')]);
  assert.equal(c.found, 17);
  assert.deepEqual(c.result, EXPECT_MAIN);
});

test('main synthetic fixture, one UTC day: older chain, kill, lost agent and silent start drop out', async () => {
  const c = await count([FX('synthetic-project')], parseTime('2026-01-15'), parseTime('2026-01-16'));
  assert.deepEqual(c.result, EXPECT_DAY);
});

test('malformed lines are counted as unreadable and skipped, the rest still counts', async () => {
  const c = await count([FX('synthetic-malformed.jsonl')]);
  assert.deepEqual(c.result, {
    ...base(oneFile, { parsed: 7, unreadable: 4 }),
    failed_requests: { count: 1, by_kind: { 'connection dropped': 1 }, repeats_ignored: 0, incidents: 1, recovered: 1, gave_up: 0, unknown: 0 },
    retry_give_ups: 0, watchdog_kills: zeroKills, agents_lost: zeroLost, never_reported_back: zeroSilent,
  });
});

test('an empty file counts as one transcript with nothing in it', async () => {
  const c = await count([FX('synthetic-empty.jsonl')]);
  assert.deepEqual(c.result, { ...base(oneFile, { parsed: 0, unreadable: 0 }), failed_requests: zeroFailed, retry_give_ups: 0,
    watchdog_kills: zeroKills, agents_lost: zeroLost, never_reported_back: zeroSilent });
});

test('a file with no errors (but quoting the words the counter looks for) counts zero', async () => {
  const c = await count([FX('synthetic-no-errors.jsonl')]);
  assert.deepEqual(c.result, { ...base(oneFile, { parsed: 6, unreadable: 0 }), failed_requests: zeroFailed, retry_give_ups: 0,
    watchdog_kills: zeroKills, agents_lost: zeroLost, never_reported_back: zeroSilent });
});

test('times: UTC dates, offsets, fractions, and text that is not a time', () => {
  assert.equal(parseTime('2026-01-15'), Date.UTC(2026, 0, 15));
  assert.equal(parseTime('2026-01-15T10:01:00.000Z'), Date.UTC(2026, 0, 15, 10, 1));
  assert.equal(parseTime('2026-01-15T00:00-06:00'), Date.UTC(2026, 0, 15, 6));
  assert.equal(parseTime('2024-02-29T23:59:59.5+0100'), Date.UTC(2024, 1, 29, 22, 59, 59, 500));
  assert.equal(parseTime('1999-12-31 23:59'), Date.UTC(1999, 11, 31, 23, 59));
  for (const bad of ['', 'now', '2026-13-01', '2026-01-15T24:00', '2026-01-15T10:00+25:00', '15/01/2026', null, 1234]) assert.equal(parseTime(bad), null);
});

test('error kinds', () => {
  assert.deepEqual(['Connection dropped (ECONNRESET)', '408 Request timeout', 'Request timed out', 'stalled: no progress for 180000ms',
    '529 overloaded', 'HTTP 503', '401 authentication failed', 'getaddrinfo ENOTFOUND', '400 bad', 'mystery', ''].map(classify),
  ['connection dropped', 'timeout', 'timeout', 'stalled (no progress)', 'overloaded (529)', 'server error (5xx)',
    'authentication (401 or 403)', 'cannot reach the API', 'bad request (400)', 'other', 'other']);
});

test('file roles follow the Claude Code layout', () => {
  assert.equal(roleOf('p/s.jsonl').role, 'transcript');
  assert.equal(roleOf('p/s/subagents/workflows/wf_1/agent-x.jsonl').role, 'attempt');
  assert.equal(roleOf('p/s/subagents/workflows/wf_1/agent-x.jsonl').agentId, 'x');
  assert.equal(roleOf('p/s/subagents/workflows/wf_1/journal.jsonl').role, 'journal');
  assert.equal(roleOf('p/s/workflows/wf_1.json').role, 'record');
  assert.equal(roleOf('p/s/subagents/agent-task.jsonl'), null);   // background Task agent: skipped
  assert.equal(roleOf('p/s/subagents/workflows/wf_1/agent-x.meta.json'), null);
  assert.equal(roleOf('p/notes.txt'), null);
});

// ---------------------------------------------------------------- the command line, and the Python twin
const node = args => spawnSync(process.execPath, [path.join(ROOT, 'counter.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
function findPython() {
  const names = process.env.SESSION_COUNTER_PYTHON ? [process.env.SESSION_COUNTER_PYTHON] : ['python3', 'python', 'py'];
  for (const n of names) {
    const r = spawnSync(n, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3/.test((r.stdout || '') + (r.stderr || ''))) return n;
  }
  return null;
}
const PY = findPython();
const python = args => spawnSync(PY, [path.join(ROOT, 'counter.py'), ...args], { cwd: ROOT, encoding: 'utf8' });

// Every fixture, plus the error paths. Paths are relative to the repo folder.
export const CASES = [
  ['fixtures/synthetic-project'],
  ['fixtures/synthetic-project', '--json'],
  ['fixtures/synthetic-project', '--since', '2026-01-15', '--until', '2026-01-16', '--json'],
  ['fixtures/synthetic-project', '--since', '2026-01-15T00:00-06:00'],
  ['fixtures/synthetic-malformed.jsonl'],
  ['fixtures/synthetic-malformed.jsonl', '--json'],
  ['fixtures/synthetic-empty.jsonl'],
  ['fixtures/synthetic-empty.jsonl', '--json'],
  ['fixtures/synthetic-no-errors.jsonl'],
  ['fixtures/synthetic-no-errors.jsonl', '--json'],
  ['fixtures/synthetic-project/synthetic-session-0001/subagents/workflows/wf_synthetic-001/agent-synthetic-c1.jsonl', '--json'],
  ['fixtures'],
  ['fixtures', '--json'],
  ['fixtures', '--until', '2026-01-15'],
  ['no-such-folder-synthetic'],
  ['tests'],
  ['fixtures', '--since', 'not-a-time'],
  ['fixtures', '--since', '2026-01-16', '--until', '2026-01-15'],
  ['fixtures', '--bogus'],
  [],
  ['--help'],
  ['--version'],
];

test('command line: exit codes and plain-words errors', () => {
  assert.equal(node(['fixtures/synthetic-project']).status, 0);
  assert.equal(node(['--help']).status, 0);
  const missing = node(['no-such-folder-synthetic']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no such file or folder/);
  const none = node(['tests']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /found no Claude Code session logs/);
  assert.equal(node(['fixtures', '--since', 'not-a-time']).status, 2);
  assert.equal(node(['fixtures', '--since', '2026-01-16', '--until', '2026-01-15']).status, 2);
  assert.equal(node([]).status, 2);
  assert.deepEqual(JSON.parse(node(['fixtures/synthetic-project', '--json']).stdout), EXPECT_MAIN);
});

test('output holds counts only: no fixture paths, ids or text', () => {
  for (const args of [['fixtures'], ['fixtures', '--json']]) {
    const out = node(args).stdout;
    assert.doesNotMatch(out, /synthetic|fixtures|wf_|agent-|0000-4000|[A-Za-z]:[\\/]|\/home\//);
  }
});

test('read-only: every fixture file is byte for byte the same after both counters run', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(path.join(ROOT, 'fixtures'));
  const hash = () => files.map(f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  const before = hash();
  node(['fixtures']); node(['fixtures', '--json']);
  if (PY) { python(['fixtures']); python(['fixtures', '--json']); }
  assert.deepEqual(hash(), before);
});

test('Node and Python print the same bytes and exit codes on every case', { skip: PY ? false : 'no Python 3 found (set SESSION_COUNTER_PYTHON)' }, () => {
  for (const args of CASES) {
    const a = node(args), b = python(args);
    assert.equal(b.status, a.status, 'exit code for ' + args.join(' '));
    assert.equal(b.stdout, a.stdout, 'stdout for ' + args.join(' '));
    assert.equal(b.stderr, a.stderr, 'stderr for ' + args.join(' '));
  }
});
