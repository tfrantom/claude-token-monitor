# per-project-cost-attribution

`node attribute.js` answers "how much did building this suite actually cost"
(and the same for any other project on this machine), broken down by real
project — not by Claude Code's coarse per-terminal `C--projects` grouping.

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

Nothing under `packages/` is modified. Two read-only `require()`s point at it:
`lib/pricing.js` (deliberately not re-implemented — a second copy of the rate
table is a silent-drift bug) and, in `verify.js` only, `lib/transcript.js`.

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

## How attribution works

### Per API turn, whole

Each API turn (one `message.id`) is attributed entirely to one cwd, pinned by
the turn's *first* line; later lines can never re-point it. Turns are never
split, so slices always partition the session cost exactly. `cwd` is in fact
stable within a turn on real data — see [`../CLAUDE.md`](../CLAUDE.md) — and
`verify.js` re-measures that every run.

Session-level "dominant cwd" was rejected: it throws away the most useful
result here (the `--by subpath` view, which shows `packages/token-monitor-core`
alone at ~$32 of the suite's ~$110).

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
carrying a `subpath` relative to the project root, so `--by subpath` gives the
per-package view for free. Splitting a package out for real is one line in
`PROJECT_OVERRIDES`.

Sitting at a workspace root itself (`C:\projects`) resolves to the labelled
bucket **`projects (root)`**, not a project named `projects`. That row is
genuinely unattributable work, and it reads exactly like the coarse
`C--projects` bucket this project exists to split up.

### Subagent transcripts are counted

Sidechain transcripts live at
`~/.claude/projects/<claude-project>/<session-id>/subagents/agent-*.jsonl`,
each with an `agent-*.meta.json` giving `agentType` and the task description.
They contain **real API turns with their own `usage` and their own `cwd`**, and
they are **not** double-counted in the parent, which records only the Task tool
result.

They're included here, tagged with `agent` / `agent_type` dimensions, and
`--no-subagents` turns them off. Each session report also carries `main_totals`
alongside `totals` — the main-transcript-only figure, which is what
`status.json` reported before the watcher learned to fold subagents in.

### `ended` as the "cost is final" checkpoint

`--ended-only` filters to sessions whose cost can't change any more, using the
`ended` flag `token-monitor-core` writes into `status.json` (PID registry
cross-reference) rather than guessing from mtime. Sessions absent from
`status.json` have fallen out of the 30-min active window and are treated as
ended (`config.ASSUME_ENDED_WHEN_ABSENT`).

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

- **`totals` is identical in shape to what `status.json` writes** (same eight
  keys, same meanings), and `verify.js` asserts our numbers equal
  `classifySession()`'s.
- **Every dimension is a flat top-level column.** `rollup(rows, dims)` in
  `lib/report.js` groups by any subset, so one row set answers per-project,
  per-cwd, per-session, per-agent, or any combination.
- **`window_start` / `window_end` are reserved and null**, meaning "this row
  covers the session's whole lifetime". `usage-history-rollups` fills them in
  for time-bucketed rows; grouping code needs no changes.

Versioning: adding a nullable dimension is non-breaking; removing one or
changing a `totals` key's meaning bumps the `/1`.

## Verification

`node verify.js` asserts, against every real transcript on this machine:

1. **Reconciliation** — for every main transcript, this project's independent
   parse produces the same totals as `token-monitor-core`'s
   `classifySession()`, key by key. `packages/` is read-only from here, so
   asserting agreement on demand is the only defence against the two parsers
   drifting apart.
2. **Conservation** — per-cwd slices sum exactly back to the session total
   (cost *and* turn counts). Attribution is a partition, never a re-estimate.
3. **cwd stability** — re-measures the per-turn conflict count.
4. **Resolver spot-checks** — the four cwd→project decisions above, asserted
   as test cases rather than left as prose.

It exits 3 (not 1) when there are no transcripts to reconcile, which
`run-checks.js` reads as SKIP.
