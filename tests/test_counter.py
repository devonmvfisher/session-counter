# Tests for session-counter on SYNTHETIC fixtures only (no real log is read).
# Run from the repo folder: python -m unittest
# SPDX-License-Identifier: MIT
import calendar
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
_spec = importlib.util.spec_from_file_location('session_counter', os.path.join(ROOT, 'counter.py'))
counter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(counter)


def fx(p):
    return os.path.join(ROOT, 'fixtures', p)


def utc(*a):
    a = list(a) + [0] * (6 - len(a))
    return calendar.timegm(tuple(a) + (0, 0, 0)) * 1000


ZERO_FAILED = {'count': 0, 'by_kind': {}, 'repeats_ignored': 0, 'incidents': 0, 'recovered': 0, 'gave_up': 0, 'unknown': 0}
ZERO_KILLS = {'count': 0, 'last_attempt': 0, 'restarted': 0, 'no_final_record': 0, 'short_stops_not_counted': 0}
ZERO_LOST = {'count': 0, 'by_reason': {}, 'runs_marked_completed': 0}
ZERO_SILENT = {'count': 0, 'runs': 0, 'completed_runs_without_journal': 0}
ONE_FILE = {'transcripts': 1, 'agent_files': 0, 'run_records': 0, 'journals': 0, 'unreadable': 0}
PROJECT_FILES = {'transcripts': 1, 'agent_files': 9, 'run_records': 4, 'journals': 3, 'unreadable': 0}


def base(files, lines, **rest):
    d = {'tool': 'session-counter', 'version': '0.1.0', 'window': {'since': None, 'until': None}, 'files': files, 'lines': lines}
    d.update(rest)
    return d


# Hand-derived from the comments in fixtures/make-synthetic-fixtures.mjs (the same numbers as the Node tests).
EXPECT_MAIN = base(
    PROJECT_FILES, {'parsed': 70, 'unreadable': 0},
    failed_requests={'count': 15, 'by_kind': {'connection dropped': 13, 'timeout': 2}, 'repeats_ignored': 2, 'incidents': 4,
                     'recovered': 2, 'gave_up': 1, 'unknown': 1},
    retry_give_ups=1,
    watchdog_kills={'count': 4, 'last_attempt': 2, 'restarted': 1, 'no_final_record': 1, 'short_stops_not_counted': 1},
    agents_lost={'count': 3, 'by_reason': {'connection dropped': 1, 'stalled (no progress)': 2}, 'runs_marked_completed': 2},
    never_reported_back={'count': 3, 'runs': 2, 'completed_runs_without_journal': 1},
)
EXPECT_DAY = base(
    PROJECT_FILES, {'parsed': 70, 'unreadable': 0},
    failed_requests={'count': 14, 'by_kind': {'connection dropped': 12, 'timeout': 2}, 'repeats_ignored': 2, 'incidents': 3,
                     'recovered': 1, 'gave_up': 1, 'unknown': 1},
    retry_give_ups=1,
    watchdog_kills={'count': 3, 'last_attempt': 1, 'restarted': 1, 'no_final_record': 1, 'short_stops_not_counted': 1},
    agents_lost={'count': 2, 'by_reason': {'connection dropped': 1, 'stalled (no progress)': 1}, 'runs_marked_completed': 1},
    never_reported_back={'count': 2, 'runs': 1, 'completed_runs_without_journal': 1},
)

# Every fixture, plus the error paths (the same list as tests/counter.test.mjs).
CASES = [
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
]


def run_py(args):
    return subprocess.run([sys.executable, os.path.join(ROOT, 'counter.py')] + args, cwd=ROOT, capture_output=True)


NODE = shutil.which('node')


def run_node(args):
    return subprocess.run([NODE, os.path.join(ROOT, 'counter.mjs')] + args, cwd=ROOT, capture_output=True)


class Counts(unittest.TestCase):
    maxDiff = None

    def test_main_fixture_every_count(self):
        found, result = counter.count([fx('synthetic-project')])
        self.assertEqual(found, 17)
        self.assertEqual(result, EXPECT_MAIN)

    def test_main_fixture_one_utc_day(self):
        found, result = counter.count([fx('synthetic-project')], counter.parse_time('2026-01-15'), counter.parse_time('2026-01-16'))
        self.assertEqual(result, EXPECT_DAY)

    def test_malformed_lines_skipped_and_counted(self):
        _, result = counter.count([fx('synthetic-malformed.jsonl')])
        self.assertEqual(result, base(
            ONE_FILE, {'parsed': 7, 'unreadable': 4},
            failed_requests={'count': 1, 'by_kind': {'connection dropped': 1}, 'repeats_ignored': 0, 'incidents': 1,
                             'recovered': 1, 'gave_up': 0, 'unknown': 0},
            retry_give_ups=0, watchdog_kills=ZERO_KILLS, agents_lost=ZERO_LOST, never_reported_back=ZERO_SILENT))

    def test_empty_file(self):
        _, result = counter.count([fx('synthetic-empty.jsonl')])
        self.assertEqual(result, base(ONE_FILE, {'parsed': 0, 'unreadable': 0}, failed_requests=ZERO_FAILED, retry_give_ups=0,
                                      watchdog_kills=ZERO_KILLS, agents_lost=ZERO_LOST, never_reported_back=ZERO_SILENT))

    def test_file_with_no_errors(self):
        _, result = counter.count([fx('synthetic-no-errors.jsonl')])
        self.assertEqual(result, base(ONE_FILE, {'parsed': 6, 'unreadable': 0}, failed_requests=ZERO_FAILED, retry_give_ups=0,
                                      watchdog_kills=ZERO_KILLS, agents_lost=ZERO_LOST, never_reported_back=ZERO_SILENT))


