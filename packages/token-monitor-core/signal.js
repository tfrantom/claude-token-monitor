#!/usr/bin/env node
'use strict';

// Publishes what this session is doing, for every status bar hooked into the
// watcher. See CLAUDE.md "Activity signals".
//
//   node signal.js working "running the test suite"
//   node signal.js done
//   node signal.js waiting_user "needs a decision on the port move"
//   node signal.js --agent bugfinder working "scanning packages/"
//   node signal.js --clear
//   node signal.js --show
//
// Reads CLAUDE_CODE_SESSION_ID, which Claude Code sets for every tool call and
// which is also the transcript filename and the status.json key. --session
// overrides it for hooks, which get the id on stdin instead.

const signals = require('./lib/signals');

function parseArgs(argv) {
  const opts = { agent: null, session: null, state: null, detail: null, clear: false, show: false, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--clear') opts.clear = true;
    else if (a === '--show') opts.show = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else rest.push(a);
  }
  opts.state = rest[0] || null;
  opts.detail = rest.slice(1).join(' ') || null;
  return opts;
}

const HELP = `signal.js -- tell the watcher what this session is doing

  node signal.js <state> [detail...]
  node signal.js --agent <name> <state> [detail...]
  node signal.js --clear [--agent <name>]
  node signal.js --show [--json]

states: ${signals.STATES.join(', ')}

  --session <id>   override CLAUDE_CODE_SESSION_ID (hooks pass it explicitly)
  --agent <name>   publish for one agent within the session, not the session
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  if (opts.show) {
    const all = signals.bySession();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
      return;
    }
    const ids = Object.keys(all);
    if (!ids.length) {
      process.stdout.write('no active signals\n');
      return;
    }
    for (const id of ids) {
      const e = all[id];
      process.stdout.write(`${id.slice(0, 8)}  ${e.state || '-'}${e.detail ? `  ${e.detail}` : ''}\n`);
      for (const a of e.agents) {
        process.stdout.write(`          ${a.agent}: ${a.state}${a.detail ? `  ${a.detail}` : ''}\n`);
      }
    }
    return;
  }

  const sessionId = opts.session || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    process.stderr.write(
      'no session id: CLAUDE_CODE_SESSION_ID is unset and --session was not given.\n' +
        'Claude Code sets it for every tool call, so this usually means the command\n' +
        'ran outside a session.\n'
    );
    process.exitCode = 1;
    return;
  }

  if (opts.clear) {
    signals.clear(sessionId, opts.agent);
    return;
  }

  if (!opts.state) {
    process.stderr.write(HELP);
    process.exitCode = 1;
    return;
  }

  try {
    signals.publish({
      sessionId,
      agent: opts.agent,
      state: opts.state,
      detail: opts.detail,
      pid: process.env.CLAUDE_PID || null,
      source: opts.session ? 'hook' : 'cli',
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

main();
