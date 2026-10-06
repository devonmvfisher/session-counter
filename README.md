An independent user's tool. Not affiliated with Anthropic.

# session-counter

Recount four kinds of failure from your own local Claude Code session logs: failed API requests, retry give-ups,
workflow watchdog kills, and workflow agents that were lost or never reported back. Two counters, one in Node and one
in Python, both standard library only. They follow the same rules and print the same bytes, and a test in each suite
checks that on every fixture.

## Run

```
node counter.mjs PATH
python counter.py PATH
```

Count only one stretch of time (UTC unless you add an offset):

```
node counter.mjs PATH --since 2026-10-01 --until 2026-10-04
python counter.py PATH --since 2026-10-01T00:00-05:00 --json
```

No install, no network, no dependencies. Tested on Node 24 and Python 3.12; it should run on Node 18 or later and
Python 3.8 or later, which are untested. A large folder of logs can take a few minutes, Python more than Node.

## Input

`PATH` is a folder (searched recursively) or a single log file. You can give several. Point it at your Claude Code
projects folder (it lives inside the hidden `.claude` folder in your home folder), at one project folder inside it, or
at one session `.jsonl` file.

The counter sorts files by where they sit in the layout Claude Code writes:

| File (placeholders in angle brackets) | What it is | Used for |
|---|---|---|
| `<project>/<session>.jsonl` | the main chat transcript | failed requests, incidents, give-ups |
| `<session>/subagents/workflows/<run>/agent-<id>.jsonl` | one workflow agent attempt | watchdog kills |
| `<session>/workflows/<run>.json` | a workflow run's final record | lost agents; which kills were restarted |
| `<session>/subagents/workflows/<run>/journal.jsonl` | a workflow run's journal | agents that never reported back |

Background Task agents (`<session>/subagents/agent-<id>.jsonl`) and every other file are skipped.

## Output

Text by default, JSON with `--json`. Counts only: the output never holds a path, an id or any text from your logs, so
you can paste it into a bug report. This is the text output on the synthetic fixture:

```
session-counter 0.1.0 (read-only, counts only)
files: transcripts 1, agent files 9, run records 4, journals 3, could not read 0
lines parsed: 70, unreadable 0
window: all records

failed API requests: 15 (incidents 4: recovered 2, gave up 1, unknown 1)
  by kind: connection dropped 13, timeout 2
  repeated records counted once: 2
retry give-ups: 1
watchdog kills: 4 (last attempt 2, restarted 1, no final run record 1)
  short stops, not counted: 1
agents lost: 3
  by reason: connection dropped 1, stalled (no progress) 2
  runs still marked completed: 2
never reported back: 3 (runs affected 2)
  completed runs with no journal to check: 1
```

Exit codes: 0 counted; 1 found no Claude Code logs at that path; 2 a problem with the command (a missing path, a time
it cannot read); 3 an unexpected error.

## What each count means

- **Failed API requests.** Main chat records of type `system` with subtype `api_error`, counted once per record id.
  Claude Code can write the same record more than once; those repeats are counted once and reported on their own line.
  **Incidents** chain these records through `parentUuid`: one incident is one request that failed and was retried.
  Its outcome is the first assistant record after the chain: a normal reply means **recovered**; an assistant record
  marked `isApiErrorMessage` means the client **gave up**; nothing yet means **unknown**. **By kind** sorts the client's
  error text into a few groups (connection dropped, timeout, overloaded, server error, and so on).
- **Retry give-ups.** Incidents that ended with the client giving up after its retries. An API error message shown
  without a retry chain before it is not counted here.
- **Watchdog kills.** A workflow agent attempt whose last record is the interrupt marker `[Request interrupted by
  user]`, written 175 seconds or more after the record before it. That gap is the workflow watchdog stopping an agent
  that made no progress for about 180 seconds. A marker that came sooner is a stop by the user or the app, and is
  reported as a **short stop, not counted**. Each kill is split by the run's final record: **last attempt** (the agent
  in the record), **restarted** (an earlier attempt the run replaced), or **no final run record** (the run was still
  going, or its record is missing).
