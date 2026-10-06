#!/usr/bin/env python3
"""session-counter (Python version). Recounts failures in your own Claude Code session logs.

Standard library only. Reads only, writes nothing, prints counts only (never paths or log text).
The Node version (counter.mjs) follows the same rules line for line; the tests check that both
print the same bytes on every fixture.
"""
# SPDX-License-Identifier: MIT

import json
import math
import os
import re
import stat
import sys
from collections import deque

VERSION = '0.1.0'
MARKER = '[Request interrupted by user]'
KILL_MS = 175000  # an interrupt this long after the record before it is a watchdog kill
TAIL = 200        # agent files are read from the end; this many non-blank lines are kept
FOLLOW_DEPTH = 40  # how far to follow records after a retry chain to find its outcome

HELP = """session-counter {v}: recount failures in your own Claude Code session logs.

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
""".format(v=VERSION)

# ------------------------------------------------------------------ time (UTC, no time zone database)
RX_TIME = re.compile(r'([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?')


def days_from_civil(y, m, d):
    y -= 1 if m <= 2 else 0
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def parse_time(s):
    """Milliseconds since 1970-01-01 UTC, or None when the text is not a time this tool reads."""
    if not isinstance(s, str):
        return None
    m = RX_TIME.fullmatch(s)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    h = int(m.group(4)) if m.group(4) is not None else 0
    mi = int(m.group(5)) if m.group(5) is not None else 0
    se = int(m.group(6)) if m.group(6) is not None else 0
    ms = int((m.group(7) + '00')[:3]) if m.group(7) is not None else 0
    if mo < 1 or mo > 12 or d < 1 or d > 31 or h > 23 or mi > 59 or se > 59:
        return None
    off = 0
    z = m.group(8)
    if z is not None and z != 'Z':
        digits = z[1:].replace(':', '', 1)
        oh, om = int(digits[0:2]), int(digits[2:4])
        if oh > 23 or om > 59:
            return None
        off = (-1 if z[0] == '-' else 1) * (oh * 60 + om) * 60000
    return days_from_civil(y, mo, d) * 86400000 + h * 3600000 + mi * 60000 + se * 1000 + ms - off


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def is_obj(x):
    return isinstance(x, dict)


def as_str(x):
    return x if isinstance(x, str) else None


def time_of(v):
    return v if is_num(v) else parse_time(v)


# ------------------------------------------------------------------ error kinds
_F = re.ASCII | re.IGNORECASE
KINDS = [
    (re.compile(r'no progress for|^[ \t]*stalled', _F), 'stalled (no progress)'),
    (re.compile(r'ECONNRESET|connection dropped|socket hang up', _F), 'connection dropped'),
    (re.compile(r'\b408\b|timed out|timeout', _F), 'timeout'),
    (re.compile(r'\b529\b|overloaded', _F), 'overloaded (529)'),
    (re.compile(r'\b429\b|rate[ _-]?limit', _F), 'rate limited (429)'),
    (re.compile(r'\b5[0-9][0-9]\b', re.ASCII), 'server error (5xx)'),
    (re.compile(r'\b40[13]\b|authentication|unauthori[sz]ed|forbidden', _F), 'authentication (401 or 403)'),
    (re.compile(r"ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|cannot reach|can't reach", _F), 'cannot reach the API'),
    (re.compile(r'\b400\b|invalid[ _]request', _F), 'bad request (400)'),
]


def classify(text):
    t = text if isinstance(text, str) else ''
    for rx, label in KINDS:
        if rx.search(t):
            return label
    return 'other'


def error_text(e):
    if isinstance(e, str):
        return e
    if is_obj(e):
        if isinstance(e.get('formatted'), str) and e.get('formatted') != '':
            return e['formatted']
        if isinstance(e.get('message'), str):
            return e['message']
    return ''


# ------------------------------------------------------------------ reading
BAD = object()


def _no_constant(name):
    raise ValueError('not JSON: ' + name)


def parse_line(line):
    try:
        return json.loads(line, parse_constant=_no_constant)
    except (ValueError, RecursionError):
        return BAD


