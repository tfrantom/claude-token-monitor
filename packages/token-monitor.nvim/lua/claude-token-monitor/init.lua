local config = require("claude-token-monitor.config")
local reader = require("claude-token-monitor.reader")
local format = require("claude-token-monitor.format")

local M = {}

-- Cache written by the timer, read by the (frequently-called) statusline
-- functions -- those must never touch disk directly, since Neovim redraws
-- the statusline far more often than the underlying data actually changes.
local cache = { statusline = "", plain = "", selection = { active = nil, others = {} } }

local timer = nil
local last_position = nil -- tracks which bar (if any) we last wrote to, so
-- switching position on a later setup() call clears only the bar we own
-- instead of stomping on something the user configured separately.

local SEGMENT_EXPR = "%{%v:lua.require('claude-token-monitor').get_statusline()%}"

local function apply_position(position)
  if last_position and last_position ~= position then
    vim.o[last_position] = ""
  end

  if position == "winbar" then
    vim.o.winbar = SEGMENT_EXPR
  else
    -- laststatus=2 guarantees the statusline actually renders with a single
    -- window open; cheap insurance rather than relying on Neovim's default.
    vim.o.laststatus = 2
    -- Keep the filename/position info Neovim's built-in ruler normally
    -- shows -- moving the monitor to the bottom shouldn't cost you that.
    vim.o.statusline = "%f %h%m%r%=" .. SEGMENT_EXPR .. "  %l:%c %p%%"
  end
  last_position = position
end

local function define_highlights(hl)
  -- link, don't hardcode colors, so the active theme (rose-pine etc.) still
  -- governs the actual palette; these are just sane fallbacks.
  vim.api.nvim_set_hl(0, hl.active_name, { link = "Title", default = true })
  vim.api.nvim_set_hl(0, hl.active_cost, { link = "Number", default = true })
  vim.api.nvim_set_hl(0, hl.dim, { link = "Comment", default = true })
end

function M.refresh()
  local opts = config.options
  local status = reader.read_status(opts.status_file)
  local selection = reader.select_sessions(status, opts)
  cache.selection = selection
  cache.statusline = format.statusline_string(selection, opts)
  cache.plain = format.plain_string(selection, opts)
end

--- For vim.o.statusline / vim.o.winbar, e.g.:
---   vim.o.statusline = "%{%v:lua.require('claude-token-monitor').get_statusline()%}"
function M.get_statusline()
  return cache.statusline
end

--- For anything that wants plain text with no inline highlight codes
--- (lualine components, a manually-styled winbar, etc).
function M.get_plain()
  return cache.plain
end

--- lualine component: { require("claude-token-monitor").lualine_component() }
function M.lualine_component()
  return function()
    return M.get_plain()
  end
end

function M.setup(opts)
  config.setup(opts)
  define_highlights(config.options.highlights)
  apply_position(config.options.position)

  M.refresh()

  if timer then
    timer:stop()
    timer:close()
  end
  timer = (vim.uv or vim.loop).new_timer()
  timer:start(
    0,
    config.options.poll_interval_ms,
    vim.schedule_wrap(function()
      M.refresh()
    end)
  )

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = vim.api.nvim_create_augroup("ClaudeTokenMonitorCleanup", { clear = true }),
    callback = function()
      if timer then
        timer:stop()
        timer:close()
        timer = nil
      end
    end,
  })

  vim.api.nvim_create_user_command("ClaudeTokenMonitorRefresh", M.refresh, {
    desc = "Re-read status.json immediately instead of waiting for the next poll",
  })
end

return M
