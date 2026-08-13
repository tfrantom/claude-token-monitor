local M = {}

-- Drops a trailing ".0" -- on a space-constrained line "150M" beats "150.0M",
-- and one decimal is only meaningful below ~10 of a unit anyway.
local function scale(v, suffix)
  if v >= 10 then
    return string.format("%d%s", math.floor(v + 0.5), suffix)
  end
  return (string.format("%.1f", v):gsub("%.0$", "")) .. suffix
end

function M.fmt_num(n)
  n = n or 0
  if n >= 1e6 then
    return scale(n / 1e6, "M")
  elseif n >= 1000 then
    return scale(n / 1000, "k")
  end
  return tostring(math.floor(n + 0.5))
end

-- Cost without trailing cents noise; matches statusline.js's fmtCostShort.
function M.fmt_cost_short(n)
  n = n or 0
  if n >= 10 then
    return string.format("$%d", math.floor(n + 0.5))
  end
  return string.format("$%.1f", n)
end

function M.fmt_cost(n)
  return string.format("$%.2f", n or 0)
end

local function total_tokens(t)
  return (t.context or 0) + (t.cache_write or 0) + (t.cache_read or 0) + (t.thinking or 0) + (t.writing or 0) + (t.tool_calls or 0)
end

-- Semantic layer only ever annotates the thinking bucket's existing total
-- (see token-classifier-demo/PLAN.md §4), so with no classified turns yet
-- (cold start, or llama-server unreachable) this falls back to the plain
-- number instead of showing a misleading 0%.
local function fmt_thinking(thinking, sem)
  local classified = sem and ((sem.thinking_productive or 0) + (sem.thinking_wasted or 0)) or 0
  if classified < 1 then
    return "thk " .. M.fmt_num(thinking)
  end
  local pct = math.floor((sem.thinking_productive / classified) * 100 + 0.5)
  return string.format("thk %s (%d%%p)", M.fmt_num(thinking), pct)
end

-- Per-agent pairs, "<tokens>-<cost>", in the order the Claude Code UI shows
-- them. Only the active session gets these -- see build_segments.
local function agent_pairs(agents)
  if not agents or #agents == 0 then
    return nil
  end
  local parts = {}
  for _, a in ipairs(agents) do
    table.insert(parts, M.fmt_num(a.tokens) .. "-" .. M.fmt_cost_short(a.cost_usd):gsub("^%$", ""))
  end
  return table.concat(parts, "/")
end

local function active_breakdown(s)
  local t = s.totals
  local pairs_str = agent_pairs(s.agents)
  local tail = M.fmt_num(total_tokens(t)) .. "/" .. M.fmt_cost_short(t.cost_usd)
  if pairs_str then
    return pairs_str .. " · " .. tail
  end
  return tail
end

--- Builds an ordered list of {text, hl} segments -- the highlight-agnostic
--- shape both the native-statusline renderer and the lualine component
--- flatten differently, so the layout logic lives here once.
function M.build_segments(selection, opts)
  local icons = opts.icons
  local hl = opts.highlights
  local segments = {}

  if selection.active then
    local s = selection.active
    table.insert(segments, { text = icons.active .. " " .. s.name, hl = hl.active_name })
    table.insert(segments, { text = " (" .. active_breakdown(s) .. ")", hl = hl.dim })
  end

  local grand_total = 0
  if selection.active then
    grand_total = grand_total + selection.active.totals.cost_usd
  end

  for _, s in ipairs(selection.others) do
    if #segments > 0 then
      table.insert(segments, { text = icons.separator, hl = hl.dim })
    end
    -- Non-active sessions collapse to a count badge ("3A") instead of listing
    -- their agents: detail belongs where you're looking, and N tabs each
    -- rendering N agent lists would make the line unusable.
    local badge = (s.agents and #s.agents > 0) and (" " .. #s.agents .. "A") or ""
    table.insert(segments, { text = s.name .. badge .. " " .. M.fmt_cost_short(s.totals.cost_usd), hl = hl.dim })
    grand_total = grand_total + s.totals.cost_usd
  end

  if selection.active or #selection.others > 0 then
    table.insert(segments, { text = icons.separator, hl = hl.dim })
    table.insert(segments, { text = icons.total .. " " .. M.fmt_cost(grand_total), hl = hl.dim })
  end

  return segments
end

--- For vim.o.statusline / vim.o.winbar: %#Group#text%* segments concatenated.
function M.statusline_string(selection, opts)
  local segments = M.build_segments(selection, opts)
  if #segments == 0 then
    return "%#" .. opts.highlights.dim .. "#token-monitor: no active sessions%*"
  end
  local parts = {}
  for _, seg in ipairs(segments) do
    table.insert(parts, "%#" .. seg.hl .. "#" .. seg.text .. "%*")
  end
  return table.concat(parts)
end

--- For lualine or anywhere else that wants one plain string with no vim
--- statusline escape codes (coloring is per-component there, not inline).
function M.plain_string(selection, opts)
  local segments = M.build_segments(selection, opts)
  if #segments == 0 then
    return "token-monitor: no active sessions"
  end
  local parts = {}
  for _, seg in ipairs(segments) do
    table.insert(parts, seg.text)
  end
  return table.concat(parts)
end

return M
