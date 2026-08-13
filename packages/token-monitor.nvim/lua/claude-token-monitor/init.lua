local config = require("claude-token-monitor.config")
local reader = require("claude-token-monitor.reader")
local format = require("claude-token-monitor.format")

local M = {}

-- The statusline functions run on every redraw and must only read this cache.
local cache = { statusline = "", plain = "", selection = { active = nil, others = {} } }

local timer = nil
local last_position = nil

local SEGMENT_EXPR = "%{%v:lua.require('claude-token-monitor').get_statusline()%}"

local function apply_position(position)
  if last_position and last_position ~= position then
    vim.o[last_position] = ""
  end

  if position == "winbar" then
    vim.o.winbar = SEGMENT_EXPR
  else
    vim.o.laststatus = 2
    vim.o.statusline = "%f %h%m%r%=" .. SEGMENT_EXPR .. "  %l:%c %p%%"
  end
  last_position = position
end

local function define_highlights(hl)
  vim.api.nvim_set_hl(0, hl.active_name, { link = "Title", default = true })
  vim.api.nvim_set_hl(0, hl.active_cost, { link = "Number", default = true })
  vim.api.nvim_set_hl(0, hl.dim, { link = "Comment", default = true })
  vim.api.nvim_set_hl(0, hl.activity_done, { link = "DiagnosticOk", default = true })
  vim.api.nvim_set_hl(0, hl.activity_working, { link = "DiagnosticInfo", default = true })
  vim.api.nvim_set_hl(0, hl.activity_waiting, { link = "DiagnosticWarn", default = true })
  vim.api.nvim_set_hl(0, hl.activity_blocked, { link = "DiagnosticError", default = true })
end

-- A formatter error must not blank the bar. refresh() runs on a timer via
-- vim.schedule, so an uncaught error there surfaces as a callback traceback on
-- every tick and leaves the cache holding nothing -- which reads as "the plugin
-- is dead" rather than "one field was the wrong shape". status.json is written
-- by a separate process that gains keys independently of this plugin, so the
-- shape is not something this side gets to assume.
function M.refresh()
  local opts = config.options
  local status = reader.read_status(opts.status_file)
  local selection = reader.select_sessions(status, opts)
  cache.selection = selection

  local ok, err = pcall(function()
    cache.statusline = format.statusline_string(selection, opts)
    cache.plain = format.plain_string(selection, opts)
  end)
  if not ok then
    local msg = "token-monitor: render failed"
    cache.statusline = "%#" .. opts.highlights.dim .. "#" .. msg .. "%*"
    cache.plain = msg
    if not cache.reported_error then
      cache.reported_error = true
      vim.notify(msg .. ": " .. tostring(err), vim.log.levels.WARN)
    end
  else
    cache.reported_error = false
  end
end

function M.get_statusline()
  return cache.statusline
end

function M.get_plain()
  return cache.plain
end

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
