# per-project-cost-attribution — working notes for Claude

See [`README.md`](README.md) for what it is and how to run it, the
[projects CLAUDE.md](../CLAUDE.md) for rules shared by every project here, and
the [suite CLAUDE.md](../../CLAUDE.md) for the cost-math invariant this file
depends on.

## Two `require()`s into `packages/`, both read-only

`lib/pricing.js`'s `costForTurn()` (from `lib/attribute.js`) and, in `verify.js`
only, `lib/transcript.js`'s `classifySession()`. Nothing under `packages/` is
written. Do not re-implement the rate table here — a second copy is a
silent-drift bug, and the suite CLAUDE.md's "Cost is computed in two places"
covers what has to be passed.

## Why this parses transcripts itself

`classifySession()` cannot be reused: it throws away the per-entry `cwd` this
whole project is built on. `lib/attribute.js` therefore mirrors
`token-monitor-core/lib/transcript.js` turn for turn, and `verify.js` asserts
the two agree over every real transcript. That reconciliation is the only
defence against the two parsers drifting, so a red
`per-project-cost-attribution` check usually means one of them moved, not that
this project is broken.

## Per API turn, whole

Each API turn (one `message.id`) is attributed entirely to one cwd, **pinned by
the turn's first line**. Later lines of the same `message.id` are only counted
as disagreements — they may never re-point the turn, or slices would
double-count and stop partitioning the session total.

Turns are never split, so slices always partition the cost exactly.
`parseTranscript()` instruments this: `turns_with_cwd_conflict` and
`transitions` are re-measured on every `verify.js` run, so a future Claude Code
that stops stamping `cwd` per JSONL entry shows up as a number rather than as
silent mis-attribution. On this machine it is currently 0 across all
transcripts (see [`../CLAUDE.md`](../CLAUDE.md) "Measured").

Session-level "dominant cwd" was rejected: it throws away the most useful
result here, the `--by subpath` view, which showed
`packages/token-monitor-core` alone at ~$32 of the suite's ~$110.

## cwd → project: deepest of three candidate roots

`lib/project-map.js` computes up to three candidate roots and the **deepest one
wins** — not a fixed priority order:

1. `override` — longest matching prefix in `config.PROJECT_OVERRIDES`
2. `git` — nearest ancestor containing `.git` (a directory for a normal clone,
   a file for a worktree or submodule)
3. `workspace-child` — nearest ancestor that is an immediate child of a
   `config.WORKSPACE_ROOTS` entry

Deepest-wins rather than git-first specifically so that `git init C:\projects`
one day cannot collapse every sub-project into a single bucket. On a tie in
depth the earlier candidate keeps it, which is why the loop compares with `>`.

Two fallbacks when nothing matches:

- Sitting at a workspace root itself (`C:\projects`) resolves to the labelled
  bucket **`projects (root)`**, not a project named `projects`. That row is
  genuinely unattributable work and it should read exactly like the coarse
  `C--projects` bucket this project exists to split up.
- Anywhere else resolves to itself (`resolver: 'cwd'`) rather than being
  silently merged with unrelated siblings.

Path comparison is case-insensitive on Windows; comparing raw strings
mis-buckets `C:\Projects\foo` against `C:\projects\foo`.

**The suite counter-example, decided deliberately:** `claude-token-monitor` has
no `.git`, so rule 3 fires and
`claude-token-monitor\packages\token-monitor-core` **rolls up to the suite**,
not to the package. A suite is one unit of work. The package-level detail is
not lost — every distinct cwd is still a `paths[]` slice under its project
carrying a `subpath` relative to the project root, so `--by subpath` gives the
per-package view for free. Splitting a package out for real is one line in
`PROJECT_OVERRIDES`.

## Subagent transcripts are counted

Sidechain transcripts live at
`~/.claude/projects/<claude-project>/<session-id>/subagents/agent-*.jsonl`,
each with an `agent-*.meta.json` giving `agentType` and the task description
(the meta file is a nicety — a missing one is not an error). They contain
**real API turns with their own `usage` and their own `cwd`**, and they are
**not** double-counted in the parent, which records only the Task tool result.
A Task-heavy session can spend most of its money in a cwd the main transcript
never visits.

They are included by default, tagged with the `agent` / `agent_type`
dimensions; `--no-subagents` turns them off. Each session report also carries
`main_totals` alongside `totals` — the main-transcript-only figure — so a parse
discrepancy stays distinguishable from a genuine subagent difference.

## `ended` is the "cost is final" checkpoint

`--ended-only` filters to sessions whose cost cannot change any more, using the
`ended` flag `token-monitor-core` writes into `status.json` (a PID-registry
cross-reference, far more reliable than mtime staleness) rather than guessing.
Sessions absent from `status.json` have fallen out of the 30-minute active
window and are treated as ended (`config.ASSUME_ENDED_WHEN_ABSENT`).

`status.json` is read by path, optionally: it supplies only the `ended` flag
and the display name.

## The shared slice schema

`--jsonl` emits **slice rows** (`tm.attribution.slice/1`, defined in
`lib/report.js`), co-designed with `usage-history-rollups` — one
fully-denormalized fact row per (session, project, cwd, agent):

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

Three properties make it work for both projects without a rework:

- **`totals` is identical in shape to what `status.json` writes** — same keys,
  same meanings — and `verify.js` asserts the numbers equal
  `classifySession()`'s.
- **Every dimension is a flat top-level column.** `rollup(rows, dims)` groups by
  any subset, so one row set answers per-project, per-cwd, per-session,
  per-agent, or any combination. `cwd` is the finest grain in the source data,
  so a consumer can always aggregate up without re-parsing transcripts.
- **`window_start` / `window_end` are reserved and null**, meaning "this row
  covers the session's whole lifetime". `usage-history-rollups` fills them in
  for time-bucketed rows; grouping code needs no changes.

Versioning: adding a nullable dimension is non-breaking; removing one, or
changing what a `totals` key means, bumps the `/1`.

## Verification

`node verify.js [--since 7d]` asserts, against every real transcript on this
machine:

1. **Reconciliation** — for every main transcript, this project's independent
   parse produces the same totals as `classifySession()`, key by key.
2. **Conservation** — per-cwd slices sum exactly back to the session total,
   cost *and* turn counts. Attribution is a partition, never a re-estimate.
3. **cwd stability** — re-measures the per-turn conflict count.
4. **Resolver spot-checks** — the four cwd→project decisions above, asserted as
   test cases rather than left as prose.

It exits **3, not 1**, when there are no transcripts to reconcile, which
`run-checks.js` reads as SKIP — see [`../CLAUDE.md`](../CLAUDE.md) "Adding a
check". Nothing to reconcile is not a reconciliation that disagreed, and on a
fresh clone it is the normal state.

## NUL bytes in `lib/`

`lib/attribute.js` and `lib/report.js` each use a literal NUL as a composite
map-key delimiter, chosen because NUL cannot appear in a path. `grep` therefore
treats both files as binary; use `grep -a`. It is not corruption — see
[`../CLAUDE.md`](../CLAUDE.md).
