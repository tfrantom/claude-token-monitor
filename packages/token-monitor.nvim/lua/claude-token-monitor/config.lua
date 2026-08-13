local M = {}

-- Self-locating rather than hardcoded: token-monitor.nvim and
-- token-monitor-core are fixed siblings under packages/ (they move together
-- as one suite), so the status file's location can be derived from this
-- file's own path instead of baking in an absolute suite root that would
-- break the moment the suite lives somewhere else.
local function default_status_file()
  local source = debug.getinfo(1, "S").source:sub(2) -- strip leading "@"
  local plugin_dir = source:gsub("[/\\]lua[/\\]claude%-token%-monitor[/\\]config%.lua$", "")
  local packages_dir = plugin_dir:gsub("[/\\][^/\\]+$", "") -- strip trailing /token-monitor.nvim
  return packages_dir .. "/token-monitor-core/state/status.json"
end

M.defaults = {
  status_file = default_status_file(),
  poll_interval_ms = 5000,
  -- "statusline" (bottom, default) or "winbar" (top, per-window).
  position = "statusline",
  -- Sessions with no activity for longer than this are dropped from display,
  -- independent of the watcher's own window -- keeps a stale status.json
  -- (watcher not running) from showing forever-frozen numbers.
  stale_after_ms = 10 * 60 * 1000,
  max_other_sessions = 3,
  icons = {
    active = "●",
    separator = " │ ",
    total = "Σ",
  },
  highlights = {
    active_name = "ClaudeTokenMonitorActive",
    active_cost = "ClaudeTokenMonitorActiveCost",
    dim = "ClaudeTokenMonitorDim",
  },
}

M.options = vim.deepcopy(M.defaults)

local VALID_POSITIONS = { statusline = true, winbar = true }

function M.setup(opts)
  M.options = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
  if not VALID_POSITIONS[M.options.position] then
    vim.notify(
      string.format("claude-token-monitor: invalid position %q, falling back to %q", tostring(M.options.position), M.defaults.position),
      vim.log.levels.WARN
    )
    M.options.position = M.defaults.position
  end
end

return M
