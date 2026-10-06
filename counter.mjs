#!/usr/bin/env node
// session-counter (Node version). Recounts failures in your own Claude Code session logs.
// Standard library only. Reads only, writes nothing, prints counts only (never paths or log text).
// The Python version (counter.py) follows the same rules line for line; the tests check that both
// print the same bytes on every fixture.
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
export const MARKER = '[Request interrupted by user]';
export const KILL_MS = 175000; // an interrupt this long after the record before it is a watchdog kill
const TAIL = 200;              // agent files are read from the end; this many non-blank lines are kept
const FOLLOW_DEPTH = 40;       // how far to follow records after a retry chain to find its outcome

export const HELP = `session-counter ${VERSION}: recount failures in your own Claude Code session logs.

Usage:
  node counter.mjs PATH [PATH ...] [--since TIME] [--until TIME] [--json]
  python counter.py PATH [PATH ...] [--since TIME] [--until TIME] [--json]

PATH     a folder (searched recursively) or a single log file
--since  count only events at or after TIME
--until  count only events before TIME
TIME     YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS], UTC unless it ends in an offset like -05:00
--json   print JSON instead of text
--help, --version

Reads only. Writes nothing. Prints counts only, never paths or log text.
`;

// ------------------------------------------------------------------ time (UTC, no time zone database)
const RX_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$/;

