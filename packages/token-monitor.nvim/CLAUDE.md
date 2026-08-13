# token-monitor.nvim — working notes for Claude

A lazy.nvim plugin that renders the watcher's `status.json` as a statusline or
winbar segment. See [`README.md`](README.md) and the [suite
CLAUDE.md](../../CLAUDE.md).

## It is a reader, not a participant

This plugin has **no code dependency** on the rest of the suite — it reads one
JSON file by path. It does not require, spawn, or manage the watcher or any
llama-server. If `status.json` is missing or stale, render nothing useful and
say so; never try to start anything from inside Neovim.

That read-only relationship is what makes this package extractable on its own,
so keep it.

## It locates itself

`config.lua`'s `default_status_file()` derives the path to
`../token-monitor-core/state/status.json` from `debug.getinfo(1, "S").source`
— its own file path. The two packages are fixed siblings under `packages/` and
move together, so there is nothing to configure and nothing to break when the
suite is cloned elsewhere.

Do not replace this with an absolute path or an install-time-substituted
constant. Do handle both `/` and `\` separators — the existing gsub patterns
do, deliberately, because this runs on Windows.

## Staleness is the plugin's own problem

`stale_after_ms` (default 10 min) is independent of the watcher's active
window. It exists so a `status.json` left behind by a watcher that is no longer
running does not display forever-frozen numbers as though they were live. The
watcher's own `ACTIVE_SESSION_WINDOW_MS` governs the data; this governs the
display.

Ended sessions are filtered client-side, same as in `statusline.js` — the
watcher keeps them in the file on purpose (flagged `ended: true`, for the rest
of its 30-minute window) so other consumers can observe the live→ended
transition. Every status bar drops them on its own instead. Do not "fix" this
by filtering upstream.

## It is installed by writing a lazy.nvim spec

`install.ps1` writes `~/AppData/Local/nvim/lua/plugins/claude-token-monitor.lua`,
a spec whose `dir=` points at this package in place — a local plugin, not a git
remote. Consequences:

- Hand-edits to that generated file are lost on the next install run. Change
  the here-string in `install.ps1` instead.
- Re-run the installer after moving the suite; `dir=` is an absolute path.
- On a machine with no `%LOCALAPPDATA%\nvim`, the installer prints `[skip]` and
  returns 0. That is a skip, not a failure — the suite installer treats it as
  success and should keep doing so.
- The generated file is written no-BOM via `[System.IO.File]::WriteAllText`.
  Neovim reads it as Lua source and a BOM lands as a stray character before
  `return`. See the suite CLAUDE.md "PowerShell 5.1 encoding".

## Picking the active session

`reader.select_sessions()` tries, in order:

1. An exact match on `CLAUDE_CODE_SESSION_ID`. Neovim only inherits that when
   it was launched from inside a Claude Code session, so it is nil for a normal
   editing session and the fallback is the usual path — do not treat it as the
   primary route.
2. The most-recently-active session whose `project` matches Neovim's cwd,
   sanitized the way Claude Code names its own project directories
   (`C:\projects` → `C--projects`). `sanitize_cwd()` has to stay in step with
   that convention or nothing ever matches.
3. Nothing active — every session renders the same way. This is a normal
   state, not an error to report.

The remaining sessions are ordered most-recent-first and trimmed to
`max_other_sessions`.

## Only the active session gets agent detail

The active session renders a per-agent `<tokens>-<cost>` list; every other
session collapses to a count badge (`3A`). Detail belongs where you are
looking — N windows each rendering N agent lists makes the line unusable. This
mirrors `statusline.js`; keep the two in step.

A session's `totals.cost_usd` already **includes** its subagents' spend, so the
per-agent figures are a breakdown, not something to add on. Subagent spend was
missing before 2026-08-06 and is worth roughly 18%, so anything compared
against a number cached before then will show a step change that is not a bug.

## Two render paths, and lualine is the lossy one

`build_segments()` returns `{text, hl}` pairs; `statusline_string()` wraps each
in `%#Group#...%*` and `plain_string()` throws the highlights away. A lualine
component renders as a single colour, so the active/dim distinction only exists
on the native statusline/winbar path. Do not try to recover it with escape
codes inside a lualine component — lualine escapes them.

Highlights are declared with `default = true` and **linked**, never given
literal colours: the user's colorscheme stays in charge of the palette.

`get_statusline()` and `get_plain()` run on every redraw and only ever return a
cached string. The timer is the sole thing that touches disk. Never add a read,
a `vim.fn`, or a JSON decode to that path.

## Formatting mirrors statusline.js

`fmt_cost_short` and `fmt_num` must stay byte-identical in output to
`statusline.js`'s `fmtCostShort` / number scaling, so the two bars agree.
`scale()` drops a trailing `.0` deliberately: on a space-constrained line
`150M` beats `150.0M`, and one decimal only carries information below ~10 of a
unit.

The semantic layer only ever annotates the thinking bucket's existing total, so
with no classified turns yet (cold start, or llama-server unreachable)
`fmt_thinking` falls back to the plain number rather than rendering a
misleading `0%`.

## Testing

There is no Lua check in `run-checks.js`; the runner lists this package under
"no check of their own" on purpose rather than pretending otherwise. Verify by
hand in a real Neovim with the watcher running. If you add a check, register it
in the runner's `CHECKS` array — an unregistered check-shaped file is reported
as a failure by the unregistered-script audit.
