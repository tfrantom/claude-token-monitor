# projects/ — working notes for Claude

Extensions to the suite, one folder per idea. All seven are built. See
[`README.md`](README.md) for status and the shared-infrastructure notes, and
the [suite CLAUDE.md](../CLAUDE.md) for rules that apply everywhere.

## Read the project's README in full before touching its code

Each one documents decisions that were *measured*, including several that
failed. Re-deriving them is the expensive mistake. Correct a README in place as
you learn things rather than leaving it stale.

Each folder also carries its own open items ("Left to do", "Possible next
steps", "Escalations") — that is where the remaining work is.

## These are finished packages that live under `projects/`

Promoting one to `packages/` is a **pending decision, not an oversight**. Each
implementer correctly declined to move itself, since that is an edit outside
its own folder. Describe things where they are now.

## Consuming `status.json`

- **Do not read it more than once per tick,** and never write it. The watcher
  owns that file.
- **`ended: true` requires two consecutive polls to be trusted.** If
  `~/.claude/sessions/` is briefly unreadable, every session reads as ended at
  once. Ended sessions linger for the rest of the active window on purpose so
  pollers can catch the live→ended transition.
- **Session totals include subagent spend** (~+18%), folded in from
  `<project>/<session-id>/subagents/agent-*.jsonl`. Anything that cached or
  compared totals from before 2026-08-06 sees a step change.
- **`agents` is *running* agents only**, in UI order, always present even when
  empty — render it unconditionally without a presence check.

## Cost math belongs to the core

Do not write a rate card. `projects/per-project-cost-attribution` imports
`costForTurn()` from `packages/token-monitor-core/lib/pricing.js`, and that is
the pattern — it is also the suite's *second* call site for that function, so
if you change what it is passed there, read the suite CLAUDE.md first. Its
`verify.js` reconciles the two parsers over every real transcript and is the
first check to fail when they drift.

## Ports

Hand-claimed, no allocator. `netstat` first, then record it in the table in
[`README.md`](README.md). Use `ensureRunningFor(name, opts)` rather than
hardcoding a port in your own config. Kill `llama-server.exe` by PID or port,
never by image name.

## Per-project traps

- **`local-inference-skill`** and **`token-usage-skill`** install *copies* into
  `~/.claude/skills/`. Editing the source here does nothing until you re-run
  the project's `install.ps1`. Same no-BOM encoding rules as everywhere else.
- **`ask-question-prefilter`** is **inert** by design until `bug-me-claude`'s
  own `SKILL.md` points at it — a cross-project edit, see its `proposed/`. Its
  smoke test is held back from `run-checks.js` for two independent reasons: it
  asserts nothing (it prints expectations for a human to eyeball and exits 0
  regardless), and it drives the front door to a blocking WinForms popup with
  text-to-speech. Every case is currently defused via `-DryRun` or a stub, but
  that safety lives in the arguments of ten call sites. Run it deliberately,
  watching it.
- **`usage-history-rollups`** and **`cost-anomaly-alerts`** are daemons you
  have to actually start; the installer deliberately does not manage them.
  Both tolerate being started late, restarted, or run while the watcher is
  down — keep it that way.
- **`per-project-cost-attribution`** uses a NUL byte as a composite map-key
  delimiter (`${project}\0${project_root}`), chosen because NUL cannot appear
  in a path. This makes `grep` treat `lib/attribute.js` as binary; use
  `grep -a` / `--binary-files=text`. It is not corruption.

## Adding a check

Register it in `run-checks.js`'s `CHECKS` array with a `safety` classification
and a `why`.

Exit codes are a three-way contract, not two: **0 passed, 1 failed, 3 skipped
because this machine cannot run it** (print the reason on the last line). Reach
for 3 whenever the precondition is data or hardware rather than correctness —
`per-project-cost-attribution` used to exit 1 on a machine with no transcripts,
so a fresh clone's first `node run-checks.js` went red for having nothing to
check yet. The runner is a registry rather than a glob on purpose: whether a
script is offline logic, needs a live server, or is one flag away from firing a
blocking popup is not derivable from its filename. An unregistered
check-shaped file is reported as a failure, so the registry cannot silently go
stale.
