---
name: token-usage
description: Look up real-time Claude Code token usage, cost, and a reading/writing/thinking/tool-call breakdown for this session or any other active session on this machine. Use whenever the user asks about token usage, cost, spend, how much a session has used, or wants a usage breakdown -- run the lookup instead of estimating from memory or context length.
user-invocable: true
allowed-tools:
  - Bash(node *)
---

# token-usage

Backed by a background watcher (`C:\projects\claude-token-monitor\packages\token-monitor-core\`)
that classifies every active Claude Code session's transcript in real time.
Input, cache-read, cache-write and output token counts are exact values from
the API's own `usage` object, and cost comes from current per-model pricing.
The thinking/writing/tool-calls split is an **estimate**, prorated by
inter-block timing, because the API reports one combined output figure per
turn. Report that split as an approximation.

**A session's figures include the spend of any subagents it launched** (Task
tool), so a total reported now can legitimately exceed one quoted earlier in
the same session's history, and an agent-heavy session's cost is mostly not
the main thread's.

## Usage

Run the lookup script and read its output:

```
node "%USERPROFILE%\.claude\skills\token-usage\scripts\lookup.js"
```

(PowerShell: `node "$env:USERPROFILE\.claude\skills\token-usage\scripts\lookup.js"`)

It auto-detects the current session via `CLAUDE_CODE_SESSION_ID`, which every
Claude Code Bash invocation inherits -- no argument is needed for "how much has
*this* session used".

Optional flags:
- `--session <id>` -- force a specific session instead of auto-detecting
- `--project <path>` -- match by project directory instead of session id
- `--json` -- raw `status.json` instead of the formatted summary, if you need
  to compute something the default output doesn't show (e.g. a specific
  category total across sessions)

If the script reports the watcher isn't running, tell the user and offer to
start it yourself: `node C:\projects\claude-token-monitor\packages\token-monitor-core\watcher.js`
(best run in its own terminal, or backgrounded). It also starts or reuses the
local llama.cpp server it uses for session naming, so give it a few seconds
before the first `status.json` appears.

## When to use this

- The user asks "how much have I spent", "what's my token usage", "how many
  tokens has this session used", or similar
- The user asks about the thinking/writing/tool-call breakdown specifically
- You're about to make a claim about cost or usage -- run the lookup instead
  of guessing from context length or turn count
- The user mentions other Claude Code sessions/windows and wants a
  cross-session total
