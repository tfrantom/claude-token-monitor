# claude-token-monitor.nvim

A Neovim statusline/winbar segment (or lualine component) showing what every
live Claude Code session is spending, read from the watcher's
`state/status.json`. One package in the
[claude-token-monitor suite](../../README.md).

## Requirements

- Neovim with `vim.json` and `vim.uv`/`vim.loop`
- lazy.nvim, if you use the generated plugin spec
- The suite's watcher running: `node packages/token-monitor-core/watcher.js`

## Install

```powershell
.\install.ps1
```

Writes a lazy.nvim spec to
`~/AppData/Local/nvim/lua/plugins/claude-token-monitor.lua`. To do it by hand,
point lazy.nvim at this directory as a local plugin:

```lua
{
  "claude-token-monitor",
  dir = "<suite-root>/packages/token-monitor.nvim",
  lazy = false,
  opts = {},
}
```

## Usage

```lua
-- native statusline or winbar
vim.o.statusline = "%{%v:lua.require('claude-token-monitor').get_statusline()%}"

-- lualine
require("lualine").setup({
  sections = { lualine_x = { require("claude-token-monitor").lualine_component() } },
})
```

| Command | Effect |
|---|---|
| `:ClaudeTokenMonitorRefresh` | Re-read `status.json` now instead of at the next tick |
| `:checkhealth claude-token-monitor` | Status file present, parsing, fresh; how the active session is being detected |

## Configuration

Passed as `opts`; defaults live in `lua/claude-token-monitor/config.lua`.

| Option | Default | |
|---|---|---|
| `status_file` | `../token-monitor-core/state/status.json` | Resolved from the plugin's own path |
| `poll_interval_ms` | `5000` | |
| `position` | `"statusline"` | Or `"winbar"` |
| `stale_after_ms` | `600000` | Sessions not written within this are hidden |
| `max_other_sessions` | `3` | Non-active sessions listed |
| `icons` | `{ active = "●", separator = " │ ", total = "Σ" }` | |
| `show_activity` | `true` | Render each session's declared state (`✓ done`, `▶ working`, …) |
| `show_activity_detail` | `true` | Also render the free text a session publishes with its state |
| `activity_icons` | see `config.lua` | Per-state glyphs; unknown states fall back to `unknown` |
| `highlights` | the group names below | Point them at your own groups instead |

| Highlight group | Default link | Used for |
|---|---|---|
| `ClaudeTokenMonitorActive` | `Title` | Active session's name |
| `ClaudeTokenMonitorActiveCost` | `Number` | Active session's cost |
| `ClaudeTokenMonitorDim` | `Comment` | Everything else |
| `ClaudeTokenMonitorDone` | `DiagnosticOk` | `done` |
| `ClaudeTokenMonitorWorking` | `DiagnosticInfo` | `working` |
| `ClaudeTokenMonitorWaiting` | `DiagnosticWarn` | `waiting_user`, `waiting_agents` |
| `ClaudeTokenMonitorBlocked` | `DiagnosticError` | `blocked` |

Linked with `default = true`, so `vim.api.nvim_set_hl(0, "ClaudeTokenMonitorActive", { fg = "#..." })`
wins.

## Contributing

[`CLAUDE.md`](CLAUDE.md).
