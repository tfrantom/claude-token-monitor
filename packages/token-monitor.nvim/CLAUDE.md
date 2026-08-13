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
watcher keeps them in the file on purpose (flagged `ended: true`) so other
consumers can observe the live→ended transition.

## Testing

There is no Lua check in `run-checks.js`; the runner lists this package under
"no check of their own" on purpose rather than pretending otherwise. Verify by
hand in a real Neovim with the watcher running. If you add a check, register it
in the runner's `CHECKS` array — an unregistered check-shaped file is reported
as a failure by the unregistered-script audit.
