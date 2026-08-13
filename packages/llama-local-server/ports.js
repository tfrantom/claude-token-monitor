'use strict';

// The port registry for every local llama-server instance this suite runs.
//
// Why this exists: three separate projects picked their port by running
// `netstat`, eyeballing the output, and hoping. One of them nearly grabbed
// 8099, which already had another session's process on it. A hand-picked
// port that turns out to be taken fails *at spawn time* -- llama-server.exe
// can't bind, exits immediately, and the caller then sits through a 30s
// health poll before reporting "did not become healthy", which says nothing
// about the actual problem. This module moves that failure forward to a
// declaration and a pre-flight check, with a message that names the culprit.
//
// Three things it does:
//   1. CLAIMS below is the single declarative place a port is claimed. Two
//      claims on one port is a require-time throw, not a runtime surprise.
//   2. portFor('name') -- consumers look their port up by name instead of
//      hardcoding a number, so moving a port is a one-line edit here.
//   3. inspect()/assertAvailable() probe the port for real (TCP first, then
//      llama-server's /props) and report *who* is on it, including the case
//      that matters most: a llama-server that's up but serving the wrong
//      model, which ensureRunning() would otherwise happily reuse.
//
// Dependency-free and plain CommonJS, like the rest of the suite. Nothing in
// here requires ./server -- server.js requires *this*, not the other way
// round.

const net = require('net');
const cfg = require('./config');

const HOST = cfg.LLAMA_HOST;

// ---------------------------------------------------------------------------
// The claims. Adding an instance to the suite means adding an entry HERE
// first, then reading the port back out with portFor(name). Do not hardcode
// the number in a consumer's config.
//
//   port       the claimed TCP port on HOST
//   owner      repo-relative path of the code that spawns it
//   alias      the -a value the owner should pass, so the instance identifies
//              itself in /props and /v1/models. Defaults to the claim name in
//              ensureRunningFor().
//   mode       'chat' | 'embedding' -- --embedding is an exclusive server
//              mode, which is the whole reason there is more than one port.
//   model      human label only. The authoritative model path stays in the
//              owner's own config; duplicating a blob digest here would just
//              rot. Identity checks compare against the path the *caller* is
//              about to spawn with (see assertAvailable).
//   shared     true = other code is expected to reuse this instance as-is
//              and must never reconfigure it.
//
// There is one claim today. The table is not therefore pointless: the checks
// below are about what is *live on the machine*, not about how many rows are
// in here. Other tools -- including companion repos that were once folders in
// this one -- routinely hold neighbouring ports, which is why suggestPort()
// probes TCP before suggesting anything and assertAvailable() names an
// occupant instead of letting a spawn fail to bind.
// ---------------------------------------------------------------------------
const CLAIMS = {
  'chat-shared': {
    port: 8090,
    owner: 'packages/llama-local-server',
    alias: 'llama3.2-3b',
    mode: 'chat',
    model: 'llama3.2 3B Q4 (config.js LLAMA_MODEL_PATH)',
    shared: true,
    notes:
      'The suite default. ensureRunning() with no arguments targets this. ' +
      'LLAMA_PORT env var overrides it -- if you set that, this claim is a lie, ' +
      'which is why validate() cross-checks the two.',
  },

};

// Ports we know are in use but that nobody in this suite owns. Never claimed,
// never suggested. Kept here rather than in a comment so suggestPort() can
// actually honour them.
const RESERVED = {
  8099:
    'Occupied by a process outside this suite. Observed serving nomic-embed-text ' +
    '(identical model to 8091) -- most likely an orphaned embedding server from ' +
    'another session. Do not claim; do not kill without finding its owner.',
};

