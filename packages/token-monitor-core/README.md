# token-monitor-core

The watcher daemon and everything it directly needs: transcript parsing,
pricing, session naming, the semantic classification layer, and the terminal
status line. Part of the [claude-token-monitor suite](../../README.md) — see
that root README for how this fits with the other packages.

The watcher polls Claude Code's session transcripts, classifies and prices
every API turn, and writes the result to `state/status.json`. Everything else
in the suite — the status line, the nvim plugin, the `token-usage` skill — is a
reader of that one file.

## Pieces

| File | Role |
|---|---|
| `watcher.js` | The daemon. Polls `~/.claude/projects/**/*.jsonl` every 5s for recently-modified transcripts, classifies each one plus its subagent sidechains, names sessions, writes `state/status.json`. Holds a PID lock; exactly one may run. |
| `statusline.js` | What Claude Code invokes on every render. Reads `state/status.json` and formats it; starts the watcher if none is running. Does no parsing and makes no LLM calls. |
| `lib/transcript.js` | Parses one session `.jsonl` into per-turn totals, per-block classifiable text, user turns, and `Agent` spawns. |
| `lib/pricing.js` | Per-model $/MTok rate card and the cost math, including fast-mode premiums and dated intro windows. |
| `lib/llm-client.js` | Hand-rolled client (no SDK) for [`llama-local-server`](../llama-local-server/)'s OpenAI-compatible endpoint. `nameSession` names a block of text. |
| `lib/semantic-classifier.js` | Tags each turn's `tool_use` blocks with a purpose and each thinking block with a quality verdict, via JSON-schema structured output, one batched request per turn. |
| `lib/supervisor.js` | `ensureWatcher()` — the on-demand start called by the status line. |
| `config.js` | Every tunable. |

The only cross-package dependency is `llama-local-server`.

## Running

Nothing needs to be started by hand. Opening a Claude Code session renders the
status line, which starts the watcher, which starts the shared `llama-server`;
the chain tears itself down again once no session is live.

To run the watcher in the foreground and watch its logs instead:

```sh
node watcher.js
```

A second instance exits immediately on the `state/watcher.lock` guard rather
than racing the first. If an `llama-server` is already up on port 8090 it is
reused, not duplicated.

`install.ps1` wires the status line into `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node <suite-root>/packages/token-monitor-core/statusline.js", "refreshInterval": 2 }
```

It is idempotent; re-run it after moving the suite. It does not start anything.

### Tests

```sh
node test.js                         # 38 offline checks; no network, no watcher, no state/
node test-lifecycle.js --take-over   # end-to-end start/stop chain; takes over port 8090
```

## Configuration

All of it is in `config.js`. The knobs most likely to matter:

| Setting | Default | Meaning |
|---|---|---|
| `ACTIVE_SESSION_WINDOW_MS` | 30 min | How recently a transcript must have been written to count as active. |
| `POLL_INTERVAL_MS` | 5000 | Watcher tick. |
| `IDLE_SHUTDOWN_MS` | 2 min | Time with no live session before the watcher exits and stops the servers it manages. `0` disables idle shutdown. |
| `AGENT_ACTIVE_WINDOW_MS` | 90 s | How long a subagent transcript may go unwritten before that agent counts as finished. |
| `SEMANTIC_CLASSIFICATION_ENABLED` | `true` | `false` makes no LLM calls, reads/writes no cache, and omits the `semantic` key from `status.json` entirely. |
| `SEMANTIC_TIME_BUDGET_MS` | 8000 | Per-tick ceiling on classification backfill. |
| `RENAME_MIN_INTERVAL_MS` | 15 s | Rate-limit floor between naming calls for one session. |
| `RENAME_MIN_NEW_CHARS` | 20 | Minimum new user text before a rename round trip is worth making. |
| `RENAME_RECENT_MESSAGES` | 3 | Size of the rolling window sent to the namer. |

Environment overrides, all read at require time:

| Variable | Effect |
|---|---|
| `TOKEN_MONITOR_STATE_DIR` | Relocates `state/`. Required by any test that touches lock, cache or status files. |
| `CLAUDE_PROJECTS_DIR` | Where transcripts are read from. |
| `CLAUDE_SESSIONS_DIR` | Claude Code's live-session registry. |
| `TOKEN_MONITOR_IDLE_SHUTDOWN_MS` | Overrides `IDLE_SHUTDOWN_MS`. |
| `TOKEN_MONITOR_NO_AUTOSTART=1` | The status line will not start a watcher. |

