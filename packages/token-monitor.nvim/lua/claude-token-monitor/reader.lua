local M = {}

-- vim.json.decode maps JSON null to vim.NIL, a userdata sentinel that is
-- TRUTHY in Lua -- only nil and false are falsy. So `if v then` passes for a
-- field that is not there, and the value reaches string concatenation as
-- userdata. Normalising here rather than at each use site is deliberate: this
-- is the one choke point, and status.json grows nullable fields over time.
local function denil(v)
  if v == vim.NIL then
    return nil
  end
  if type(v) ~= "table" then
    return v
  end
  for k, inner in pairs(v) do
    v[k] = denil(inner)
  end
  return v
end

M.denil = denil

-- nil on any failure (missing, empty, mid-write) -- "no data this tick", not an error.
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
  return denil(decoded)
end

-- Must mirror Claude Code's own project-directory naming: "C:\projects" -> "C--projects".
function M.sanitize_cwd(path)
  return (path:gsub("[:\\/]", "-"))
end

-- nil unless Neovim was launched from inside a Claude Code session, so callers need a fallback.
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

-- see CLAUDE.md "Picking the active session"
function M.select_sessions(status, opts)
  if not status or not status.sessions then
    return { active = nil, others = {} }
  end

  local now_ms = os.time() * 1000
  local sessions = {}
  for _, s in pairs(status.sessions) do
    -- see CLAUDE.md "Staleness is the plugin's own problem"
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
