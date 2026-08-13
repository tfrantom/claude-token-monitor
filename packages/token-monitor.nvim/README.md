# claude-token-monitor.nvim

Reads the token-monitor watcher's `state/status.json` (same file `statusline.js`
reads for the terminal) and exposes it as a Neovim statusline/winbar segment or
a lualine component. Does no parsing, no LLM calls, no disk I/O on every
redraw — a timer refreshes a cached string every `poll_interval_ms`, and the
statusline functions just return that cache.

This is a standalone plugin (its own `lua/claude-token-monitor/` namespace),
one package in the [claude-token-monitor suite](../../README.md). **Already
installed** into the live Neovim config at
`~/AppData/Local/nvim/lua/plugins/claude-token-monitor.lua` — the spec below
is for reference/reinstall, not a first-time setup step.

## Install (lazy.nvim)

Point lazy.nvim at this directory as a local plugin:

```lua
{
  "claude-token-monitor",
  dir = "<suite-root>/packages/token-monitor.nvim",
  lazy = false,
  opts = {},
}
```

`opts = {}` uses the defaults in `lua/claude-token-monitor/config.lua`
(status file path, poll interval, highlight group names). Override any of
them, e.g. `opts = { poll_interval_ms = 10000 }`.

## Usage

**Native statusline or winbar:**

```lua
vim.o.statusline = "%{%v:lua.require('claude-token-monitor').get_statusline()%}"
-- or, to add it alongside existing statusline content, append/prepend
-- that %{...} expression to whatever vim.o.statusline is already set to.
```

**lualine:**

```lua
require("lualine").setup({
  sections = {
    lualine_x = { require("claude-token-monitor").lualine_component() },
  },
})
```

Note: lualine components render as a single color, so the active/dim
distinction the native-statusline path gets from `%#Group#...%*` codes is
flattened to plain text here. Use the native statusline/winbar path if you
want the active session visually distinct.

**Commands:**

- `:ClaudeTokenMonitorRefresh` — re-read `status.json` immediately instead of
  waiting for the next timer tick.

**Health check:**

- `:checkhealth claude-token-monitor` — confirms `status.json` exists, parses,
  isn't stale, and reports whether `CLAUDE_CODE_SESSION_ID` was found (exact
  active-session detection) or it's falling back to the cwd-matching
  heuristic.

## What it renders

One segment per live session, active one first. Two things beyond name and
cost are worth knowing:

- **Ended sessions are filtered out here, not upstream.** The watcher
  deliberately keeps a finished session in `status.json` flagged `ended: true`
  for the rest of its 30-minute window, because other consumers want the
  live→ended transition. Every status bar drops them on its own instead, so a
  closed session leaves the segment immediately. `reader.lua` does this
  alongside its own staleness check.
- **Running subagents show up.** The active session gets a per-agent
  `<tokens>-<cost>` list in the order the Claude Code UI shows them; every
  other session collapses to a `3A` count badge. Detail belongs where you're
  looking — N windows each rendering N agent lists would make the line
  unusable. This mirrors `statusline.js` exactly. Note the session's own
  cost already *includes* its subagents' spend, so the agent figures are a
  breakdown, not an addition.

## How "active session" is picked

1. `CLAUDE_CODE_SESSION_ID` env var, if Neovim happened to inherit it (only
   true when Neovim was launched from inside a Claude Code session itself —
   rare for a normal editing session).
2. Otherwise: the most-recently-active watcher session whose `project` field
   matches Neovim's current working directory, sanitized the same way Claude
   Code names its own project directories (`C:\projects` → `C--projects`).
3. Otherwise: no session is marked active; all are listed the same way.

## Highlight groups

Defined with `default = true` (won't override anything you've already set),
linked to sensible existing groups so your colorscheme still drives the
actual palette:

| Group | Default link | Used for |
|---|---|---|
| `ClaudeTokenMonitorActive` | `Title` | active session's name |
| `ClaudeTokenMonitorActiveCost` | `Number` | active session's cost |
| `ClaudeTokenMonitorDim` | `Comment` | everything else |

Override with `vim.api.nvim_set_hl(0, "ClaudeTokenMonitorActive", { fg = "#..." })`
after setup, or pass different group names via `opts.highlights` to link to
your own groups instead.

## Requires

The watcher (`node ../watcher.js` from the project root) running and writing
`state/status.json`. This plugin only reads that file — it does not start or
manage the watcher or the local llama.cpp server itself.
