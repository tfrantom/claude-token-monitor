'use strict';

// The port registry. Add a claim here, read it back with portFor(name) -- see
// CLAUDE.md "Ports are hand-claimed, and killing is by PID".

const net = require('net');
const cfg = require('./config');

const HOST = cfg.LLAMA_HOST;

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

// Never claimed, never suggested.
const RESERVED = {
  8099:
    'Occupied by a process outside this suite. Observed serving nomic-embed-text ' +
    '(identical model to 8091) -- most likely an orphaned embedding server from ' +
    'another session. Do not claim; do not kill without finding its owner.',
};

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

Object.values(CLAIMS).forEach(Object.freeze);
Object.freeze(CLAIMS);
Object.freeze(RESERVED);

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

// A raw TCP connect, not /health: something can hold a port without answering
// HTTP, and that is exactly when an HTTP "is it free?" lies.
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

// llama-server echoes back whatever path string it was handed. Compare the
// files, not the spelling.
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

// status -> 'free' | 'ours' | 'llama' | 'mismatch' | 'foreign'
// See CLAUDE.md "Ports are hand-claimed" for what each one means for a spawner.
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
        status: 'reserved',
        listening,
        occupant: listening ? await identify(port) : null,
      };
    })
  );
  return [...claimed, ...reserved];
}

// -> { port, host, reuse }; reuse true means a healthy instance of the right
// model is already there and you must not spawn.
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
