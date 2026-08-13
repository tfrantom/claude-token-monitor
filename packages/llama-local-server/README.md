# llama-local-server

Starts, reuses, and stops local `llama-server` (llama.cpp) instances. The
reusable piece: everything else in the [suite](../../README.md) is a *client*
of this, and this package depends on nothing else here.

`server.js` spawns `llama-server.exe` from a local `llama.cpp` build, pointed
at a GGUF already on disk (by default the blob Ollama pulled — no second
download, no Ollama API involved). Once up it is a plain OpenAI-compatible HTTP
endpoint at `http://127.0.0.1:8090/v1/chat/completions` (plus
`/v1/completions`, `/health`, `/props`) — stock `llama-server`, not a shim.
`managed.js` adds machine-wide lifecycle: who started an instance, whether
anyone still wants it, and who may stop it.

```js
const { ensureRunning, BASE_URL } = require('./server');
await ensureRunning();                             // idempotent
fetch(`${BASE_URL}/v1/chat/completions`, { ... }); // hand-rolled, no SDK in this suite
```

## API

### `server.js` — start or reuse

| Function | Returns | Notes |
|---|---|---|
| `ensureRunning(opts)` | `{ owned, proc, baseUrl }` | Reuses whatever is already on the port. `owned` is true only if *this* call started it. |
| `ensureRunningFor(name, opts)` | same | Takes the port from [`ports.js`](ports.js) by claim name and checks availability *before* spawning. Preferred for anything but the shared instance. |
| `isUp(port, host)` | `boolean` | One `/health` request. |
| `baseUrlFor(port, host)` | `string` | |
| `BASE_URL` | `string` | The default instance's URL. |

`opts`: `{ host, port, modelPath, exePath, alias, contextSize, gpuLayers,
extraArgs, detached, timeoutMs }`. Every option defaults to the shared chat
instance on 8090, so `ensureRunning()` with no arguments is the common case.

```js
// dedicated embedding server -- --embedding is an exclusive server *mode*,
// so embeddings need their own process, port, and model
ensureRunning({ port: 8091, modelPath: EMBED_GGUF,
                extraArgs: ['--embedding', '-b', '2048', '-ub', '2048'],
                detached: true });

// bigger model for one specific job
ensureRunning({ port: 8092, modelPath: MISTRAL_GGUF,
                contextSize: 16384, detached: true });
```

`detached: false` (the default) means the child dies with the parent, which is
right for a long-lived daemon. One-shot CLI callers want `true`, or the server
dies on every process exit and each invocation re-pays the model load.

A bad `exePath` fails fast: the `'error'` event is captured and re-thrown as
`failed to start llama-server (<path>): <reason>` in about a second, rather
than sitting out the 30s health timeout.

### `managed.js` — lifecycle across processes

Ownership is recorded **on disk**, one JSON record per port claim in
`~/.claude/llama-local-server/`, because the processes that start these servers
(a status line render, a one-shot skill call) are far shorter-lived than the
server. A record is what permits a later, unrelated process to stop it; **no
record means no kill**.

| Function | Notes |
|---|---|
| `ensureManaged(name, opts)` | Start-or-reuse the instance for a claim and record ownership. Returns `{ claim, baseUrl, port, pid, started, managed }`. |
| `ensureShared(opts)` | `ensureManaged('chat-shared')` — the shared chat instance on 8090. |
| `touch(name)` | "Still wanted": restarts the idle clock. Throttled to one write per 30s. |
| `reap(opts)` | Stop `idle` instances past their TTL, clear records whose process is gone. Safe to call from anywhere; the watcher calls it every tick. |
| `stopManaged(name, opts)` | Stop one instance *if* this suite recorded starting it. Never throws. |
| `stopShared(opts)` | `stopManaged('chat-shared')`. |
| `stopAll(opts)` | Stop every managed instance. The watcher's shutdown path. |
| `status(name)` / `statusAll()` | Recorded pid, liveness, policy, idle age. No network. |
| `isUpFor(name)` | Whether the server is actually answering, as opposed to the pid merely existing. |

`opts` for `ensureManaged`: `startedBy`, `waitMs`, `policy`, `idleTtlMs`, plus
anything `ensureRunning` takes.

Two reap policies:

- **`supervised`** — the shared chat instance. Never idle-reaped (it exists to
  be warm); it dies with the watcher.
- **`idle`** — dedicated instances a one-shot CLI stands up and walks away
  from. Stopped after `idle_ttl_ms` (default 15 min) with no `touch()`.

```js
await managed.ensureShared({ startedBy: 'watcher pid 123' });
await managed.ensureManaged('my-embed', { policy: 'idle', idleTtlMs: 5 * 60_000 });
managed.touch('my-embed');
await managed.reap();
await managed.stopAll({ reason: 'no Claude sessions running' });
```

### CLI

```sh
node ports.js                # the claim table with live status
node ports.js chat-shared    # just the port number, for shell use
node ports.js --suggest      # first port free by registry and by TCP probe
node managed.js              # what is running and who owns it
node managed.js --reap       # stop anything idle past its TTL
node managed.js --stop-all   # stop everything this suite started
node test.js                 # 33 offline checks: no server, no network
```

## Ports

Ports are claimed declaratively in [`ports.js`](ports.js); consumers read
theirs back with `portFor(name)` rather than hardcoding a number. Two claims on
one port throw on require instead of failing at spawn, and `assertAvailable()`
names whoever holds a port rather than letting `llama-server` fail to bind.

| Port | Owner | Model / mode |
|---|---|---|
| 8090 | this package (shared) | `llama3.2` 3B Q4, chat, 4096 ctx, `-ngl 999` |
| 8099 | **reserved** — held by a process outside this suite | — |

A dedicated instance spawned `detached: true` stays resident until an explicit
kill, so expect more than one `llama-server.exe` on a busy machine. Kill by PID
or port, **never** by image name.

There is no runtime model-switching within an instance: changing what 8090
serves means setting `LLAMA_MODEL` (or `LLAMA_MODEL_PATH`) and restarting it. A
consumer needing a different model gets its own instance instead. A 7B at 16k
plus an embedding instance coexist with the shared 3B inside 16 GB of VRAM; a
fourth needs a VRAM policy, not just a port.

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
| `LLAMA_RUNTIME_DIR` | `~/.claude/llama-local-server` — machine-level, so installed skill copies and separate repos coordinate through the same records. |

`resolveOllamaModel(ref, { modelsDir })` is exported for callers that need a
different model: use it rather than pasting a blob digest, which is correct on
exactly one machine. Resolution failure yields `null`, and the *spawn* reports
it — never `require` time.

## Why this is its own package

The capability — a low-latency, standing local LLM endpoint anything on the
machine can hit — has nothing to do with token monitoring specifically. Keeping
it separate is what lets the `projects/` extensions, and two repositories that
vendor this package verbatim, depend on "the local model server" without
dragging in the watcher, transcript parsing, or any of that config.
