local M = {}

-- see CLAUDE.md "It locates itself"
local function default_status_file()
  local source = debug.getinfo(1, "S").source:sub(2)
  local plugin_dir = source:gsub("[/\\]lua[/\\]claude%-token%-monitor[/\\]config%.lua$", "")
  local packages_dir = plugin_dir:gsub("[/\\][^/\\]+$", "")
  return packages_dir .. "/token-monitor-core/state/status.json"
end

M.defaults = {
  status_file = default_status_file(),
  poll_interval_ms = 5000,
  position = "statusline",
  -- see CLAUDE.md "Staleness is the plugin's own problem"
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