function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Returns milliseconds since 1970-01-01 UTC, or null when the text is not a time this tool reads.
export function parseTime(s) {
  if (typeof s !== 'string') return null;
  const m = RX_TIME.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const h = m[4] === undefined ? 0 : +m[4];
  const mi = m[5] === undefined ? 0 : +m[5];
  const se = m[6] === undefined ? 0 : +m[6];
  const ms = m[7] === undefined ? 0 : +(m[7] + '00').slice(0, 3);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  let off = 0;
  const z = m[8];
  if (z !== undefined && z !== 'Z') {
    const digits = z.slice(1).replace(':', '');
    const oh = +digits.slice(0, 2), om = +digits.slice(2, 4);
    if (oh > 23 || om > 59) return null;
    off = (z[0] === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  return daysFromCivil(y, mo, d) * 86400000 + h * 3600000 + mi * 60000 + se * 1000 + ms - off;
}

const isNum = x => typeof x === 'number' && Number.isFinite(x);
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = x => (typeof x === 'string' ? x : null);
const timeOf = v => (isNum(v) ? v : parseTime(v));

// ------------------------------------------------------------------ error kinds
const KINDS = [
  [/no progress for|^[ \t]*stalled/i, 'stalled (no progress)'],
  [/ECONNRESET|connection dropped|socket hang up/i, 'connection dropped'],
  [/\b408\b|timed out|timeout/i, 'timeout'],
  [/\b529\b|overloaded/i, 'overloaded (529)'],
  [/\b429\b|rate[ _-]?limit/i, 'rate limited (429)'],
  [/\b5[0-9][0-9]\b/, 'server error (5xx)'],
  [/\b40[13]\b|authentication|unauthori[sz]ed|forbidden/i, 'authentication (401 or 403)'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|cannot reach|can't reach/i, 'cannot reach the API'],
  [/\b400\b|invalid[ _]request/i, 'bad request (400)'],
];
export function classify(text) {
  const t = typeof text === 'string' ? text : '';
  for (const [rx, label] of KINDS) if (rx.test(t)) return label;
  return 'other';
}
function errorText(e) {
  if (typeof e === 'string') return e;
  if (isObj(e)) {
    if (typeof e.formatted === 'string' && e.formatted !== '') return e.formatted;
    if (typeof e.message === 'string') return e.message;
  }
  return '';
}

// ------------------------------------------------------------------ reading
const BAD = Symbol('unreadable');
function parseLine(line) {
  try { return JSON.parse(line); } catch { return BAD; }
}
const isBlank = line => /^[ \t\r\n]*$/.test(line);
const splitLines = text => text.split(/\r\n|\r|\n/);

const normAbs = p => path.resolve(p).split(path.sep).join('/');

// Sorts one file into a role by its place in the Claude Code layout.
//   <project>/<session>.jsonl                                   main chat transcript
//   <session>/subagents/workflows/<runId>/agent-<id>.jsonl     one workflow agent attempt
//   <session>/subagents/workflows/<runId>/journal.jsonl        the run's journal
//   <session>/workflows/<runId>.json                           the run's final record
// Background Task agents (<session>/subagents/agent-<id>.jsonl) and anything else are skipped.
export function roleOf(abs) {
  const segs = abs.split('/');
  const n = segs.length;
  const name = segs[n - 1];
  const underRun = n >= 4 && segs[n - 3] === 'workflows' && segs[n - 4] === 'subagents';
  if (/^agent-[\s\S]+\.jsonl$/.test(name)) {
    if (!underRun) return null;
    return { role: 'attempt', run: segs.slice(0, n - 4).join('/') + '\u0000' + segs[n - 2], agentId: name.slice(6, -6) };
  }
  if (name === 'journal.jsonl') {
    if (!underRun) return null;
    return { role: 'journal', run: segs.slice(0, n - 4).join('/') + '\u0000' + segs[n - 2] };
  }
  if (/^wf_[\s\S]+\.json$/.test(name)) {
    if (!(n >= 2 && segs[n - 2] === 'workflows') || (n >= 3 && segs[n - 3] === 'subagents')) return null;
    return { role: 'record', run: segs.slice(0, n - 2).join('/') + '\u0000' + name.slice(0, -5) };
  }
  if (name.endsWith('.jsonl')) return { role: 'transcript' };
  return null;
}

function walk(abs, out, stats) {
  let ents;
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { stats.unreadable++; return; }
  for (const e of ents) {
    const child = (abs.endsWith('/') ? abs : abs + '/') + e.name;
    if (e.isDirectory()) walk(child, out, stats);
    else if (e.isFile()) out.push(child);
  }
}

export function collect(paths, stats) {
  const seen = new Set();
  const files = [];
  for (const p of paths) {
    const abs = normAbs(p);
    let st;
    try { st = fs.statSync(abs); } catch { throw new UsageError('no such file or folder: ' + p); }
    const found = [];
    if (st.isDirectory()) walk(abs, found, stats);
    else if (st.isFile()) found.push(abs);
    for (const f of found) if (!seen.has(f)) { seen.add(f); files.push(f); }
  }
  files.sort();
  const out = { transcripts: [], attempts: [], journals: [], records: [] };
  for (const f of files) {
    const r = roleOf(f);
    if (!r) continue;
    r.file = f;
    out[r.role + 's'].push(r);
  }
  return out;
}

export class UsageError extends Error {}

// ------------------------------------------------------------------ the count
export async function count(paths, since = null, until = null) {
  const windowed = since !== null || until !== null;
  const inWin = ms => !windowed || (ms !== null && (since === null || ms >= since) && (until === null || ms < until));
  const stats = { unreadable: 0, parsed: 0, bad: 0 };
  const found = collect(paths, stats);

  // 1. main chat: failed requests, incidents, give-ups
  const err = new Map();      // uuid -> { parent, ms, kind }
  const repeats = new Map();  // uuid -> times seen
  const watch = new Set();
  const info = new Map();     // uuid -> 'error' | 'gave_up' | 'reply' | 'other'
  const kids = new Map();     // parent uuid -> [child uuid]
  for (const t of found.transcripts) {
    let rl;
    try {
      const stream = fs.createReadStream(t.file, { encoding: 'utf8', highWaterMark: 1 << 20 });
      await new Promise((res, rej) => { stream.once('open', res); stream.once('error', rej); });
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    } catch { stats.unreadable++; continue; }
    for await (const line of rl) {
      if (isBlank(line)) continue;
      stats.parsed++;
      const o = parseLine(line);
      if (!isObj(o)) { stats.bad++; continue; }
      const uuid = str(o.uuid);
      const isErr = o.type === 'system' && o.subtype === 'api_error';
      if (isErr && uuid !== null) {
        repeats.set(uuid, (repeats.get(uuid) || 0) + 1);
        if (!err.has(uuid)) {
          err.set(uuid, { parent: str(o.parentUuid), ms: parseTime(o.timestamp), kind: classify(errorText(o.error)) });
          watch.add(uuid);
        }
      }
      const parent = str(o.parentUuid);
      if (parent !== null && uuid !== null && watch.has(parent) && !info.has(uuid)) {
        const kind = isErr ? 'error' : o.type === 'assistant' ? (o.isApiErrorMessage === true ? 'gave_up' : 'reply') : 'other';
        info.set(uuid, kind);
        if (!kids.has(parent)) kids.set(parent, []);
        kids.get(parent).push(uuid);
        if (kind === 'error' || kind === 'other') watch.add(uuid);
      }
    }
  }
  const follow = (u, depth) => {
    for (const c of kids.get(u) || []) {
      if (err.has(c)) continue;
      const k = info.get(c);
      if (k === 'reply' || k === 'gave_up') return k;
      if (depth < FOLLOW_DEPTH) { const r = follow(c, depth + 1); if (r !== null) return r; }
    }
    return null;
  };
  const failed = { count: 0, by_kind: {}, repeats_ignored: 0, incidents: 0, recovered: 0, gave_up: 0, unknown: 0 };
  for (const [u, e] of err) {
    if (inWin(e.ms)) {
      failed.count++;
      failed.by_kind[e.kind] = (failed.by_kind[e.kind] || 0) + 1;
      failed.repeats_ignored += repeats.get(u) - 1;
    }
    if (e.parent !== null && err.has(e.parent)) continue; // not the first error of its chain
    const seq = [u]; const inSeq = new Set(seq);
    for (;;) {
      const nx = (kids.get(seq[seq.length - 1]) || []).find(c => err.has(c) && !inSeq.has(c));
      if (nx === undefined) break;
      seq.push(nx); inSeq.add(nx);
    }
    if (!inWin(e.ms)) continue;
    failed.incidents++;
    const end = follow(seq[seq.length - 1], 0);
    if (end === 'reply') failed.recovered++;
    else if (end === 'gave_up') failed.gave_up++;
    else failed.unknown++;
  }
  failed.by_kind = sortKeys(failed.by_kind);

  // 2. workflows: records, journals, attempts
  const runs = new Map();
  const runOf = k => { if (!runs.has(k)) runs.set(k, { record: null, journal: null }); return runs.get(k); };
  for (const r of found.records) {
    let o = BAD;
    try { o = parseLine(fs.readFileSync(r.file, 'utf8')); } catch { o = BAD; }
    if (!isObj(o)) { stats.unreadable++; continue; }
    runOf(r.run).record = o;
  }
  for (const j of found.journals) {
    let text;
    try { text = fs.readFileSync(j.file, 'utf8'); } catch { stats.unreadable++; continue; }
    const started = new Map(), results = new Set(), failedKeys = new Set();
    for (const line of splitLines(text)) {
      if (isBlank(line)) continue;
      stats.parsed++;
      const o = parseLine(line);
      if (!isObj(o)) { stats.bad++; continue; }
      const key = typeof o.key === 'string' ? 's:' + o.key : 'none';
      if (o.type === 'started') { if (!started.has(key)) started.set(key, []); started.get(key).push(str(o.agentId)); }
      else if (o.type === 'result') results.add(key);
      else if (o.type === 'failed') failedKeys.add(key);
    }
    runOf(j.run).journal = { started, results, failed: failedKeys };
  }
  const agentsOf = rec => (Array.isArray(rec.workflowProgress) ? rec.workflowProgress : []).filter(p => isObj(p) && p.type === 'workflow_agent');

  const kills = { count: 0, last_attempt: 0, restarted: 0, no_final_record: 0, short_stops_not_counted: 0 };
  for (const a of found.attempts) {
    let text;
    try { text = fs.readFileSync(a.file, 'utf8'); } catch { stats.unreadable++; continue; }
    const lines = splitLines(text).filter(l => !isBlank(l)).slice(-TAIL);
    text = null;
    const tail = []; // newest first, records with a readable timestamp
    for (let i = lines.length - 1; i >= 0 && tail.length < 2; i--) {
      stats.parsed++;
      const o = parseLine(lines[i]);
      if (!isObj(o)) { stats.bad++; continue; }
      const ms = parseTime(o.timestamp);
      if (ms !== null) tail.push({ o, ms });
    }
    if (tail.length < 2 || !isMarker(tail[0].o)) continue;
    if (!inWin(tail[0].ms)) continue;
    if (tail[0].ms - tail[1].ms < KILL_MS) { kills.short_stops_not_counted++; continue; }
    kills.count++;
    const run = runs.get(a.run);
    if (!run || !run.record) kills.no_final_record++;
    else if (agentsOf(run.record).some(p => str(p.agentId) === a.agentId)) kills.last_attempt++;
    else kills.restarted++;
  }

  const lost = { count: 0, by_reason: {}, runs_marked_completed: 0 };
  const silent = { count: 0, runs: 0, completed_runs_without_journal: 0 };
  for (const k of [...runs.keys()].sort()) {
    const { record: rec, journal } = runs.get(k);
    if (!rec) continue;
    const agents = agentsOf(rec);
    let lostHere = 0;
    for (const p of agents) {
      if (p.state !== 'error') continue;
      if (!inWin(timeOf(p.lastProgressAt))) continue;
      const why = classify(typeof p.error === 'string' && p.error !== '' ? p.error : str(p.lastAttemptReason));
      lost.count++; lostHere++;
      lost.by_reason[why] = (lost.by_reason[why] || 0) + 1;
    }
    if (rec.status === 'completed' && lostHere > 0) lost.runs_marked_completed++;
    if (rec.status !== 'completed') continue;
    const endMs = isNum(rec.startTime) ? rec.startTime + (isNum(rec.durationMs) ? rec.durationMs : 0) : null;
    if (!inWin(endMs)) continue;
    if (!journal) { silent.completed_runs_without_journal++; continue; }
    let n = 0;
    for (const [key, ids] of journal.started) {
      if (journal.results.has(key) || journal.failed.has(key)) continue;
      const last = ids[ids.length - 1];
      if (!agents.some(p => last !== null && str(p.agentId) === last && p.state !== 'done')) n++;
    }
    if (n > 0) { silent.count += n; silent.runs++; }
  }
  lost.by_reason = sortKeys(lost.by_reason);

  return {
    found: found.transcripts.length + found.attempts.length + found.records.length + found.journals.length,
    result: {
      tool: 'session-counter',
      version: VERSION,
      window: { since: null, until: null },
      files: { transcripts: found.transcripts.length, agent_files: found.attempts.length, run_records: found.records.length,
        journals: found.journals.length, unreadable: stats.unreadable },
      lines: { parsed: stats.parsed, unreadable: stats.bad },
      failed_requests: failed,
      retry_give_ups: failed.gave_up,
      watchdog_kills: kills,
      agents_lost: lost,
      never_reported_back: silent,
    },
  };
}

function isMarker(o) {
  if (o.type !== 'user' || !isObj(o.message) || !Array.isArray(o.message.content)) return false;
  const c = o.message.content;
  if (c.some(b => isObj(b) && b.type === 'tool_result')) return false;
  return c.some(b => isObj(b) && b.type === 'text' && b.text === MARKER);
}

function sortKeys(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

// ------------------------------------------------------------------ output
const list = o => Object.keys(o).map(k => `${k} ${o[k]}`).join(', ') || 'none';

export function renderText(r) {
  const f = r.failed_requests, k = r.watchdog_kills, l = r.agents_lost, s = r.never_reported_back;
  const w = [];
  if (r.window.since !== null) w.push('since ' + r.window.since);
  if (r.window.until !== null) w.push('until ' + r.window.until);
  return [
    `session-counter ${r.version} (read-only, counts only)`,
    `files: transcripts ${r.files.transcripts}, agent files ${r.files.agent_files}, run records ${r.files.run_records}, journals ${r.files.journals}, could not read ${r.files.unreadable}`,
    `lines parsed: ${r.lines.parsed}, unreadable ${r.lines.unreadable}`,
    'window: ' + (w.length ? w.join(', ') + ' (UTC unless the time has an offset)' : 'all records'),
    '',
    `failed API requests: ${f.count} (incidents ${f.incidents}: recovered ${f.recovered}, gave up ${f.gave_up}, unknown ${f.unknown})`,
    `  by kind: ${list(f.by_kind)}`,
    `  repeated records counted once: ${f.repeats_ignored}`,
    `retry give-ups: ${r.retry_give_ups}`,
    `watchdog kills: ${k.count} (last attempt ${k.last_attempt}, restarted ${k.restarted}, no final run record ${k.no_final_record})`,
    `  short stops, not counted: ${k.short_stops_not_counted}`,
    `agents lost: ${l.count}`,
    `  by reason: ${list(l.by_reason)}`,
    `  runs still marked completed: ${l.runs_marked_completed}`,
    `never reported back: ${s.count} (runs affected ${s.runs})`,
    `  completed runs with no journal to check: ${s.completed_runs_without_journal}`,
    '',
  ].join('\n');
}

export function parseArgs(argv) {
  const a = { paths: [], since: null, until: null, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--since' || x === '--until') {
      if (i + 1 >= argv.length) throw new UsageError('missing TIME after ' + x);
      a[x.slice(2)] = argv[++i];
    } else if (x === '--json') a.json = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--version') a.version = true;
    else if (x.startsWith('-') && x !== '-') throw new UsageError('unknown option ' + x);
    else a.paths.push(x);
  }
  return a;
}

export async function main(argv, out = s => process.stdout.write(s), errOut = s => process.stderr.write(s)) {
  let a;
  try {
    a = parseArgs(argv);
    if (a.help) { out(HELP); return 0; }
    if (a.version) { out(`session-counter ${VERSION}\n`); return 0; }
    if (!a.paths.length) throw new UsageError('give at least one PATH (a folder or a log file)');
    const since = a.since === null ? null : parseTime(a.since);
    const until = a.until === null ? null : parseTime(a.until);
    if (a.since !== null && since === null) throw new UsageError('cannot read time: ' + a.since);
    if (a.until !== null && until === null) throw new UsageError('cannot read time: ' + a.until);
    if (since !== null && until !== null && !(since < until)) throw new UsageError('--since must be before --until');
    const c = await count(a.paths, since, until);
    if (c.found === 0) {
      errOut('session-counter: found no Claude Code session logs there. Point it at your Claude Code projects folder, one project folder inside it, or a single session .jsonl file.\n');
      return 1;
    }
    c.result.window = { since: a.since, until: a.until };
    out(a.json ? JSON.stringify(c.result, null, 2) + '\n' : renderText(c.result));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { errOut(`session-counter: ${e.message}\nRun with --help for usage.\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; },
    e => { process.stderr.write('session-counter: unexpected error: ' + (e && e.message ? e.message : e) + '\n'); process.exitCode = 3; });
}
