# comment-auditor — working notes for Claude

See [`README.md`](README.md) for what it is and how to run it, and the
[projects CLAUDE.md](../CLAUDE.md) for the shared traps. This file is the list
of things that will bite you, worst first.

## What this is for

Every model in the current generation over-comments, and a prose rule in
`CLAUDE.md` does not survive contact with it: instruction adherence decays
monotonically with turn count, so a style rule stated once at the top of a long
context loses to a strong pretrained prior by about the third code-writing turn.
This project converts that decaying suggestion into a per-edit check.

It is a **reporter**. The default path never writes, and the model never
decides anything on its own.

## A model label can never become a deletion

`verdictFor()` takes `by`, and only `by === 'rule'` can reach `remove`. A model
(or cached-model) label caps at `review` — reported, never applied, not even
under `--apply --force`. This is not conservatism for its own sake; it is what
the measurements below force.

Three filters run before any model call, in this order:

1. **`PROTECTED`** — linter/compiler/bundler/coverage directives, license
   headers, `TODO`/`FIXME`, JSDoc tags, `#region`. Deleting one breaks a build,
   a license, or someone's editor. Never sent, never flagged.
2. **`KEEP_RULES`** — pointers (`see CLAUDE.md`, a file path, a URL) and traps
   (`must match`, `load-bearing`, `do not "fix"`, `order matters`). These are
   settled as `keep` *before* the remove rules, because a pointer that also
   describes what the code does is still a pointer.
3. **`RULES`** — measurements, history phrasing, commented-out code, banners.
   `measured-finding` is first, so a comment that is both a measurement and a
   history note keeps the measurement.

Only what survives all three reaches `lib/classify.js`. Do not move that mapping
into the prompt — same rule as `token-monitor-core`'s naming, "get an artifact
out of a small model and derive the decision in code".

## Measured: the model cannot recognise a pointer or a trap

Run over all 42 tracked `.js`/`.lua` files in this suite — 147 comments, a
codebase already curated to these conventions:

| | |
|---|---|
| rule-backed removals | **0** |
| model `review` flags | **41** |
| of those, correct | **0** |

Every one was a genuine trap or pointer. A sample of what it wanted flagged:
*"LISTENING rows only: an ESTABLISHED row carries the \*client's\* pid"*,
*"PID reuse is the one way this could kill a bystander"*, *"Sequenced, never
concurrent: these share one records directory"*, *"Anchored at the start,
because a session may legitimately be \*about\* limitations"*. It labelled them
`restates-code` (21) and `history` (20).

Before `KEEP_RULES` existed it was worse: it flagged
*"Usage is per `message.id`, never per JSONL line — see CLAUDE.md"* and
*"Must match `statusline.js`'s `fmtCostShort`"* as `restates-code` at confidence
**1.0**, and — before the `measured-finding` rule — voted to delete *"Measured
at 8ms per tick against the active set on a 5-second loop"*, also at 1.0.

The zero rule-removals figure is the tool working: this repo has nothing to
delete, and it said so.

## Precision is a base-rate problem, so scope the audit

The same model on a synthetic over-commented file *did* correctly flag
"Load the config", "Create an empty object to hold the counts", "Increment the
count for this item". It is not uniformly useless — it is useless when the base
rate of bad comments is near zero, which is exactly what a whole curated file
is.

**So audit the comments that were just written, not the file.** `auditSource`
takes `lines: [[from, to], ...]` and `audit.js` takes `--lines 12,40-58`;
`scanned` then counts what was in scope and `inFile` what was skipped. The
PostToolUse surface must pass the ranges it just changed. A surface that audits
whole files will drown its reader in false positives and be turned off within a
day.

Rules alone do not catch a plain restatement ("Load the config"), which is the
single most common thing a model writes — so the model pass earns its place,
but only inside a narrow scope.

## Measured: the model's confidence is not calibrated

Five identical runs over one fixture at `temperature: 0.1` returned **2 findings
at confidence 0.5 four times, and 4 findings at confidence 1.0 once**. Same
input, same model.

`MIN_CONFIDENCE` is therefore not a safety mechanism — the wrong answers above
arrived at 1.0. It survives only as a second-order filter on rule confidence.
The real protection is that a model label cannot reach `remove` at all.

**Recall is unstable too**, 2–4 of 5 true positives per run. A clean report
means "nothing found this time", never "there is nothing here". Do not build a
gate that treats silence as a pass.

`measured-finding` maps to `relocate`, never `remove` — reported so it can be
moved into a `CLAUDE.md`, and not deleted even under `--apply --force`.