class Parts(unittest.TestCase):
    def test_times(self):
        p = counter.parse_time
        self.assertEqual(p('2026-01-15'), utc(2026, 1, 15))
        self.assertEqual(p('2026-01-15T10:01:00.000Z'), utc(2026, 1, 15, 10, 1))
        self.assertEqual(p('2026-01-15T00:00-06:00'), utc(2026, 1, 15, 6))
        self.assertEqual(p('2024-02-29T23:59:59.5+0100'), utc(2024, 2, 29, 22, 59, 59) + 500)
        self.assertEqual(p('1999-12-31 23:59'), utc(1999, 12, 31, 23, 59))
        for bad in ['', 'now', '2026-13-01', '2026-01-15T24:00', '2026-01-15T10:00+25:00', '15/01/2026', None, 1234]:
            self.assertIsNone(p(bad), bad)

    def test_error_kinds(self):
        self.assertEqual([counter.classify(t) for t in [
            'Connection dropped (ECONNRESET)', '408 Request timeout', 'Request timed out', 'stalled: no progress for 180000ms',
            '529 overloaded', 'HTTP 503', '401 authentication failed', 'getaddrinfo ENOTFOUND', '400 bad', 'mystery', '']],
            ['connection dropped', 'timeout', 'timeout', 'stalled (no progress)', 'overloaded (529)', 'server error (5xx)',
             'authentication (401 or 403)', 'cannot reach the API', 'bad request (400)', 'other', 'other'])

    def test_file_roles(self):
        r = counter.role_of
        self.assertEqual(r('p/s.jsonl')['role'], 'transcript')
        self.assertEqual(r('p/s/subagents/workflows/wf_1/agent-x.jsonl')['role'], 'attempt')
        self.assertEqual(r('p/s/subagents/workflows/wf_1/agent-x.jsonl')['agentId'], 'x')
        self.assertEqual(r('p/s/subagents/workflows/wf_1/journal.jsonl')['role'], 'journal')
        self.assertEqual(r('p/s/workflows/wf_1.json')['role'], 'record')
        self.assertIsNone(r('p/s/subagents/agent-task.jsonl'))
        self.assertIsNone(r('p/s/subagents/workflows/wf_1/agent-x.meta.json'))
        self.assertIsNone(r('p/notes.txt'))


class CommandLine(unittest.TestCase):
    maxDiff = None

    def test_exit_codes_and_errors(self):
        self.assertEqual(run_py(['fixtures/synthetic-project']).returncode, 0)
        self.assertEqual(run_py(['--help']).returncode, 0)
        missing = run_py(['no-such-folder-synthetic'])
        self.assertEqual(missing.returncode, 2)
        self.assertIn(b'no such file or folder', missing.stderr)
        none = run_py(['tests'])
        self.assertEqual(none.returncode, 1)
        self.assertIn(b'found no Claude Code session logs', none.stderr)
        self.assertEqual(run_py(['fixtures', '--since', 'not-a-time']).returncode, 2)
        self.assertEqual(run_py(['fixtures', '--since', '2026-01-16', '--until', '2026-01-15']).returncode, 2)
        self.assertEqual(run_py([]).returncode, 2)
        self.assertEqual(json.loads(run_py(['fixtures/synthetic-project', '--json']).stdout.decode('utf-8')), EXPECT_MAIN)

    def test_output_holds_counts_only(self):
        import re
        for args in (['fixtures'], ['fixtures', '--json']):
            out = run_py(args).stdout.decode('utf-8')
            self.assertIsNone(re.search(r'synthetic|fixtures|wf_|agent-|0000-4000|[A-Za-z]:[\\/]|/home/', out), args)

    def test_read_only(self):
        files = []
        for d, _, names in os.walk(os.path.join(ROOT, 'fixtures')):
            files += [os.path.join(d, n) for n in names]
        files.sort()

        def digest():
            out = []
            for f in files:
                with open(f, 'rb') as fh:
                    out.append(hashlib.sha256(fh.read()).hexdigest())
            return out
        before = digest()
        run_py(['fixtures'])
        run_py(['fixtures', '--json'])
        if NODE:
            run_node(['fixtures'])
            run_node(['fixtures', '--json'])
        self.assertEqual(digest(), before)

    @unittest.skipIf(NODE is None, 'no node found on PATH')
    def test_same_bytes_as_node_on_every_case(self):
        for args in CASES:
            a, b = run_node(args), run_py(args)
            self.assertEqual(b.returncode, a.returncode, 'exit code for %s' % args)
            self.assertEqual(b.stdout, a.stdout, 'stdout for %s' % args)
            self.assertEqual(b.stderr, a.stderr, 'stderr for %s' % args)


if __name__ == '__main__':
    unittest.main()