- **Agents lost.** Agents in a run's final record with state `error`, grouped by the reason the record gives. **Runs
  still marked completed** counts runs whose status says `completed` although they hold a lost agent.
- **Never reported back.** In a run whose final record says `completed`: an agent the journal shows as started, with
  no result and no failure in the journal, and not listed in the record as unfinished.
- **Window.** With `--since` and `--until`, each item is counted by its own time: a failed request by its record time,
  an incident by its first failed request, a kill by its marker, a lost agent by its last progress time, and a never
  reported back agent by its run's end.

## What it cannot tell you

- **Why** a request failed. The logs keep the client's error text, not the network's or the server's side.
- That a watchdog kill was a connection problem. It means about 180 seconds passed with no model progress; a slow
  first token, a hung connection or a queued server all look the same.
- Failed requests inside workflow agents. Agent files do not keep their per-retry records, so failed requests are
  counted in main chat transcripts only.
- Totals you can add up. The classes overlap on purpose: an agent killed on its last attempt is also a lost agent.
- Anything Claude Code has already deleted. It can remove old session logs after a retention period set in its
  settings, so older counts may be gone.
- Counts for a log format it has not seen. The layout is not a documented interface and may change between Claude
  Code versions. These rules were checked against logs written in early October 2026.
- Records written out of order. Incidents are followed forward from each failed request, the way Claude Code appends
  records; an agent file is read from its end, and only its last records are parsed.

## Tests

```
node --test
python -m unittest
```

Run both from the repo folder. Each suite checks hand-worked counts on every fixture, a malformed line, an empty file,
a file with no errors, time parsing, the file layout, exit codes, that the output holds no paths or log text, that
every fixture file is byte for byte unchanged after a run, and that the Node and Python counters print the same bytes
and exit codes on 22 cases. Latest run: Node 12 of 12 passed, Python 12 of 12 passed.

## Fixtures

Every fixture is **synthetic**: made up for these tests, with invented ids, times and text, and the word `synthetic`
in each file name or folder name. None was copied from a real log. `fixtures/make-synthetic-fixtures.mjs` writes them
all, with a comment on each case:

- `fixtures/synthetic-project/`: one session with a main chat (four retry chains, repeated records, quoted look-alike
  text) and five workflow runs (kills, a short stop, lost agents, starts that never reported back, a run with no
  record, a run with no journal, a run the user stopped).
- `fixtures/synthetic-malformed.jsonl`: a cut-off line, a line that is not JSON, a JSON array and a `NaN`.
- `fixtures/synthetic-empty.jsonl`: an empty file.
- `fixtures/synthetic-no-errors.jsonl`: a chat with no errors that quotes the words the counter looks for.

## One real check

On one real set of logs (the author's own, Oct 1 to Oct 3 2026), both counters printed identical JSON, and their
counts matched an earlier, separate count made with a private scanner by the same author: 208 failed requests in 54
incidents (47 recovered, 7 give-ups), 353 watchdog kills (323 of them restarted, 17 short stops not counted) and 39 lost
agents. Those logs are not in this repo.

## Status

Version 0.1.0. Rung: TOOL (2026-10-06, claimed by its maker, an AI coding agent working for the author; evidence: the
two test suites and the real check above). Next rung needs: a review and one real run by someone other than the maker.
Where the rules came from is in `PROVENANCE.md`.

## Licence

Code (`counter.mjs`, `counter.py`, `tests/`, `fixtures/make-synthetic-fixtures.mjs`): MIT, see `LICENSE`.

Text and data (this README, `PROVENANCE.md` and the synthetic fixtures): Creative Commons Attribution 4.0
International (CC BY 4.0). Copyright (c) 2026 Devon Fisher. https://creativecommons.org/licenses/by/4.0/
