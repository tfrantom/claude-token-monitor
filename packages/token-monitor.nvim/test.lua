-- Offline checks for the renderer. Driven by test.js, which finds nvim.
--
--   nvim --clean --headless -c "luafile test.lua" -c "qa!"

package.path = "lua/?.lua;lua/?/init.lua;" .. package.path

local reader = require("claude-token-monitor.reader")
local format = require("claude-token-monitor.format")
local config = require("claude-token-monitor.config")

local passed, failures = 0, {}

local function check(name, fn)
  local ok, err = pcall(fn)
  if ok then
    passed = passed + 1
  else
    table.insert(failures, { name = name, err = tostring(err) })
  end
end

local function assert_eq(got, want, what)
  if got ~= want then
    error(string.format("%s: got %s, want %s", what or "value", vim.inspect(got), vim.inspect(want)), 2)
  end
end

config.setup({})
local opts = config.options

local function session(over)
  local s = {
    session_id = "s1",
    name = "Session",
    ended = false,
    mtime_ms = os.time() * 1000,
    totals = { context = 1000, cache_write = 0, cache_read = 0, thinking = 0, writing = 0, tool_calls = 0, cost_usd = 12.5 },
    agents = {},
    activity = nil,
  }
  for k, v in pairs(over or {}) do
    s[k] = v
  end
  return s
end

local function render(s, o)
  return format.plain_string({ active = s, others = {} }, o or opts)
end

-- --------------------------------------------------------- the vim.NIL trap --

check("vim.json.decode turns JSON null into truthy userdata", function()
  local decoded = vim.json.decode('{"state":null}')
  -- The whole reason denil() exists. If this ever stops being true, the
  -- normalisation is harmless, but the guards elsewhere can be simplified.
  assert_eq(type(decoded.state), "userdata", "decoded null type")
  assert_eq(decoded.state and true or false, true, "vim.NIL truthiness")
end)

check("denil maps nulls to nil, recursively", function()
  local d = reader.denil(vim.json.decode('{"a":null,"b":{"c":null,"d":"keep"},"e":[null,"x"]}'))
  assert_eq(d.a, nil, "top-level null")
  assert_eq(d.b.c, nil, "nested null")
  assert_eq(d.b.d, "keep", "sibling string survives")
  assert_eq(d.e[2], "x", "array element survives")
end)

check("an all-null activity renders instead of throwing", function()
  -- The live regression: every session that has published nothing has this
  -- exact shape, so an unguarded concat broke the bar for everyone.
  local raw = vim.json.decode('{"state":null,"detail":null,"source":null,"at":null,"agents":[]}')
  local out = render(session({ activity = raw }))
  assert_eq(out:find("Session") ~= nil, true, "session name still rendered")
end)

check("the same session renders identically active or not", function()
  -- `●` used to be both the active-session marker and the no-activity
  -- fallback, so one session showed `●` in its own bar and nothing in every
  -- other bar. One glyph, one meaning.
  local d = reader.denil(vim.json.decode('{"state":null,"detail":null}'))
  local active = format.plain_string({ active = session({ activity = d }), others = {} }, opts)
  assert_eq(active:find(opts.icons.active, 1, true), nil, "no activity means no glyph, even when active")

  local s = session({ activity = { state = "done" } })
  local as_active = format.plain_string({ active = s, others = {} }, opts)
  local as_other = format.plain_string({ active = nil, others = { s } }, opts)
  local g = opts.activity_icons.done
  assert_eq(as_active:find(g, 1, true) ~= nil, true, "glyph when active")
  assert_eq(as_other:find(g, 1, true) ~= nil, true, "same glyph when not active")
end)

-- ------------------------------------------------------------- activity UI --

check("each known state renders its own glyph", function()
  for _, state in ipairs({ "working", "waiting_user", "waiting_agents", "done", "blocked" }) do
    local out = render(session({ activity = { state = state, detail = nil } }))
    local want = opts.activity_icons[state]
    assert_eq(out:find(want, 1, true) ~= nil, true, "glyph for " .. state)
  end
end)

check("an unknown state renders the fallback glyph, not nothing", function()
  local out = render(session({ activity = { state = "deploying" } }))
  assert_eq(out:find(opts.activity_icons.unknown, 1, true) ~= nil, true, "unknown glyph")
end)

check("detail is rendered, and a null detail is not", function()
  local with = render(session({ activity = { state = "done", detail = "all finished" } }))
  assert_eq(with:find("all finished", 1, true) ~= nil, true, "detail shown")

  local d = reader.denil(vim.json.decode('{"state":"done","detail":null}'))
  local without = render(session({ activity = d }))
  assert_eq(without:find("nil", 1, true), nil, "no stringified nil leaked into the bar")
end)

check("show_activity=false suppresses the marker entirely", function()
  local o = vim.tbl_deep_extend("force", vim.deepcopy(opts), { show_activity = false })
  local out = format.plain_string({ active = session({ activity = { state = "done" } }), others = {} }, o)
  assert_eq(out:find(opts.activity_icons.done, 1, true), nil, "marker should be gone")
end)

check("show_activity_detail=false keeps the glyph but drops the text", function()
  local o = vim.tbl_deep_extend("force", vim.deepcopy(opts), { show_activity_detail = false })
  local out = format.plain_string({ active = session({ activity = { state = "done", detail = "secret" } }), others = {} }, o)
  assert_eq(out:find("secret", 1, true), nil, "detail should be gone")
  assert_eq(out:find(opts.activity_icons.done, 1, true) ~= nil, true, "glyph should remain")
end)

check("non-active sessions get a glyph but never the detail text", function()
  local other = session({ session_id = "s2", name = "Other", activity = { state = "done", detail = "chatty" } })
  local out = format.plain_string({ active = nil, others = { other } }, opts)
  assert_eq(out:find(opts.activity_icons.done, 1, true) ~= nil, true, "glyph on non-active session")
  assert_eq(out:find("chatty", 1, true), nil, "detail must not appear for non-active sessions")
end)

-- ------------------------------------------------------------------ output --

if #failures > 0 then
  for _, f in ipairs(failures) do
    print("  FAIL  " .. f.name)
    print("        " .. f.err)
  end
  print(string.format("token-monitor.nvim: %d/%d passed, %d FAILED", passed, passed + #failures, #failures))
  vim.cmd("cq")
end

print(string.format("token-monitor.nvim: %d/%d checks passed", passed, passed))
