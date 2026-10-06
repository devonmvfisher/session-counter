PROVENANCE: session-counter | updated 2026-10-06 CT | written by Claude (an AI coding agent) for Devon Fisher | rung now TOOL (claimed by the maker) -> target TRUSTED

Need:   Recount four failure classes (failed API requests, retry give-ups, workflow watchdog kills, workflow agents
        that were lost or never reported back) from a user's own local Claude Code session logs, so anyone can check
        the numbers in a field report against their own machine. Run by hand, by the log's owner, whenever they want.
Ours:   Two private tools by the same author, both written with an AI coding agent: an error scanner (Node, standard
        library, Oct 3 2026) that counted these classes for one session and appended them to a private ledger, and a
        workflow run checker (Node, Oct 2 2026) that found agent starts with no outcome. Neither is published. This
        repo reuses their counting rules, not their code layout.
Absorb: all ours; deps: standard library only (Node 18 or later, Python 3.8 or later)
  idea:  failed-request rule (system records with subtype api_error, once per uuid), incident chains by parentUuid,
         outcome = first assistant record after the chain (recovered) or an API error message (gave up)
         <- the private error scanner, Oct 3 2026 | source licence: own work | clean room: n/a
  idea:  watchdog rule (an attempt whose last record is the interrupt marker, 175 s or more after the record before
         it; sooner = a stop, not counted) <- the private error scanner | own work | n/a
  idea:  never-reported-back rule (a journal start with no result and no failure, in a run recorded as completed,
         and not in the run record as unfinished) <- the private run checker, Oct 2 2026 | own work | n/a
  own:   counter.mjs, counter.py, tests/, fixtures/make-synthetic-fixtures.mjs | Devon Fisher | MIT
  own:   README.md, PROVENANCE.md, fixtures/synthetic-* | Devon Fisher | CC-BY-4.0
Reject: the scanner's other rows (classifier denials, security flags, cd checks, browser calls, token totals): out of
        scope for a recount tool; its ledger file and its default paths: a public tool reads only what you point it at
        and writes nothing; time zones: everything is UTC so both languages agree without a time zone database; any
        real log line as a fixture: every fixture is synthetic.
Add:    a second, independent implementation in Python that must match the Node one byte for byte on every fixture,
        checked by a test in each suite; output holds counts only (no paths, no text from the logs).
        | Proof: see "Proof" below.
Next rung needs: one full real run opened and cited by someone other than the maker, plus the failure probe run by
someone other than the maker.

## Proof (2026-10-06, judged by the maker only)

- Tests: `node --test` 12 of 12 passed; `python -m unittest` 12 of 12 passed (Node 24, Python 3.12, Windows 11).
  Both suites check hand-worked counts on every synthetic fixture and that the two counters print the same bytes and
  exit codes on 22 cases.
- Main synthetic fixture, both counters, identical output: 15 failed requests in 4 incidents (2 recovered, 1 gave up,
  1 unknown), 1 retry give-up, 4 watchdog kills (2 last attempt, 1 restarted, 1 with no final record, 1 short stop not
  counted), 3 lost agents, 3 agents that never reported back in 2 runs.
- Real check, read-only, counts only: on the author's own logs for Oct 1 to Oct 3 2026, the Node and Python JSON
  outputs were identical, and the counts matched the earlier private scanner's figures for the same window (208
  failed requests, 54 incidents, 7 give-ups, 353 watchdog kills, 323 restarted, 17 short stops, 39 lost agents). No
  real log line was copied into this repo.
- Read-only: a test hashes every fixture file before and after both counters run; the hashes match. The counters
  open files for reading only and write nothing.
- Not yet done: a run on another person's logs, a run on macOS or Linux, Node 18 and Python 3.8.
