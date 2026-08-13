# claude-token-monitor.nvim

Reads the token-monitor watcher's `state/status.json` (the same file
`statusline.js` reads for the terminal) and exposes it as a Neovim
statusline/winbar segment or a lualine component. No parsing, no LLM calls,
and no disk I/O on redraw — a timer refreshes a cached string every
`poll_interval_ms` and the statusline functions return that cache.

A standalone plugin with its own `lua/claude-token-monitor/` namespace, one
package in the [claude-token-monitor suite](../../README.md).

## Install (lazy.nvim)

`install.ps1` writes this spec to
`~/AppData/Local/nvim/lua/plugins/claude-token-monitor.lua` for you. To do it
by hand, point lazy.nvim at this directory as a local plugin:

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

lualine components render as a single color, so the active/dim distinction the
native path gets from `%#Group#...%*` codes is flattened here. Use the native
statusline/winbar path if you want the active session visually distinct.

**Commands:**

- `:ClaudeTokenMonitorRefresh` — re-read `status.json` immediately instead of
  waiting for the next timer tick.

**Health check:**

- `:checkhealth claude-token-monitor` — confirms `status.json` exists, parses,
  isn't stale, and reports whether `CLAUDE_CODE_SESSION_ID` was found (exact
  active-session detection) or it's falling back to the cwd-matching
  heuristic.

## What it renders

One segment per live session, active one first. Beyond name and cost:

- **Ended sessions are dropped**, so a closed session leaves the line
  immediately. `reader.lua` filters them alongside its own staleness check.
- **Running subagents show up.** The active session gets a per-agent
  `<tokens>-<cost>` list in the order the Claude Code UI shows them; every
  other session collapses to a `3A` count badge. This mirrors `statusline.js`.
  A session's own cost already *includes* its subagents' spend, so the agent
  figures are a breakdown, not an addition.

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

The watcher (`node packages/token-monitor-core/watcher.js` from the suite
root) running and writing its `state/status.json`. This plugin only reads that
file — it never starts or manages the watcher or the llama.cpp server.