_BLANK = re.compile(r'[ \t\r\n]*')


def is_blank(line):
    return _BLANK.fullmatch(line) is not None


def open_text(f):
    return open(f, 'r', encoding='utf-8', errors='replace', newline=None)


def norm_abs(p):
    return os.path.abspath(p).replace(os.sep, '/')


def role_of(abs_path):
    """Sorts one file into a role by its place in the Claude Code layout (see counter.mjs)."""
    segs = abs_path.split('/')
    n = len(segs)
    name = segs[n - 1]
    under_run = n >= 4 and segs[n - 3] == 'workflows' and segs[n - 4] == 'subagents'
    if re.fullmatch(r'agent-.+\.jsonl', name, re.DOTALL):
        if not under_run:
            return None
        return {'role': 'attempt', 'run': '/'.join(segs[:n - 4]) + '\u0000' + segs[n - 2], 'agentId': name[6:-6]}
    if name == 'journal.jsonl':
        if not under_run:
            return None
        return {'role': 'journal', 'run': '/'.join(segs[:n - 4]) + '\u0000' + segs[n - 2]}
    if re.fullmatch(r'wf_.+\.json', name, re.DOTALL):
        if not (n >= 2 and segs[n - 2] == 'workflows') or (n >= 3 and segs[n - 3] == 'subagents'):
            return None
        return {'role': 'record', 'run': '/'.join(segs[:n - 2]) + '\u0000' + name[:-5]}
    if name.endswith('.jsonl'):
        return {'role': 'transcript'}
    return None


def walk(abs_path, out, stats):
    try:
        ents = list(os.scandir(abs_path))
    except OSError:
        stats['unreadable'] += 1
        return
    for e in ents:
        child = (abs_path if abs_path.endswith('/') else abs_path + '/') + e.name
        try:
            if e.is_dir(follow_symlinks=False):
                walk(child, out, stats)
            elif e.is_file(follow_symlinks=False):
                out.append(child)
        except OSError:
            stats['unreadable'] += 1


class UsageError(Exception):
    pass


def collect(paths, stats):
    seen = set()
    files = []
    for p in paths:
        abs_path = norm_abs(p)
        try:
            st = os.stat(abs_path)
        except OSError:
            raise UsageError('no such file or folder: ' + p)
        found = []
        if stat.S_ISDIR(st.st_mode):
            walk(abs_path, found, stats)
        elif stat.S_ISREG(st.st_mode):
            found.append(abs_path)
        for f in found:
            if f not in seen:
                seen.add(f)
                files.append(f)
    files.sort()
    out = {'transcripts': [], 'attempts': [], 'journals': [], 'records': []}
    for f in files:
        r = role_of(f)
        if not r:
            continue
        r['file'] = f
        out[r['role'] + 's'].append(r)
    return out


