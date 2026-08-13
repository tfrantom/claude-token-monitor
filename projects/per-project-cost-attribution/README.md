# per-project-cost-attribution

**Status: built.** `node attribute.js` answers "how much did building this
suite actually cost" (and the same for any other project on this machine),
broken down by real project — not by Claude Code's coarse per-terminal
`C--projects` grouping.

```
$ node attribute.js
per-project cost attribution -- 7 sessions, all history

project                  cost      %  turns  sess  out(think/write/tool)     cache r/w  last
--------------------  -------  -----  -----  ----  ---------------------  ------------  ----------------
some-big-repo            $110  78.9%    919     2    197.4k/33.7k/345.6k   209.0M/3.8M  2026-08-06 04:38
projects (root)        $15.27  11.0%    192     7      74.5k/12.2k/70.4k  22.7M/875.9k  2026-08-06 04:34
notes                   $7.51   5.4%     24     1        3.8k/2.2k/19.0k   12.8M/48.1k  2026-08-06 04:23
...
```

## Files

| File | What it does |
|---|---|
| `attribute.js` | CLI. Rollups, filters, three output modes. `--help` for flags. |
| `verify.js` | Verification harness — run it after any change (see below). |
| `config.js` | Workspace roots, project-name overrides, paths. |
| `lib/attribute.js` | Independent transcript parse + per-turn cwd attribution. |
| `lib/project-map.js` | cwd → project resolution. |
| `lib/sources.js` | Transcript discovery (incl. subagents) + `status.json` read. |
| `lib/report.js` | The shared slice schema, rollup, and cross-session sums. |

Nothing under `packages/` was modified. Two read-only `require()`s point at
it: `lib/pricing.js` (deliberately not re-implemented — a second copy of the
rate table is a silent-drift bug) and, in `verify.js` only,
`lib/transcript.js` (the thing being reconciled against).

## Usage

```sh
node attribute.js                        # rollup by project, all history
node attribute.js --since 7d             # last 7 days of transcripts
node attribute.js --by path              # break down by cwd instead
node attribute.js --by project,agent_type
node attribute.js --session 223305b4     # one session (id prefix is enough)
node attribute.js --ended-only           # only sessions whose cost is final
node attribute.js --json                 # full nested report
node attribute.js --jsonl                # flat slice rows, history-ready
node attribute.js --no-subagents         # main transcripts only

node verify.js                           # reconcile + assert, against real data
```

Dimensions for `--by`: `project`, `path`/`cwd`, `subpath`, `session`,
`claude_project`, `root`, `agent`, `agent_type`, `resolver` — combine with
commas.

## Decisions made

### Attribution granularity: per API turn, whole

Each API turn (one `message.id`) is attributed entirely to one cwd. Turns are
never split.

