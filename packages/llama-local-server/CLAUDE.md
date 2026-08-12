# llama-local-server — working notes for Claude

Spawns or reuses `llama-server.exe` (llama.cpp), a thin OpenAI-compatible
endpoint over a GGUF already on disk. This is the actual reusable
infrastructure in the suite — everything else is a client of it. It depends on
nothing else here. See [`README.md`](README.md) and the [suite
CLAUDE.md](../../CLAUDE.md).

## Use `ensureRunning`, never your own spawn

Copying the spawn logic is the mistake this package exists to prevent. Every
option defaults to the shared chat instance, so `ensureRunning()` with no
arguments is the common case, and the differences get passed in:

```js
ensureRunning()                                        // shared chat, :8090
ensureRunning({ port: 8091, modelPath: EMBED,          // dedicated embedding server
                extraArgs: ['--embedding'], detached: true })
```

Multi-instance is by design, not an accident: `--embedding` is an exclusive
server *mode*, so embeddings need their own process, port, and model.

Prefer `ensureRunningFor(name, opts)` for anything that is not the shared chat
instance. It takes the port from the registry in `ports.js` by name and checks
availability *before* spawning. That pre-check is the whole point — without it
a taken port means `llama-server.exe` fails to bind, exits immediately, and the
health loop burns the full 30s to report "did not become healthy": true and
useless. Worse, if the squatter is some *other* llama-server, `isUp()` says yes
and you silently get answers from the wrong model.

## Spawn failures arrive as an event, not a throw

A bad exe path surfaces as an `'error'` event on the ChildProcess. Unhandled,
that is a hard crash with a stack trace; two separate agents hit it
independently before it was fixed. The handler captures it so the health loop
can fail fast (~0.5s) with a clean message naming the path, rather than sitting
through the timeout waiting for a process that never started. Keep it.

## For the shared instance, use `managed.js` — not `ensureRunning` directly

`ensureRunning`'s `owned` flag is a **per-process** contract: the child handle
comes back only when this call is what started it, and if `owned` is false you
reused someone else's server and must not kill it. That is right for "don't
kill what you didn't start", and it cannot express the thing the shared chat
instance actually needs, which is "live as long as some Claude Code session
needs you". A watcher that reused a server started ten minutes earlier by a
one-shot skill call has `owned === false` and leaves ~2.5 GB resident forever.

`managed.js` records ownership **on disk** instead, one record per port claim
in `~/.claude/llama-local-server/<claim>.json`, so it survives the process that
created it and an abrupt kill of that process:

```js
await managed.ensureShared({ startedBy: 'watcher pid 123' })      // :8090
await managed.ensureManaged('my-embed', { policy: 'idle', … })    // any claim
managed.touch('my-embed')          // "still wanted" -- restarts the idle clock
await managed.reap()               // stop whatever went idle past its TTL
await managed.stopAll({ reason: 'no Claude sessions running' })
```

Two policies, and picking the wrong one is the mistake to avoid:

- **`supervised`** — lifetime tied to a supervisor that is itself tied to
  something real. Only the shared chat instance. Never idle-reaped: it exists
  to be warm, and reaping it after a quiet spell means paying a model load the
  next time the user types a word.
- **`idle`** — for anything a one-shot CLI stands up and walks away from.
  Reaped after `idle_ttl_ms` with no `touch()`. Without this, "outlives its
  caller" means "resident until reboot".

Any process may call `reap()`; the watcher does it every tick, which makes it
the de-facto reaper on this machine — including for instances started by
installed skill copies and by separate repositories, since the records are
machine-level.

Rules that fall out of it, none of them optional:

- **No record means no kill.** A `llama-server` someone started by hand on 8090
  is reused and left alone.
- **`stopShared` verifies the recorded pid is the one holding the port** before
  signalling it (netstat `LISTENING` row, never an `ESTABLISHED` one — those
  carry the *client's* pid, usually the watcher's). Recycled pids are the one
  way an automatic shutdown could kill something innocent.
- **Anything that spawns the shared instance must write the record**, including
  copies that cannot `require` across the repo boundary. `local-inference-skill`
  is installed by *copying* into `~/.claude/skills/`, so it duplicates the
  record write; the runtime dir is machine-level rather than `state/`-relative
  precisely so both can find it. A spawn that skips the record is a leak.

The spawn itself is serialised behind a lock, because `isUp()`-then-spawn is
not atomic and two sessions opened in the same second both see an empty port.

## Ports are hand-claimed, and killing is by PID

There is no allocator. Add the claim to [`ports.js`](ports.js) and read it back
with `portFor(name)` — never hardcode a number in a consumer. A dedicated
instance spawned `detached: true` stays resident until an explicit kill, and an
embedding server plus a 7B chat instance coexist with the shared 3B inside
16 GB of VRAM; a fourth needs a VRAM policy, not just a port.

**Never `taskkill` by image name.** There are routinely several
`llama-server.exe` processes and some belong to other sessions. Kill by PID or
by port.

## Machine-specific config is resolved

`LLAMA_SERVER_EXE` and `LLAMA_MODEL_PATH` used to be two hardcoded absolute
paths from one machine — a llama.cpp build directory and a bare sha256 Ollama
blob digest. Both are now resolved, in order: env var → `config.local.js`
(gitignored) → discovery. Discovery searches the usual llama.cpp build layouts
and `PATH` for the binary, and reads Ollama's manifest for `LLAMA_MODEL`
(default `llama3.2:latest`) to find the GGUF.

Use `resolveOllamaModel(ref)` rather than pasting a digest — a digest is
correct on exactly one machine and fails as a file-not-found at spawn
everywhere else.

Nothing here throws when resolution fails; it yields `null` and the *spawn*
reports it, naming the model reference and the `ollama pull` that would fix it.
That split matters: `ports.js` requires this config purely to read a port
number, and must not explode on a machine with no llama.cpp installed.

## Tests

```sh
node test.js     # 21 offline checks, no server, no network
```

Covers the code that decides whether to start or kill a process: netstat
parsing, the ownership record, `stopShared`'s three refusals, spawn-lock
staleness, and manifest resolution. The end-to-end proof that the chain really
starts and stops a server is `../token-monitor-core/test-lifecycle.js`, which
needs the GPU and the shared port and is held back from the default run.