`state/autostart.disabled` is an out-of-process pause button with the same
effect as `TOKEN_MONITOR_NO_AUTOSTART`, for when there is nowhere to set an env
var (Claude Code spawns the status line itself).

## Output contract: `state/status.json`

Rewritten atomically every tick. Consumers should tolerate unknown keys.

```jsonc
{
  "updated_at": "2026-08-12T09:31:04.512Z",
  "sessions": {
    "<session-id>": {
      "session_id": "<session-id>",
      "project":    "C--projects-claude-token-monitor",  // Claude Code's project dir name
      "name":       "Token Monitor Cleanup",             // or "(unnamed session)"
      "ended":      false,                               // no live PID in Claude Code's registry
      "last_activity": "2026-08-12T09:30:58.220Z",       // last transcript timestamp
      "mtime_ms":   1786... ,                            // transcript mtime, used for ordering
      "models":     ["claude-opus-5"],

      "totals": {
        "context":     123456,   // exact, from usage.input_tokens
        "cache_write": 45678,    // exact, 5m + 1h creation
        "cache_read":  901234,   // exact
        "thinking":    12345.6,  // estimated: prorated share of output_tokens
        "writing":     2345.1,   // estimated
        "tool_calls":  3456.3,   // estimated
        "cost_usd":    12.3456,  // exact
        "unpriced_output_tokens": 0,       // model id matched no rate-card row
        "fast_unpriced_output_tokens": 0   // fast mode, no published premium rate
      },

      // Currently-running subagents only, in UI order. Always present.
      "agents": [
        { "description": "Audit comments", "agent_type": "general-purpose",
          "tokens": 84210, "cost_usd": 1.87 }
      ],

      // Omitted entirely when SEMANTIC_CLASSIFICATION_ENABLED is false.
      // Sub-splits the prorated thinking/tool_calls figures; never a competing total.
      "semantic": {
        "thinking_productive": 0, "thinking_wasted": 0, "thinking_unclassified": 12345.6,
        "tool_explore": 0, "tool_mutate": 0, "tool_verify": 0,
        "tool_redundant": 0, "tool_other": 0, "tool_unclassified": 0
      }
    }
  }
}
```

The three estimated buckets sum to the turn's `output_tokens`; the semantic
buckets sum to their parent bucket. Ended sessions remain present, flagged,
until they age out of `ACTIVE_SESSION_WINDOW_MS` — the status bars filter them
out at render time, but other consumers want the transition.

Other files under `state/` are caches, not contract: `names-cache.json`,
`semantic-cache.json` (keyed by turn id, never invalidated — finalized turns
do not change), `watcher.lock`, `watcher-spawn.json`.

## Known limitations

- The thinking/writing/tool_calls split is an **estimate**. The API reports one
  `output_tokens` total per turn and never a per-block breakdown, so the split
  is prorated from inter-block timestamps. Context, cache read/write and cost
  are exact.
- The semantic layer's thinking-block verdict effectively never fires: under
  Claude Code's default `display: "omitted"` thinking text is not persisted to
  the transcript, only an encrypted signature, so there is nothing to classify.
  Tool-call purpose tagging works and runs live. The thinking half is left
  wired in for if that ever changes.
- Ended-session detection covers `kind: "interactive"` sessions only, since
  those are what Claude Code registers in `~/.claude/sessions/`.
- Session names come from a 3B local model given a short prompt, so a name can
  occasionally be oddly formatted on dense input. Whether a new name counts as
  a topic change is decided in code by `sameTopic`, a word-overlap heuristic:
  two genuinely different topics sharing one significant word will not trigger
  a rename.
- `llama-server` is spawned with no `-np`/`--parallel`, so the shared instance
  serves one request at a time. Naming, semantic backfill and the
  `token-usage` skill's lookups share that queue. If renaming feels sluggish
  with several sessions open, raising `-np` is the lever — not lowering
  `RENAME_MIN_INTERVAL_MS`.
