# llama-local-server

Starts, reuses, and stops local `llama-server` (llama.cpp) instances, and
records machine-wide who owns each one. Once up, an instance is a plain
OpenAI-compatible HTTP endpoint at
`http://127.0.0.1:8090/v1/chat/completions` (plus `/v1/completions`, `/health`,
`/props`) — stock `llama-server`, not a shim. Part of the
[claude-token-monitor suite](../../README.md); it depends on nothing else in
it.

## Requirements

- Windows (`llama-server.exe`, `netstat`)
- Node 18+
- A `llama.cpp` build, and a GGUF on disk (by default the blob `ollama pull
  llama3.2` already fetched)

No install step and no dependencies.

## Usage

```js
const { ensureRunning, BASE_URL } = require('./server');
await ensureRunning();                             // idempotent
fetch(`${BASE_URL}/v1/chat/completions`, { ... });

const managed = require('./managed');
await managed.ensureShared({ startedBy: 'watcher pid 123' });   // :8090, on-disk ownership
await managed.reap();
```

```sh
node ports.js                # the claim table with live status
node ports.js chat-shared    # just the port number, for shell use
node ports.js --suggest      # first port free by registry and by TCP probe
node managed.js              # what is running and who owns it
node managed.js --reap       # stop anything idle past its TTL
node managed.js --stop-all   # stop everything this suite started
node test.js                 # 33 offline checks: no server, no network
```

## Configuration

`config.js` resolves each value in order: environment variable →
`config.local.js` (gitignored) → discovery.

| Value | Default |
|---|---|
| `LLAMA_SERVER_EXE` | Discovered: the usual `llama.cpp` build layouts (`LLAMA_CPP_DIR`, a sibling checkout, `~/llama.cpp`, …) then `PATH`. |
| `LLAMA_MODEL` | `llama3.2:latest` — an Ollama reference, not a path. |
| `LLAMA_MODEL_PATH` | Discovered: Ollama's manifest for `LLAMA_MODEL` → its blob; failing that, the first `.gguf` in a `models/` dir. |
| `LLAMA_HOST` | `127.0.0.1` |
| `LLAMA_PORT` | `8090` (cross-checked against the `chat-shared` claim) |
| `LLAMA_RUNTIME_DIR` | `~/.claude/llama-local-server` |

## Contributing

[`CLAUDE.md`](CLAUDE.md) has the API reference, the port registry rules, the
ownership and reap policies, and the traps — read it before changing anything.
