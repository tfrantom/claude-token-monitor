# llama-local-server

The reusable piece. Everything else in the [suite](../../README.md) is a
*client* of this — this package itself depends on nothing else here.

## What it actually is

`server.js` spawns (or, if already running, reuses) `llama-server.exe` from
a local `llama.cpp` build, pointed directly at a GGUF blob already on disk
under Ollama's blob store (`config.js` → `LLAMA_MODEL_PATH`) — no redundant
download, no Ollama API involved. Once up, it's a plain OpenAI-compatible
HTTP endpoint at `http://127.0.0.1:8090/v1/chat/completions` (and
`/v1/completions`, `/health`, etc — this is stock `llama-server.exe`, not a
custom shim). Embeddings are the one thing that needs a *separate* instance —
see "Multiple instances" below.

```js
const { ensureRunning, isUp, baseUrlFor, BASE_URL } = require('./server');
await ensureRunning(); // idempotent -- reuses an already-running instance
fetch(`${BASE_URL}/v1/chat/completions`, { ... }); // hand-rolled, no SDK anywhere in this suite
```

`ensureRunning()` returns `{ owned, proc, baseUrl }` — `owned` is `true` only
if *this* call started the server, so a caller knows whether it's responsible
for killing it on shutdown. `baseUrl` is the resolved
`http://<host>:<port>`, which matters once you're not on the default port.

## Multiple instances

`ensureRunning(opts)` takes `{host, port, modelPath, exePath, alias,
contextSize, gpuLayers, extraArgs, detached, timeoutMs}`. **Every option
defaults to the shared chat instance on 8090, so `ensureRunning()` with no
arguments behaves exactly as it always has.** `isUp(port, host)` and
`baseUrlFor(port, host)` are likewise port-aware; `BASE_URL` still exports the
default.

```js
// dedicated embedding server -- --embedding is an exclusive server *mode*
ensureRunning({ port: 8091, modelPath: EMBED_GGUF,
                extraArgs: ['--embedding', '-b', '2048', '-ub', '2048'],
                detached: true });

// bigger model for one specific job
ensureRunning({ port: 8092, modelPath: MISTRAL_GGUF,
                contextSize: 16384, detached: true });
```

This API exists because two consumers independently copied ~40 lines of this
file to stand up a second instance. Pass options instead of duplicating.

**`detached` matters more than it looks.** `false` (the default) means the
child dies with the parent — correct for the long-lived watcher. One-shot CLI
callers want `true`, or the server dies on every process exit and each
invocation re-pays the model load, making the reuse path dead code.

### Ports in use on this machine

Ports are claimed declaratively in [`ports.js`](ports.js), and consumers look
theirs up by name with `portFor()` rather than hardcoding a number. Two claims
on one port throw on require, which is the failure this replaced: three
consumers previously picked a port by eyeballing `netstat` output and hoping.

| Port | Owner | Model / mode |
|---|---|---|
| 8090 | this package (shared) | `llama3.2` 3B, chat completions |
| 8099 | **reserved** — a process outside this suite was found squatting here | — |

A dedicated instance is spawned `detached: true` and stays resident until an
explicit kill, so expect more than one `llama-server.exe` on a machine that
runs other tools built on this package — kill by PID or port, never by image
name.

### Spawn failures fail fast

A bad `exePath` surfaces as an `'error'` **event** on the `ChildProcess`, not a
thrown exception — and an unhandled `'error'` event is a hard crash with a
stack trace, in a package whose whole style is failing soft. It's now captured
and re-thrown as a clean `failed to start llama-server (<path>): <reason>` in
under a second, instead of either crashing or sitting through the full 30s
health-check timeout waiting for a process that never started. Two separate
agents hit this independently and each patched only their own copy, which is
what revealed the duplication problem the multi-instance API above solves.

## Why this is its own package

It started as `lib/llama-server.js` inside what's now `token-monitor-core`,
named for token-monitor's use of it (session naming, semantic
classification). But the actual capability — a low-latency, standing local
LLM endpoint anything on the machine can hit — has nothing to do with token
monitoring specifically. Splitting it out is what makes the `projects/`
extensions ([`local-inference-skill`](../../projects/local-inference-skill/),
[`ask-question-prefilter`](../../projects/ask-question-prefilter/)) able to
depend on "the local model server" without dragging in token-monitor's
watcher, transcript parsing, or any of its config.

The split held up under the strongest test available: two projects that were
once folders in this repo now live in their own repositories and vendor this
package verbatim, unchanged.

## Current model

The **default** instance serves `llama3.2` (the 3B Q4 quant Ollama already had
pulled), all layers offloaded to GPU (`-ngl 999`), 4096 context. There's still
no runtime model-switching *within* an instance — changing what 8090 serves
means setting `LLAMA_MODEL` (or `LLAMA_MODEL_PATH`) and restarting it. But a
consumer needing a different model no longer has to: pass `modelPath` (and a
claimed `port`) to `ensureRunning()` and get its own instance. A 7B chat model
at 16k context and a `--embedding` instance coexist with the shared 3B inside
16 GB of VRAM; a fourth resident instance needs a VRAM policy, not just a port.

## Config

`config.js` — `LLAMA_SERVER_EXE`, `LLAMA_MODEL_PATH`, `LLAMA_HOST`,
`LLAMA_PORT`. Each reads an env var of the same name first, falling back to a
machine-specific absolute-path default. The exe and blob paths are the one
category deliberately *not* made suite-relative during the path-portability
pass: they point at wherever your llama.cpp build and Ollama install happen to
live, which has nothing to do with where this suite sits.