# ------------------------------------------------------------------ the count
def count(paths, since=None, until=None):
    windowed = since is not None or until is not None

    def in_win(ms):
        return (not windowed) or (ms is not None and (since is None or ms >= since) and (until is None or ms < until))

    stats = {'unreadable': 0, 'parsed': 0, 'bad': 0}
    found = collect(paths, stats)

    # 1. main chat: failed requests, incidents, give-ups
    err = {}      # uuid -> {parent, ms, kind}
    repeats = {}  # uuid -> times seen
    watch = set()
    info = {}     # uuid -> 'error' | 'gave_up' | 'reply' | 'other'
    kids = {}     # parent uuid -> [child uuid]
    for t in found['transcripts']:
        try:
            fh = open_text(t['file'])
        except OSError:
            stats['unreadable'] += 1
            continue
        with fh:
            for line in fh:
                if is_blank(line):
                    continue
                stats['parsed'] += 1
                o = parse_line(line)
                if not is_obj(o):
                    stats['bad'] += 1
                    continue
                uuid = as_str(o.get('uuid'))
                is_err = o.get('type') == 'system' and o.get('subtype') == 'api_error'
                if is_err and uuid is not None:
                    repeats[uuid] = repeats.get(uuid, 0) + 1
                    if uuid not in err:
                        err[uuid] = {'parent': as_str(o.get('parentUuid')), 'ms': parse_time(o.get('timestamp')),
                                     'kind': classify(error_text(o.get('error')))}
                        watch.add(uuid)
                parent = as_str(o.get('parentUuid'))
                if parent is not None and uuid is not None and parent in watch and uuid not in info:
                    if is_err:
                        kind = 'error'
                    elif o.get('type') == 'assistant':
                        kind = 'gave_up' if o.get('isApiErrorMessage') is True else 'reply'
                    else:
                        kind = 'other'
                    info[uuid] = kind
                    kids.setdefault(parent, []).append(uuid)
                    if kind in ('error', 'other'):
                        watch.add(uuid)

    def follow(u, depth):
        for c in kids.get(u, []):
            if c in err:
                continue
            k = info.get(c)
            if k in ('reply', 'gave_up'):
                return k
            if depth < FOLLOW_DEPTH:
                r = follow(c, depth + 1)
                if r is not None:
                    return r
        return None

    failed = {'count': 0, 'by_kind': {}, 'repeats_ignored': 0, 'incidents': 0, 'recovered': 0, 'gave_up': 0, 'unknown': 0}
    for u, e in err.items():
        if in_win(e['ms']):
            failed['count'] += 1
            failed['by_kind'][e['kind']] = failed['by_kind'].get(e['kind'], 0) + 1
            failed['repeats_ignored'] += repeats[u] - 1
        if e['parent'] is not None and e['parent'] in err:
            continue  # not the first error of its chain
        seq = [u]
        in_seq = {u}
        while True:
            nx = next((c for c in kids.get(seq[-1], []) if c in err and c not in in_seq), None)
            if nx is None:
                break
            seq.append(nx)
            in_seq.add(nx)
        if not in_win(e['ms']):
            continue
        failed['incidents'] += 1
        end = follow(seq[-1], 0)
        if end == 'reply':
            failed['recovered'] += 1
        elif end == 'gave_up':
            failed['gave_up'] += 1
        else:
            failed['unknown'] += 1
    failed['by_kind'] = sort_keys(failed['by_kind'])

    # 2. workflows: records, journals, attempts
    runs = {}

    def run_of(k):
        if k not in runs:
            runs[k] = {'record': None, 'journal': None}
        return runs[k]

    for r in found['records']:
        o = BAD
        try:
            with open_text(r['file']) as fh:
                o = parse_line(fh.read())
        except OSError:
            o = BAD
        if not is_obj(o):
            stats['unreadable'] += 1
            continue
        run_of(r['run'])['record'] = o
    for j in found['journals']:
        try:
            fh = open_text(j['file'])
        except OSError:
            stats['unreadable'] += 1
            continue
        started, results, failed_keys = {}, set(), set()
        with fh:
            for line in fh:
                if is_blank(line):
                    continue
                stats['parsed'] += 1
                o = parse_line(line)
                if not is_obj(o):
                    stats['bad'] += 1
                    continue
                key = 's:' + o['key'] if isinstance(o.get('key'), str) else 'none'
                typ = o.get('type')
                if typ == 'started':
                    started.setdefault(key, []).append(as_str(o.get('agentId')))
                elif typ == 'result':
                    results.add(key)
                elif typ == 'failed':
                    failed_keys.add(key)
        run_of(j['run'])['journal'] = {'started': started, 'results': results, 'failed': failed_keys}

    def agents_of(rec):
        wp = rec.get('workflowProgress')
        return [p for p in (wp if isinstance(wp, list) else []) if is_obj(p) and p.get('type') == 'workflow_agent']

    kills = {'count': 0, 'last_attempt': 0, 'restarted': 0, 'no_final_record': 0, 'short_stops_not_counted': 0}
    for a in found['attempts']:
        try:
            fh = open_text(a['file'])
        except OSError:
            stats['unreadable'] += 1
            continue
        with fh:
            lines = deque((ln for ln in fh if not is_blank(ln)), maxlen=TAIL)
        tail = []  # newest first, records with a readable timestamp
        for line in reversed(lines):
            if len(tail) >= 2:
                break
            stats['parsed'] += 1
            o = parse_line(line)
            if not is_obj(o):
                stats['bad'] += 1
                continue
            ms = parse_time(o.get('timestamp'))
            if ms is not None:
                tail.append((o, ms))
        if len(tail) < 2 or not is_marker(tail[0][0]):
            continue
        if not in_win(tail[0][1]):
            continue
        if tail[0][1] - tail[1][1] < KILL_MS:
            kills['short_stops_not_counted'] += 1
            continue
        kills['count'] += 1
        run = runs.get(a['run'])
        if run is None or run['record'] is None:
            kills['no_final_record'] += 1
        elif any(as_str(p.get('agentId')) == a['agentId'] for p in agents_of(run['record'])):
            kills['last_attempt'] += 1
        else:
            kills['restarted'] += 1

    lost = {'count': 0, 'by_reason': {}, 'runs_marked_completed': 0}
    silent = {'count': 0, 'runs': 0, 'completed_runs_without_journal': 0}
    for k in sorted(runs.keys()):
        rec, journal = runs[k]['record'], runs[k]['journal']
        if rec is None:
            continue
        agents = agents_of(rec)
        lost_here = 0
        for p in agents:
            if p.get('state') != 'error':
                continue
            if not in_win(time_of(p.get('lastProgressAt'))):
                continue
            e = p.get('error')
            why = classify(e if isinstance(e, str) and e != '' else as_str(p.get('lastAttemptReason')))
            lost['count'] += 1
            lost_here += 1
            lost['by_reason'][why] = lost['by_reason'].get(why, 0) + 1
        if rec.get('status') == 'completed' and lost_here > 0:
            lost['runs_marked_completed'] += 1
        if rec.get('status') != 'completed':
            continue
        st, du = rec.get('startTime'), rec.get('durationMs')
        end_ms = (st + (du if is_num(du) else 0)) if is_num(st) else None
        if not in_win(end_ms):
            continue
        if journal is None:
            silent['completed_runs_without_journal'] += 1
            continue
        n = 0
        for key, ids in journal['started'].items():
            if key in journal['results'] or key in journal['failed']:
                continue
            last = ids[-1]
            if not any(last is not None and as_str(p.get('agentId')) == last and p.get('state') != 'done' for p in agents):
                n += 1
        if n > 0:
            silent['count'] += n
            silent['runs'] += 1
    lost['by_reason'] = sort_keys(lost['by_reason'])

    found_n = len(found['transcripts']) + len(found['attempts']) + len(found['records']) + len(found['journals'])
    result = {
        'tool': 'session-counter',
        'version': VERSION,
        'window': {'since': None, 'until': None},
        'files': {'transcripts': len(found['transcripts']), 'agent_files': len(found['attempts']),
                  'run_records': len(found['records']), 'journals': len(found['journals']), 'unreadable': stats['unreadable']},
        'lines': {'parsed': stats['parsed'], 'unreadable': stats['bad']},
        'failed_requests': failed,
        'retry_give_ups': failed['gave_up'],
        'watchdog_kills': kills,
        'agents_lost': lost,
        'never_reported_back': silent,
    }
    return found_n, result


