#!/usr/bin/env node
// Writes every SYNTHETIC fixture in this folder. Nothing here comes from a real log: the records are made up
// to have the same shape as Claude Code session logs, with invented ids, times and text.
// Run: node fixtures/make-synthetic-fixtures.mjs   (rewrites the synthetic-* files next to this script)
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = '[Request interrupted by user]';
const DROP = 'Connection dropped (ECONNRESET)';

function writeLines(rel, lines) {
  const f = path.join(HERE, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.length ? lines.join('\n') + '\n' : '');
}
const J = o => JSON.stringify(o);

// ------------------------------------------------------------------ main chat records
function makeIds(prefix) {
  let n = 0;
  return () => `${prefix}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
const user = (uuid, parent, ts, text) => ({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: ts });
const reply = (uuid, parent, ts, text) => ({ parentUuid: parent, isSidechain: false, type: 'assistant', uuid, timestamp: ts,
  message: { id: 'msg-synthetic-' + uuid.slice(-4), role: 'assistant', model: 'synthetic-model', content: [{ type: 'text', text }] } });
const giveUp = (uuid, parent, ts, text) => ({ parentUuid: parent, isSidechain: false, type: 'assistant', uuid, timestamp: ts, isApiErrorMessage: true,
  error: 'synthetic_error', message: { id: 'msg-synthetic-' + uuid.slice(-4), role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } });
const apiErr = (uuid, parent, ts, attempt, formatted) => ({ parentUuid: parent, isSidechain: false, type: 'system', subtype: 'api_error', level: 'error',
  error: { formatted, status: null }, retryInMs: 500 * attempt, retryAttempt: attempt, maxRetries: 10, uuid, timestamp: ts, version: '0.0.0-synthetic' });
const attach = (uuid, parent, ts) => ({ parentUuid: parent, isSidechain: false, type: 'attachment', attachment: { type: 'synthetic_note' }, uuid, timestamp: ts });

// synthetic-project: one session with a main chat and four workflow runs
{
  const U = makeIds('00000000');
  const L = [];
  const D = '2026-01-15';
  // a chain the day before (outside the one-day window the tests use): one drop, recovered
  const uOld = U(), e0 = U(), r0 = U();
  L.push(user(uOld, null, '2026-01-14T09:59:00.000Z', 'synthetic question zero'));
  L.push(apiErr(e0, uOld, '2026-01-14T10:00:00.000Z', 1, DROP));
  L.push(reply(r0, e0, '2026-01-14T10:01:00.000Z', 'synthetic reply zero'));
  // chain A: two drops and a 408, two records written twice, an attachment, then recovered
  const u1 = U(), e1 = U(), e2 = U(), e3 = U(), t1 = U(), r1 = U();
  L.push(user(u1, r0, `${D}T10:00:00.000Z`, 'synthetic question one'));
  L.push(apiErr(e1, u1, `${D}T10:01:00.000Z`, 1, DROP));
  L.push(apiErr(e2, e1, `${D}T10:02:30.000Z`, 2, DROP));
  L.push(apiErr(e1, u1, `${D}T10:01:00.000Z`, 1, DROP));
  L.push(apiErr(e3, e2, `${D}T10:04:00.000Z`, 3, '408 Request timeout'));
  L.push(apiErr(e2, e1, `${D}T10:02:30.000Z`, 2, DROP));
  L.push(attach(t1, e3, `${D}T10:04:30.000Z`));
  L.push(reply(r1, t1, `${D}T10:05:00.000Z`, 'synthetic reply one'));
  // chain B: ten drops, then the client gives up; the user types again and gets a reply
  const u2 = U();
  L.push(user(u2, r1, `${D}T11:00:00.000Z`, 'synthetic question two'));
  let prev = u2;
  for (let i = 1; i <= 10; i++) {
    const e = U();
    L.push(apiErr(e, prev, `${D}T11:${String(i * 2 - 1).padStart(2, '0')}:00.000Z`, i, DROP));
    prev = e;
  }
  const g1 = U(), u3 = U(), r2 = U();
  L.push(giveUp(g1, prev, `${D}T11:21:00.000Z`, 'API Error: ' + DROP));
  L.push(user(u3, g1, `${D}T11:30:00.000Z`, 'Try again'));
  L.push(reply(r2, u3, `${D}T11:31:00.000Z`, 'synthetic reply two'));
  // an error message shown with no retries before it: not a retry give-up
  const g2 = U();
  L.push(giveUp(g2, r2, `${D}T12:00:00.000Z`, 'API Error: 400 synthetic bad request'));
  // a message that only quotes the words the counter looks for: must not count
  const u4 = U(), r3 = U();
  L.push(user(u4, g2, `${D}T12:10:00.000Z`, 'what does "type":"system","subtype":"api_error" or "isApiErrorMessage":true mean?'));
  L.push(reply(r3, u4, `${D}T12:11:00.000Z`, 'synthetic answer that says "subtype":"api_error" again'));
  // chain C: one timeout, then only an attachment: outcome unknown
  const u5 = U(), e14 = U(), t2 = U();
  L.push(user(u5, r3, `${D}T13:00:00.000Z`, 'synthetic question three'));
  L.push(apiErr(e14, u5, `${D}T13:01:00.000Z`, 1, 'Request timed out'));
  L.push(attach(t2, e14, `${D}T13:01:30.000Z`));
  writeLines('synthetic-project/synthetic-session-0001.jsonl', L.map(J));
}

// ------------------------------------------------------------------ workflow agents
const S = 'synthetic-project/synthetic-session-0001';
const A = o => J({ isSidechain: true, ...o });
const V = makeIds('11111111');
const task = ts => A({ type: 'user', timestamp: ts, uuid: V(), message: { role: 'user', content: 'synthetic task prompt' } });
const toolUse = (ts, id, name) => A({ type: 'assistant', timestamp: ts, uuid: V(), message: { id: 'msg-synthetic-' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input: { synthetic: true } }] } });
const toolRes = (ts, id, content) => A({ type: 'user', timestamp: ts, uuid: V(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] } });
const marker = ts => A({ type: 'user', timestamp: ts, uuid: V(), message: { role: 'user', content: [{ type: 'text', text: MARKER }] } });
const done = ts => A({ type: 'assistant', timestamp: ts, uuid: V(), message: { id: 'msg-synthetic-done', role: 'assistant', content: [{ type: 'text', text: 'synthetic final answer' }] } });
const note = ts => A({ type: 'attachment', timestamp: ts, uuid: V(), attachment: { type: 'synthetic_note' } });
const apiEnd = ts => A({ type: 'assistant', timestamp: ts, uuid: V(), isApiErrorMessage: true, message: { id: 'msg-synthetic-api', role: 'assistant', content: [{ type: 'text', text: 'API Error: ' + DROP }] } });
const agentFile = (run, id, lines) => writeLines(`${S}/subagents/workflows/${run}/agent-${id}.jsonl`, lines);
const ms = s => Date.parse(s);

// run 001: completed, five agents in the record (two lost), two journal starts that never reported back
{
  const run = 'wf_synthetic-001';
  // a1: finished normally; one tool result only QUOTES the interrupt marker
  agentFile(run, 'synthetic-a1', [task('2026-01-15T09:01:00.000Z'), toolUse('2026-01-15T09:02:00.000Z', 'tu-a1', 'Grep'),
    toolRes('2026-01-15T09:02:01.000Z', 'tu-a1', 'notes.txt: ' + MARKER), done('2026-01-15T09:03:00.000Z')]);
  // b1: first attempt, killed by the watchdog 180 s after the last record; restarted as b2
  agentFile(run, 'synthetic-b1', [task('2026-01-15T09:10:00.000Z'), toolUse('2026-01-15T09:12:00.000Z', 'tu-b1', 'Read'),
    toolRes('2026-01-15T09:12:05.000Z', 'tu-b1', 'synthetic file text'), note('2026-01-15T09:12:05.100Z'), marker('2026-01-15T09:15:05.100Z')]);
  agentFile(run, 'synthetic-b2', [task('2026-01-15T09:16:00.000Z'), done('2026-01-15T09:20:00.000Z')]);
  // c1: last attempt, killed by the watchdog (181 s): the agent is lost
  agentFile(run, 'synthetic-c1', [task('2026-01-15T10:20:00.000Z'), toolUse('2026-01-15T10:21:00.000Z', 'tu-c1', 'Grep'),
    toolRes('2026-01-15T10:21:01.000Z', 'tu-c1', 'no matches'), marker('2026-01-15T10:24:02.000Z')]);
  // d1: last attempt ended on an API error: the agent is lost, but it is not a watchdog kill
  agentFile(run, 'synthetic-d1', [task('2026-01-15T10:50:00.000Z'), apiEnd('2026-01-15T11:00:00.000Z')]);
  // e1: stopped 30 s after the last record (a user or app stop, not counted); restarted as e2
  agentFile(run, 'synthetic-e1', [task('2026-01-15T09:30:00.000Z'), toolUse('2026-01-15T09:31:00.000Z', 'tu-e1', 'Glob'),
    toolRes('2026-01-15T09:31:01.000Z', 'tu-e1', 'a b'), marker('2026-01-15T09:31:31.000Z')]);
  agentFile(run, 'synthetic-e2', [task('2026-01-15T09:32:00.000Z'), done('2026-01-15T09:40:00.000Z')]);
  writeLines(`${S}/subagents/workflows/${run}/journal.jsonl`, [
    { type: 'launched' },
    { type: 'started', key: 'a', agentId: 'synthetic-a1', label: 'a', phase: 0 },
    { type: 'started', key: 'b', agentId: 'synthetic-b1', label: 'b', phase: 0 },
    { type: 'started', key: 'e', agentId: 'synthetic-e1', label: 'e', phase: 0 },
    { type: 'result', key: 'a', agentId: 'synthetic-a1', result: 'synthetic' },
    { type: 'started', key: 'b', agentId: 'synthetic-b2', label: 'b', phase: 0 },
    { type: 'started', key: 'e', agentId: 'synthetic-e2', label: 'e', phase: 0 },
    { type: 'result', key: 'b', agentId: 'synthetic-b2', result: 'synthetic' },
    { type: 'result', key: 'e', agentId: 'synthetic-e2', result: 'synthetic' },
    { type: 'started', key: 'c', agentId: 'synthetic-c1', label: 'c', phase: 1 },
    { type: 'started', key: 'd', agentId: 'synthetic-d1', label: 'd', phase: 1 },
    { type: 'failed', key: 'c', agentId: 'synthetic-c1' },
    { type: 'failed', key: 'd', agentId: 'synthetic-d1' },
    { type: 'started', key: 'h', agentId: 'synthetic-h1', label: 'h', phase: 2 },
    { type: 'started', key: 'i', agentId: 'synthetic-i1', label: 'i', phase: 2 },
  ].map(J));
  writeLines(`${S}/workflows/${run}.json`, [J({
    runId: run, workflowName: 'synthetic', status: 'completed', startTime: ms('2026-01-15T09:00:00Z'), durationMs: 3 * 3600 * 1000,
    workflowProgress: [
      { type: 'workflow_phase', index: 0 },
      { type: 'workflow_agent', agentId: 'synthetic-a1', label: 'a', state: 'done', attempt: 1, lastProgressAt: ms('2026-01-15T09:03:00Z') },
      { type: 'workflow_agent', agentId: 'synthetic-b2', label: 'b', state: 'done', attempt: 2, lastProgressAt: ms('2026-01-15T09:20:00Z') },
      { type: 'workflow_agent', agentId: 'synthetic-c1', label: 'c', state: 'error', attempt: 1, error: 'stalled: no progress for 180000ms', lastAttemptReason: 'stalled', lastProgressAt: ms('2026-01-15T10:24:02Z') },
      { type: 'workflow_agent', agentId: 'synthetic-d1', label: 'd', state: 'error', attempt: 1, error: 'API Error: ' + DROP, lastProgressAt: ms('2026-01-15T11:00:00Z') },
      { type: 'workflow_agent', agentId: 'synthetic-e2', label: 'e', state: 'done', attempt: 2, lastProgressAt: ms('2026-01-15T09:40:00Z') },
    ] })]);
}
// run 002: still going (no final record yet); one attempt killed by the watchdog
agentFile('wf_synthetic-002', 'synthetic-f1', [task('2026-01-15T15:00:00.000Z'), toolUse('2026-01-15T15:01:00.000Z', 'tu-f1', 'Grep'),
  toolRes('2026-01-15T15:01:01.000Z', 'tu-f1', 'none'), marker('2026-01-15T15:04:01.000Z')]);
// run 003: completed, every agent done, but no journal on disk to check
writeLines(`${S}/workflows/wf_synthetic-003.json`, [J({ runId: 'wf_synthetic-003', status: 'completed', startTime: ms('2026-01-15T16:00:00Z'), durationMs: 600000,
  workflowProgress: [{ type: 'workflow_agent', agentId: 'synthetic-n1', state: 'done', attempt: 1, lastProgressAt: ms('2026-01-15T16:05:00Z') }] })]);
// run 004: stopped by the user (status killed): its unfinished start is not "never reported back"
writeLines(`${S}/workflows/wf_synthetic-004.json`, [J({ runId: 'wf_synthetic-004', status: 'killed', startTime: ms('2026-01-15T17:00:00Z'), durationMs: 600000,
  workflowProgress: [{ type: 'workflow_agent', agentId: 'synthetic-k1', state: 'progress', attempt: 1, lastProgressAt: ms('2026-01-15T17:05:00Z') }] })]);
writeLines(`${S}/subagents/workflows/wf_synthetic-004/journal.jsonl`, [{ type: 'launched' }, { type: 'started', key: 'k', agentId: 'synthetic-k1', label: 'k', phase: 0 }].map(J));
// run 005: the day before; one agent lost to the watchdog, one start that never reported back
agentFile('wf_synthetic-005', 'synthetic-g1', [task('2026-01-14T08:10:00.000Z'), toolUse('2026-01-14T08:11:00.000Z', 'tu-g1', 'Read'),
  toolRes('2026-01-14T08:11:01.000Z', 'tu-g1', 'synthetic text'), marker('2026-01-14T08:14:30.000Z')]);
writeLines(`${S}/subagents/workflows/wf_synthetic-005/journal.jsonl`, [{ type: 'launched' },
  { type: 'started', key: 'g', agentId: 'synthetic-g1', label: 'g', phase: 0 }, { type: 'failed', key: 'g', agentId: 'synthetic-g1' },
  { type: 'started', key: 'm', agentId: 'synthetic-m1', label: 'm', phase: 0 }].map(J));
writeLines(`${S}/workflows/wf_synthetic-005.json`, [J({ runId: 'wf_synthetic-005', status: 'completed', startTime: ms('2026-01-14T08:00:00Z'), durationMs: 3600000,
  workflowProgress: [{ type: 'workflow_agent', agentId: 'synthetic-g1', state: 'error', attempt: 1, error: 'stalled: no progress for 180000ms', lastProgressAt: ms('2026-01-14T08:14:30Z') }] })]);
// a background Task agent (not a workflow agent): skipped by the counter
writeLines(`${S}/subagents/agent-synthetic-task1.jsonl`, [task('2026-01-15T18:00:00.000Z'), marker('2026-01-15T18:10:00.000Z')]);

// ------------------------------------------------------------------ small single-file fixtures
{
  const U = makeIds('22222222');
  const u1 = U(), e1 = U(), r1 = U();
  writeLines('synthetic-malformed.jsonl', [
    J(user(u1, null, '2026-01-15T09:59:00.000Z', 'synthetic question')),
    '{"type":"system","subtype":"api_error","uuid":"22222222-0000-4000-8000-0000000000aa","parentUuid":',
    'this line is not JSON',
    J(apiErr(e1, u1, '2026-01-15T10:00:00.000Z', 1, DROP)),
    '[1, 2, 3]',
    '',
    J(reply(r1, e1, '2026-01-15T10:01:00.000Z', 'synthetic reply')),
    '{"type":"assistant","timestamp":NaN}',
  ]);
}
writeLines('synthetic-empty.jsonl', []);
{
  const U = makeIds('33333333');
  const L = []; let prev = null;
  for (let i = 0; i < 3; i++) {
    const u = U(), r = U();
    L.push(user(u, prev, `2026-01-15T0${i + 1}:00:00.000Z`, `synthetic question ${i}`));
    L.push(reply(r, u, `2026-01-15T0${i + 1}:01:00.000Z`, i === 1 ? 'logs can hold "subtype":"api_error" records and the text ' + MARKER : `synthetic reply ${i}`));
    prev = r;
  }
  writeLines('synthetic-no-errors.jsonl', L.map(J));
}
console.log('synthetic fixtures written');
