local M = {}

function M.check()
  local health = vim.health or require("vim.health")
  local start = health.start or health.report_start
  local ok = health.ok or health.report_ok
  local warn = health.warn or health.report_warn
  local error_ = health.error or health.report_error

  start("claude-token-monitor")

  local config = require("claude-token-monitor.config")
  local reader = require("claude-token-monitor.reader")
  local opts = config.options

  local f = io.open(opts.status_file, "r")
  if not f then
    error_("status.json not found at " .. opts.status_file, "Is the watcher (watcher.js) running?")
    return
  end
  f:close()
  ok("status.json found at " .. opts.status_file)

  local status = reader.read_status(opts.status_file)
  if not status then
    error_("status.json exists but failed to parse", "Watcher may be mid-write; try again")
    return
  end
  ok("status.json parsed successfully")

  local stat = vim.uv.fs_stat(opts.status_file)
  if stat then
    local age_s = os.time() - stat.mtime.sec
    if age_s > 30 then
      warn(string.format("status.json is %ds old -- watcher may have stopped", age_s))
    else
      ok(string.format("status.json last written %ds ago", age_s))
    end
  end

  local n = vim.tbl_count(status.sessions or {})
  if n == 0 then
    warn("watcher is running but reports no active sessions")
  else
    ok(n .. " active session(s) tracked")
  end

  local session_id = reader.detect_session_id()
  if session_id then
    ok("CLAUDE_CODE_SESSION_ID set -- active session detected exactly: " .. session_id)
  else
    warn("CLAUDE_CODE_SESSION_ID not set -- falling back to cwd-matching heuristic (project: " .. reader.sanitize_cwd(vim.fn.getcwd()) .. ")")
  end
end

return M