// ---------------------------------------------------------------------------
// Static validation -- runs on require, on purpose.
//
// "Two consumers claim the same port" is the failure this whole module is for,
// and the only honest time to report it is the moment the second claim is
// loaded. A throw here is loud, immediate, and points at the one file to edit.
// ---------------------------------------------------------------------------
function validate(claims = CLAIMS, reserved = RESERVED) {
  const seen = new Map();
  for (const [name, c] of Object.entries(claims)) {
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
      throw new Error(`port registry: claim '${name}' has an invalid port (${c.port})`);
    }
    const prior = seen.get(c.port);
    if (prior) {
      throw new Error(
        `port registry collision: '${prior}' (${claims[prior].owner}) and '${name}' ` +
          `(${c.owner}) both claim port ${c.port}. Pick a free one -- ` +
          `\`node packages/llama-local-server/ports.js --suggest\` -- and fix ports.js.`
      );
    }
    if (reserved[c.port]) {
      throw new Error(
        `port registry: claim '${name}' takes reserved port ${c.port}. ${reserved[c.port]}`
      );
    }
    seen.set(c.port, name);
  }

  // config.js's LLAMA_PORT is what ensureRunning() actually defaults to. If an
  // env var has moved it, the 'chat-shared' claim is stale and every lookup
  // built on it is wrong -- say so rather than let the two drift silently.
  if (claims['chat-shared'] && claims['chat-shared'].port !== cfg.LLAMA_PORT) {
    throw new Error(
      `port registry: claim 'chat-shared' says ${claims['chat-shared'].port} but ` +
        `config.js LLAMA_PORT resolves to ${cfg.LLAMA_PORT} (LLAMA_PORT env var?). ` +
        `Reconcile them -- consumers trust the registry.`
    );
  }
  return true;
}

validate();

// Declarative means declarative: a consumer that wants a different port edits
// this file, it does not reach in and mutate the table at runtime.
Object.values(CLAIMS).forEach(Object.freeze);
Object.freeze(CLAIMS);
Object.freeze(RESERVED);

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
function names() {
  return Object.keys(CLAIMS);
}

function get(name) {
  const claim = CLAIMS[name];
  if (!claim) {
    throw new Error(
      `unknown port claim '${name}'. Known claims: ${names().join(', ')}. ` +
        `Add yours to packages/llama-local-server/ports.js rather than hardcoding a port.`
    );
  }
  return { name, host: HOST, ...claim };
}

function portFor(name) {
  return get(name).port;
}

function baseUrlFor(name) {
  const c = get(name);
  return `http://${c.host}:${c.port}`;
}

function list() {
  return names().map(get);
}

function whoClaims(port) {
  const name = names().find((n) => CLAIMS[n].port === port);
  return name ? get(name) : null;
}

// ---------------------------------------------------------------------------
// Live probing
// ---------------------------------------------------------------------------

