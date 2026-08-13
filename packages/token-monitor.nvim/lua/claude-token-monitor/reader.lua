local M = {}

--- Returns nil on any failure (missing, empty, mid-write) rather than
--- erroring. nil means "no data this tick", not a bug.
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

--- Mirrors Claude Code's own project-directory naming: ":" and path
--- separators become "-" (e.g. "C:\projects" -> "C--projects").
function M.sanitize_cwd(path)
  return (path:gsub("[:\\/]", "-"))
end

--- Set only when Neovim was launched from inside a Claude Code session, so
--- nil is the common case and callers must have a fallback.
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

--- Picks the active session, orders the rest most-recent-first. Active is:
---   1. exact match on CLAUDE_CODE_SESSION_ID, if set
---   2. most-recently-active session whose project matches Neovim's cwd
---   3. nil -- nothing highlighted, all listed the same way
function M.select_sessions(status, opts)
  if not status or not status.sessions then
    return { active = nil, others = {} }
  end

  local now_ms = os.time() * 1000
  local sessions = {}
  for _, s in pairs(status.sessions) do
    -- Ended sessions stay in status.json on purpose; each consumer drops
    -- them itself. See CLAUDE.md "Staleness is the plugin's own problem".
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
