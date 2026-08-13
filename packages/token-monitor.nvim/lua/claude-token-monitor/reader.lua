local M = {}

--- Reads and parses the watcher's status.json. Returns nil on any failure
--- (missing file, watcher not running yet, mid-write) rather than erroring --
--- callers should treat nil as "no data available this tick", not a bug.
function M.read_status(path)
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local content = f:read("*a")
  f:close()
  if not content or content == "" then
    return nil
  end
  local ok, decoded = pcall(vim.json.decode, content)
  if not ok then
    return nil
  end
  return decoded
end

--- Mirrors Claude Code's own project-directory naming: the absolute cwd with
--- ":" and path separators replaced by "-" (e.g. "C:\projects" -> "C--projects").
--- Used to guess which watcher-tracked session belongs to Neovim's cwd when
--- CLAUDE_CODE_SESSION_ID isn't set in the environment (see detect_session_id).
function M.sanitize_cwd(path)
  return (path:gsub("[:\\/]", "-"))
end

--- Exact when available: Neovim inherits this only when launched from inside
--- a Claude Code session (e.g. inside its own Bash tool). For the common case
--- of Neovim in its own terminal, this is nil and callers fall back to a
--- cwd-matching heuristic instead.
function M.detect_session_id()
  local id = vim.env.CLAUDE_CODE_SESSION_ID
  if id and id ~= "" then
    return id
  end
  return nil
end

local function is_stale(session, now_ms, stale_after_ms)
  local mtime = session.mtime_ms or 0
  return (now_ms - mtime) > stale_after_ms
end

--- Picks the "active" session and orders the rest most-recent-first.
--- Active session resolution order:
---   1. exact match on CLAUDE_CODE_SESSION_ID, if the env var is set
---   2. most-recently-active session under a project matching Neovim's cwd
---   3. nil -- no session is highlighted as active, all listed the same way
function M.select_sessions(status, opts)
  if not status or not status.sessions then
    return { active = nil, others = {} }
  end

  local now_ms = os.time() * 1000
  local sessions = {}
  for _, s in pairs(status.sessions) do
    -- `ended` sessions are filtered out here rather than upstream: the
    -- watcher deliberately keeps them in status.json so other consumers can
    -- see the ended transition, so each status bar drops them on its own.
    if not s.ended and not is_stale(s, now_ms, opts.stale_after_ms) then
      table.insert(sessions, s)
    end
  end
  table.sort(sessions, function(a, b)
    return (a.mtime_ms or 0) > (b.mtime_ms or 0)
  end)

  local active, others = nil, {}
  local want_id = M.detect_session_id()
  local want_project = not want_id and M.sanitize_cwd(vim.fn.getcwd()) or nil

  for _, s in ipairs(sessions) do
    if not active and want_id and s.session_id == want_id then
      active = s
    elseif not active and want_project and s.project == want_project then
      active = s
    else
      table.insert(others, s)
    end
  end

  if opts.max_other_sessions and #others > opts.max_other_sessions then
    local trimmed = {}
    for i = 1, opts.max_other_sessions do
      trimmed[i] = others[i]
    end
    others = trimmed
  end

  return { active = active, others = others }
end

return M