**The brief's open question is resolved: `cwd` is stable within a turn.**
Measured across all 18 transcript files / 1247 API turns currently on this
machine: **0 turns had lines disagreeing about `cwd`**. Claude Code stamps
`cwd` per JSONL entry, and it only ever changes between turns, never between
the lines of one turn — so the finer worry ("Claude may `cd` around within a
turn's tool calls too") does not occur in practice. `verify.js` re-measures
this every run and prints the number, so if a future Claude Code version
changes that, it shows up rather than silently mis-attributing.

Belt and braces anyway: a turn's cwd is pinned by its *first* line and later
lines can never re-point it, so even if a conflict did appear, the turn is
still attributed whole and slices still partition the cost exactly.

Session-level "dominant cwd" was rejected — it throws away the most useful
result here (see the `--by subpath` view, which shows
`packages/token-monitor-core` alone at ~$32 of the suite's ~$110).

### cwd → project: deepest of three candidate roots

`lib/project-map.js` computes up to three candidate roots and the **deepest
one wins** (not a fixed priority order):

1. `override` — longest matching prefix in `config.PROJECT_OVERRIDES`
2. `git` — nearest ancestor containing `.git` (dir, or file for worktrees)
3. `workspace-child` — nearest ancestor that is an immediate child of a
   `config.WORKSPACE_ROOTS` entry (default `C:\projects`, `~/projects`)

Deepest-wins rather than git-first specifically so that `git init C:\projects`
one day can't collapse every sub-project into a single bucket.

**The suite counter-example, decided deliberately:** `claude-token-monitor`
has no `.git`, so rule 3 fires and
`claude-token-monitor\packages\token-monitor-core` **rolls up to the suite**,
not to the package. A suite is one unit of work. The package-level detail is
not lost — every distinct cwd is still a `paths[]` slice under its project
carrying a `subpath` relative to the project root, so `--by subpath` gives
the per-package view for free. Splitting a package out for real is one line
in `PROJECT_OVERRIDES`.

Sitting at a workspace root itself (`C:\projects`) resolves to the labelled
bucket **`projects (root)`**, not a project named `projects`. That row is
genuinely unattributable work, and it reads exactly like the coarse
`C--projects` bucket this project exists to split up — conflating the two
would be the worst possible outcome.

### Subagent transcripts are counted (the finding that fixed the watcher)

Sidechain transcripts live at
`~/.claude/projects/<claude-project>/<session-id>/subagents/agent-*.jsonl`,
each with an `agent-*.meta.json` giving `agentType` and the task description.
They contain **real API turns with their own `usage` and their own `cwd`**,
and they are **not** double-counted in the parent (the parent records only the
Task tool result, not the subagent's turns).

When this project was built, **nothing in `token-monitor-core` read them** —
`findActiveSessionFiles()` globbed only top-level `.jsonl`, leaving **$25 of
$139 (18%) invisible to `status.json`**. That gap has since been fixed
upstream; see "Escalation" below.

They're included here, tagged with `agent` / `agent_type` dimensions, and
`--no-subagents` turns them off. Each session report also carries
`main_totals` alongside `totals` — the main-transcript-only figure, kept
because it's the one that isolates a parse discrepancy from a genuine
subagent difference.

### `ended` as the "cost is final" checkpoint

`--ended-only` filters to sessions whose cost can't change any more, using
the `ended` flag `token-monitor-core` now writes into `status.json` (PID
registry cross-reference) rather than guessing from mtime. Sessions absent
from `status.json` entirely have fallen out of the 30-min active window and
are treated as ended (`config.ASSUME_ENDED_WHEN_ABSENT`).

## The shared schema (co-designed with `usage-history-rollups`)

`--jsonl` emits **slice rows** (`tm.attribution.slice/1`, defined in
`lib/report.js`) — one fully-denormalized fact row per
(session, project, cwd, agent):

```json
{
  "schema": "tm.attribution.slice/1",
  "generated_at": "2026-08-06T04:38:20.903Z",
  "window_start": null, "window_end": null,
  "session_id": "937838b8-...", "session_name": "...", "ended": false,
  "claude_project": "C--projects",
  "project": "claude-token-monitor",
  "project_root": "C:\\projects\\claude-token-monitor",
  "resolver": "workspace-child",
  "cwd": "C:\\projects\\claude-token-monitor\\packages\\token-monitor-core",
  "subpath": "packages/token-monitor-core",
  "agent": "main", "agent_type": null, "agent_description": null,
  "turns": 89,
  "first_activity": "...", "last_activity": "...",
  "models": ["claude-opus-5"],
  "totals": { "context": 167, "cache_write": 477145, "cache_read": 18135825,
              "thinking": 30065.2, "writing": 7343.1, "tool_calls": 26419.6,
              "cost_usd": 13.93, "unpriced_output_tokens": 0 }
}
```

Three properties make this work for both projects without a rework:

- **`totals` is byte-identical in shape to what `status.json` already
  writes** (same eight keys, same meanings). Nothing new to learn, and
  `verify.js` asserts our numbers equal `classifySession()`'s.
- **Every dimension is a flat top-level column.** `rollup(rows, dims)` in
  `lib/report.js` groups by any subset, so one row set answers per-project,
  per-cwd, per-session, per-agent, or any combination.
- **`window_start` / `window_end` are reserved and null**, meaning "this row
  covers the session's whole lifetime". `usage-history-rollups` fills them
  in for time-bucketed rows and appends to `history.jsonl`; grouping code
  needs no changes. Symmetrically, if rollups lands first, adding
  `project`/`cwd` to its snapshot rows turns them into these.

Versioning: adding a nullable dimension is non-breaking; removing one or
changing a `totals` key's meaning bumps the `/1`.

## Verification

`node verify.js` (all 25 checks currently pass) asserts, against every real
transcript on this machine:

1. **Reconciliation** — for every main transcript, this project's independent
   parse produces the same totals as `token-monitor-core`'s
   `classifySession()`, key by key. `packages/` is read-only from here, so
   asserting agreement on demand is the only defence against the two parsers
   drifting apart.
2. **Conservation** — per-cwd slices sum exactly back to the session total
   (cost *and* turn counts). Attribution is a partition, never a re-estimate.
3. **cwd stability** — re-measures the turn-conflict count described above.
4. **Resolver spot-checks** — the four cwd→project decisions above, asserted
   as test cases rather than left as prose.

## Escalation: raised here, since fixed upstream

Out of scope for this project (`packages/` is read-only), so it was reported
rather than fixed here — and then **fixed in `token-monitor-core`**
(2026-08-06). Recorded because it's this project's most consequential finding:

**`watcher.js` → `findActiveSessionFiles()` under-reported session cost by
ignoring subagent transcripts.** It collected only top-level
`<project>/<session>.jsonl`, so every `Task`-spawned subagent's tokens were
missing from `status.json`, the statusline, the nvim segment, and the
`token-usage` skill — **~18% of total spend** on the current transcript set,
much higher for a Task-heavy session. Found here because this project's
independent parser disagreed with `classifySession()`'s totals.

The watcher now globs `<project>/<session-id>/subagents/*.jsonl` and folds
those parses into the parent session entry (`mergeSubagent()`), plus publishes
an `agents` array of currently-running agents. `lib/transcript.js` needed no
change. **Consequence for this project:** `status.json` and `--no-subagents`
no longer agree — `main_totals` is the field that still matches what the
watcher reports for main transcripts alone, while the watcher's session total
now corresponds to this project's full (subagent-inclusive) figure.

Nothing else needed a cross-boundary change: reading `entry.cwd` was done in
this project's own parser rather than in `lib/transcript.js`, and it
reconciles exactly with the shared one.