// A raw TCP connect, not an HTTP request: something can be bound to a port
// without answering /health (a non-llama service, or a llama-server still
// loading a model). That is exactly the case where "is it free?" via HTTP lies
// and you spawn into a bind failure.
function isListening(port, { host = HOST, timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Ask a listener to identify itself. llama-server's /props carries the three
// things worth knowing: which model file it actually opened, its -a alias, and
// its context size. Returns null for anything that isn't a llama-server.
async function identify(port, { host = HOST, timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`http://${host}:${port}/props`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const props = await res.json();
    if (!props || typeof props.model_path !== 'string') return null;
    return {
      alias: props.model_alias ?? null,
      modelPath: props.model_path,
      contextSize: props.default_generation_settings?.n_ctx ?? null,
      slots: props.total_slots ?? null,
    };
  } catch {
    return null;
  }
}

// llama-server reports whatever path string it was handed: 8090 came up with
// forward slashes, config.js hands out backslashes from path.join. Compare the
// files, not the spelling.
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

// status:
//   'free'      nothing is listening -- spawning is safe
//   'ours'      a llama-server is up and serving the model we expected
//   'llama'     a llama-server is up, but no expectation was given to check it
//               against (reuse is probably fine -- verify the alias/model)
//   'mismatch'  a llama-server is up serving a DIFFERENT model. The dangerous
//               one: ensureRunning() would reuse it and you'd silently get
//               answers from the wrong model.
//   'foreign'   something is listening that is not a llama-server. Spawning
//               here will fail to bind.
async function inspect(name, { expectModelPath = null, host = HOST } = {}) {
  const claim = typeof name === 'string' ? get(name) : name;
  const port = claim.port;

  if (!(await isListening(port, { host }))) {
    return { ...claim, status: 'free', occupant: null };
  }

  const occupant = await identify(port, { host });
  if (!occupant) return { ...claim, status: 'foreign', occupant: null };
  if (!expectModelPath) return { ...claim, status: 'llama', occupant };
  return {
    ...claim,
    status: samePath(occupant.modelPath, expectModelPath) ? 'ours' : 'mismatch',
    occupant,
  };
}

async function scan(opts = {}) {
  const claimed = await Promise.all(list().map((c) => inspect(c, opts)));
  const reserved = await Promise.all(
    Object.keys(RESERVED).map(async (p) => {
      const port = Number(p);
      const listening = await isListening(port);
      return {
        name: `(reserved ${port})`,
        port,
        owner: 'outside this suite',
        reserved: RESERVED[p],
        // 'reserved' either way: not listening today does not make it claimable,
        // it just means the squatter is between runs.
        status: 'reserved',
        listening,
        occupant: listening ? await identify(port) : null,
      };
    })
  );
  return [...claimed, ...reserved];
}

// The pre-flight a spawner should run. Throws with a message that names the
// occupant instead of letting llama-server fail to bind and time out.
// Returns { port, host, reuse } -- reuse true means a healthy instance of the
// right model is already there and you should not spawn.
async function assertAvailable(name, { expectModelPath = null, host = HOST } = {}) {
  const state = await inspect(name, { expectModelPath, host });
  const where = `port ${state.port} (claimed by '${state.name}', ${state.owner})`;

  if (state.status === 'foreign') {
    throw new Error(
      `${where} is held by something that is not a llama-server. ` +
        `llama-server.exe cannot bind it and will exit immediately. ` +
        `Find the holder with \`netstat -ano | findstr :${state.port}\`, then either free it ` +
        `or move this claim in packages/llama-local-server/ports.js ` +
        `(\`node packages/llama-local-server/ports.js --suggest\` finds a free port).`
    );
  }

  if (state.status === 'mismatch') {
    throw new Error(
      `${where} already has a llama-server on it, but it is serving ` +
        `${state.occupant.modelPath} (alias '${state.occupant.alias}'), not the expected ` +
        `${expectModelPath}. Reusing it would silently answer from the wrong model. ` +
        `Kill that instance, or give this consumer its own claim in ports.js.`
    );
  }

  return { port: state.port, host, reuse: state.status !== 'free', state };
}

// What the three projects were doing by hand with netstat. Skips claimed
// ports, reserved ports, and anything actually listening.
async function suggestPort({ from = 8090, to = 8130, host = HOST } = {}) {
  for (let port = from; port <= to; port++) {
    if (whoClaims(port) || RESERVED[port]) continue;
    if (await isListening(port, { host })) continue;
    return port;
  }
  return null;
}

module.exports = {
  CLAIMS,
  RESERVED,
  HOST,
  names,
  get,
  portFor,
  baseUrlFor,
  list,
  whoClaims,
  isListening,
  identify,
  inspect,
  scan,
  assertAvailable,
  suggestPort,
  validate,
};

// ---------------------------------------------------------------------------
// CLI:  node ports.js               -- the table, with live status
//       node ports.js <claim-name>  -- just the number (shell-friendly)
//       node ports.js --suggest     -- first port free by registry and by TCP
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];

    if (arg && arg !== '--suggest' && !arg.startsWith('-')) {
      process.stdout.write(`${portFor(arg)}\n`);
      return;
    }

    if (arg === '--suggest') {
      const port = await suggestPort();
      process.stdout.write(port ? `${port}\n` : 'no free port in range\n');
      if (!port) process.exitCode = 1;
      return;
    }

    const rows = await scan();
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad('PORT', 6)}${pad('STATUS', 10)}${pad('CLAIM', 30)}OWNER`);
    for (const r of rows) {
      console.log(`${pad(r.port, 6)}${pad(r.status, 10)}${pad(r.name, 30)}${r.owner}`);
      if (r.occupant) {
        console.log(
          `      -> alias '${r.occupant.alias}', ctx ${r.occupant.contextSize}, ${r.occupant.modelPath}`
        );
      }
      if (r.reserved) {
        console.log(`      -> ${r.listening ? 'listening. ' : 'nothing listening right now. '}${r.reserved}`);
      }
    }
    const free = await suggestPort();
    console.log(`\nnext free port: ${free ?? 'none in range'}`);
    console.log(
      'status: free = nothing listening | llama = a llama-server is up (model unverified ' +
        'without an expected path) | foreign = a listener that is not a llama-server | ' +
        'reserved = in use outside this suite, never claim'
    );
  })().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