## The 3B model does not answer twice the same

`lib/cache.js` keys verdicts on `sha256(comment + code)`, so an untouched
comment keeps its first answer and an edited one is re-asked. This exists for
consistency, not for speed: without it the same file audited twice across two
edits gives different advice, which reads as the tool being broken.

A useful property falls out of it — recall **accumulates**. Measured over four
consecutive runs of one fixture: 4 findings, then 5 (one fresh answer added),
then 5, then 5, fully cached and stable. Misses get re-asked, hits are
remembered, so repeated audits converge upward rather than drifting.

A wrong verdict is therefore also sticky. `--no-cache` re-asks; deleting
`state/verdict-cache.json` resets everything.

## The scanner is a state machine, not a regex

`lib/scanner.js` tracks strings, template literals (including comments inside
`${...}`), JS regex literals, Lua long brackets and PowerShell `<# #>`. A regex
over `//` deletes the tail of any string containing one — a URL, a path, a
regex — and that is silent data loss in a tool whose whole job is deleting
text. `test.js` covers each of those cases; keep them.

The one known ambiguity is JS `/` after `)`: `if (x) /re/.test(y)` is a regex,
`(a + b) / c` is division, and `regexCanFollow()` guesses division. That can
only ever cause a **missed** comment, never a wrongly-deleted one, which is the
correct direction to fail.

**Consecutive line comments are one unit.** The model judges an argument, and
deleting half of one leaves nonsense. A consequence worth knowing: if any line
of a group trips a rule, the whole group is settled by that rule and never
reaches the model.

## The autonomous path

`--apply` exists and is gated. `lib/quiescence.js` answers "may a background
process write this file right now?" and **unknown is never ok** — a missing or
stale `status.json` blocks the write, because the failure it prevents is
corrupting a file someone is mid-edit on.

Three signals, in order:

| Signal | Source | Blocks when |
|---|---|---|
| `git` | a `.git` above the file | absent — an unwanted delete would be unrecoverable |
| `per-file` | `session.recent_writes` in `status.json` | this path was written < `QUIESCENT_MS` ago |
| `session-wide` | `session.last_activity` | any live session was active < `QUIESCENT_MS` ago |

`per-file` needs a watcher new enough to emit `recent_writes`; on an older one
it degrades to `session-wide`, which is correct but coarse — it blocks writes to
*every* file while any session is awake.

**Why the advisory path is the default.** A background rewrite races Claude
Code's editor: `Edit` requires an exact `old_string` match against a copy the
model holds in context, so a third-party write between read and edit fails the
edit, and the natural recovery is for the model to re-apply its intent — putting
the comments back. Two writers, no shared lock. The advisory path has exactly
one writer.

**If you wire this into the watcher**, that is the thing to preserve: the
watcher may *decide*, but the quiescence gate is what makes the write safe, and
it must stay on the write itself rather than being checked once per tick.

## Core changes this depends on

`packages/token-monitor-core` gained two additive things. Both tolerate an older
consumer, and nothing else reads them yet:

- `lib/transcript.js` returns `fileWrites: [{ path, at }]` from
  `Write`/`Edit`/`MultiEdit`/`NotebookEdit` tool calls.
- `watcher.js` folds subagent writes into the parent (same race, same file) and
  emits `recent_writes` per session in `status.json`, newest-per-path within
  `RECENT_WRITES_WINDOW_MS`.

The path in `recent_writes` is whatever the tool was handed, so it can be
relative. `lib/quiescence.js` resolves and lower-cases both sides before
comparing; do not compare them raw.

## Known limitations

- **Recall is not a guarantee** — see the measured note above.
- **Removing a comment can leave a double blank line.** Left to the formatter
  on purpose; collapsing whitespace correctly is a second problem and getting it
  wrong is worse than the blank line.
- **Whole-file context is capped** at `MAX_FILE_CHARS` (6000, sized for
  llama3.2's 4096-token window). Past that each comment gets a window instead,
  so a comment whose justification lives elsewhere in a large file may be
  misjudged. It fails toward `unclear`, which is `keep`.
- **`--apply` is line-based, not AST-based.** It only ever deletes ranges the
  scanner produced, so it cannot corrupt syntax, but it also cannot rewrite a
  bad comment into a good one. Rewriting is deliberately not offered: that is
  prose, and this model does not write prose that ships.
- **No surfaces yet.** The PostToolUse hook and the nvim integration are the
  next step; this is the headless core they will both call. The hook must pass
  `--lines` for the ranges it changed — see the base-rate section above, which
  is the difference between a useful hook and one that gets switched off.
