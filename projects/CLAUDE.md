# projects/ — working notes for Claude

Extensions to the suite, one folder per idea. See [`README.md`](README.md) for
what each one is, and the [suite CLAUDE.md](../CLAUDE.md) for rules that apply
everywhere.

Read a project's README before touching its code, and correct it in place as
you learn things rather than leaving it stale.

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

## PowerShell 5.1 traps these projects hit

Both bite silently and both are already worked around; do not "simplify" the
workarounds away.

- **`powershell.exe -File` truncates an argument at an embedded `"`.** `-File`
  re-parses on top of `CommandLineToArgvW`, so a quote inside a value cuts the
  rest of it off with no error. `Cost alert: session "Project Setup" crossed
  $50, now at $72.77` arrived as `Cost alert: session Project` — the cost
  figure was simply gone. `cost-anomaly-alerts`' `safeName()` strips `"` and
  backticks and never wraps the name in quotes; `test.js` covers it as a
  regression. `ask-question-prefilter`'s `ConvertTo-SafeArg` does the same for
  anything the model generates before forwarding it on. Neither can protect
  its own *caller* — the damage happens before the script starts.
- **`Set-Content`/`Out-File -Encoding utf8` writes a BOM**, and a BOM makes
  `JSON.parse` reject the file outright. Write with
  `[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))`.
  Reading is the mirror image: `Get-Content -Raw -Encoding UTF8` is mandatory,
  or 5.1 decodes a BOM-less UTF-8 file as the system codepage and turns every
  em-dash into mojibake — which then gets written back.
- **Piping to stdin is not safe from PowerShell.** It re-encodes anything
  piped to a native exe through the console codepage, so `Résumé` reaches Node
  as `RÃ©sumÃ©`. That is why `local-inference-skill`'s scripts take
  `--in <file.json>` and decode it themselves. Stdin still works from a POSIX
  shell.

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
  watching it. Its `stub-ask-question.ps1` exists because the real popup could
  not be used as a test oracle: `wt-focus.exe`'s dialog does not render on this
  machine (TTS speaks, focus returns in ~5s, no window, no blocking). That is a
  `bug-me-claude` condition, reproducible from a direct `notify-done.ps1` call.
- **`usage-history-rollups`** and **`cost-anomaly-alerts`** are daemons you
  have to actually start; the installer deliberately does not manage them.
  Both tolerate being started late, restarted, or run while the watcher is
  down — keep it that way.
- **`cost-anomaly-alerts` must not spawn `notify-done.ps1` `detached: true`.**
  That was the first implementation and the child silently failed to launch
  under some parent contexts — no popup, no error, nothing in `wt-focus`'s own
  debug log. `unref()` alone already gives the only property that matters.
- **`per-project-cost-attribution`** uses a NUL byte as a composite map-key
  delimiter (`${project}\0${project_root}` in `lib/attribute.js`, the rollup
  key in `lib/report.js`), chosen because NUL cannot appear in a path. This
  makes `grep` treat both files as binary; use `grep -a` /
  `--binary-files=text`. It is not corruption.

## Measured, so you don't have to measure it again

- **`cwd` is stable within an API turn.** Across all 18 transcripts / 1247
  turns on this machine, **0** turns had lines disagreeing about `cwd` — Claude
  Code stamps it per JSONL entry and only changes it between turns. A turn is
  pinned by its first line's `cwd` anyway, so slices partition the cost exactly
  even if that ever stops being true. `verify.js` re-measures it every run and
  prints the count.
- **Subagent transcripts were ~18% of spend** and were invisible to
  `status.json` until the watcher was fixed (2026-08-06). Totals cached or
  compared from before that date see a step change.
- **Transcript parsing is 8ms per tick** against the active set. It does not
  need an mtime cache.
- **The `ask-question-prefilter` tightening guard is load-bearing.** Given
  "Should I use tabs or spaces?" with a `-Detail` implying tabs, the 3B model
  returns `"Use tabs consistently."` — shorter, but now a statement asserting
  an answer the user never gave, which TTS would speak at them. A tightening is
  accepted only if it is ≥8 chars, strictly shorter, **and contains a `?`**.

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

A check that needs consent to do something disruptive takes it as a flag in the
registry's `args`, not as its own default behaviour.

**On timeout the runner kills only the direct child it spawned.** Never
`taskkill /T`, never a tree kill, never a match by image name: there is one
`watcher.js` holding a PID lock and there are shared `llama-server` processes
other sessions and other repos depend on, any of which a tree kill could
plausibly reach. A stray short-lived grandchild left to exit on its own is the
strictly less damaging failure.