def is_marker(o):
    msg = o.get('message')
    if o.get('type') != 'user' or not is_obj(msg) or not isinstance(msg.get('content'), list):
        return False
    c = msg['content']
    if any(is_obj(b) and b.get('type') == 'tool_result' for b in c):
        return False
    return any(is_obj(b) and b.get('type') == 'text' and b.get('text') == MARKER for b in c)


def sort_keys(o):
    return {k: o[k] for k in sorted(o.keys())}


# ------------------------------------------------------------------ output
def _list(o):
    return ', '.join('%s %s' % (k, v) for k, v in o.items()) or 'none'


def render_text(r):
    f, k, l, s = r['failed_requests'], r['watchdog_kills'], r['agents_lost'], r['never_reported_back']
    w = []
    if r['window']['since'] is not None:
        w.append('since ' + r['window']['since'])
    if r['window']['until'] is not None:
        w.append('until ' + r['window']['until'])
    return '\n'.join([
        'session-counter %s (read-only, counts only)' % r['version'],
        'files: transcripts %d, agent files %d, run records %d, journals %d, could not read %d' % (
            r['files']['transcripts'], r['files']['agent_files'], r['files']['run_records'], r['files']['journals'], r['files']['unreadable']),
        'lines parsed: %d, unreadable %d' % (r['lines']['parsed'], r['lines']['unreadable']),
        'window: ' + (', '.join(w) + ' (UTC unless the time has an offset)' if w else 'all records'),
        '',
        'failed API requests: %d (incidents %d: recovered %d, gave up %d, unknown %d)' % (
            f['count'], f['incidents'], f['recovered'], f['gave_up'], f['unknown']),
        '  by kind: ' + _list(f['by_kind']),
        '  repeated records counted once: %d' % f['repeats_ignored'],
        'retry give-ups: %d' % r['retry_give_ups'],
        'watchdog kills: %d (last attempt %d, restarted %d, no final run record %d)' % (
            k['count'], k['last_attempt'], k['restarted'], k['no_final_record']),
        '  short stops, not counted: %d' % k['short_stops_not_counted'],
        'agents lost: %d' % l['count'],
        '  by reason: ' + _list(l['by_reason']),
        '  runs still marked completed: %d' % l['runs_marked_completed'],
        'never reported back: %d (runs affected %d)' % (s['count'], s['runs']),
        '  completed runs with no journal to check: %d' % s['completed_runs_without_journal'],
        '',
    ])


def parse_args(argv):
    a = {'paths': [], 'since': None, 'until': None, 'json': False, 'help': False, 'version': False}
    i = 0
    while i < len(argv):
        x = argv[i]
        if x in ('--since', '--until'):
            if i + 1 >= len(argv):
                raise UsageError('missing TIME after ' + x)
            i += 1
            a[x[2:]] = argv[i]
        elif x == '--json':
            a['json'] = True
        elif x in ('--help', '-h'):
            a['help'] = True
        elif x == '--version':
            a['version'] = True
        elif x.startswith('-') and x != '-':
            raise UsageError('unknown option ' + x)
        else:
            a['paths'].append(x)
        i += 1
    return a


def main(argv, out=None, err_out=None):
    out = out or sys.stdout.write
    err_out = err_out or sys.stderr.write
    try:
        a = parse_args(argv)
        if a['help']:
            out(HELP)
            return 0
        if a['version']:
            out('session-counter %s\n' % VERSION)
            return 0
        if not a['paths']:
            raise UsageError('give at least one PATH (a folder or a log file)')
        since = None if a['since'] is None else parse_time(a['since'])
        until = None if a['until'] is None else parse_time(a['until'])
        if a['since'] is not None and since is None:
            raise UsageError('cannot read time: ' + a['since'])
        if a['until'] is not None and until is None:
            raise UsageError('cannot read time: ' + a['until'])
        if since is not None and until is not None and not since < until:
            raise UsageError('--since must be before --until')
        found_n, result = count(a['paths'], since, until)
        if found_n == 0:
            err_out('session-counter: found no Claude Code session logs there. Point it at your Claude Code projects '
                    'folder, one project folder inside it, or a single session .jsonl file.\n')
            return 1
        result['window'] = {'since': a['since'], 'until': a['until']}
        out(json.dumps(result, indent=2, ensure_ascii=False) + '\n' if a['json'] else render_text(result))
        return 0
    except UsageError as e:
        err_out('session-counter: %s\nRun with --help for usage.\n' % e)
        return 2


if __name__ == '__main__':
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(newline='\n')  # same bytes as the Node version on every platform
        except (AttributeError, ValueError):
            pass
    try:
        code = main(sys.argv[1:])
    except Exception as exc:  # plain words, not a stack trace
        sys.stderr.write('session-counter: unexpected error: %s\n' % exc)
        code = 3
    sys.exit(code)
