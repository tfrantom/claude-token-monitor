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
//   node signal.js --from-hook working      (reads session_id from stdin JSON)
//
// Reads CLAUDE_CODE_SESSION_ID, which Claude Code sets for every tool call and
// which is also the transcript filename and the status.json key. --session
// overrides it, and --from-hook takes it off the hook payload on stdin --
// parsing it here rather than in the hook command keeps jq and shell quoting
// out of a cross-platform config file.

const fs = require('fs');
const signals = require('./lib/signals');

// Claude Code fires Notification for two unrelated things: a prompt that is
// actually blocking (permission, question) and an idle nudge some seconds
// after a turn ends. Only the first is `waiting_user`; treating the nudge as
// one flips a finished session from `done` to "needs you" while it sits there.
//
// Matched narrowly, and unmatched messages still publish: a false "needs you"
// is noise, but a missed one means a blocked session looks idle.
const IDLE_NOTIFICATION = /waiting for your input|idle|no longer waiting/i;

function readHookPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const opts = { agent: null, session: null, state: null, detail: null, clear: false, show: false, json: false, fromHook: false, notification: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--clear') opts.clear = true;
    else if (a === '--from-hook') opts.fromHook = true;
    else if (a === '--notification') opts.notification = true;
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

  const hook = opts.fromHook ? readHookPayload() : {};
  const sessionId = opts.session || hook.session_id || process.env.CLAUDE_CODE_SESSION_ID;
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

  // The idle nudge is not a blocking prompt; leave whatever state stands.
  const message = typeof hook.message === 'string' ? hook.message : null;
  if (opts.notification && message && IDLE_NOTIFICATION.test(message)) return;

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
      detail: opts.detail || message,
      pid: process.env.CLAUDE_PID || null,
      source: opts.fromHook || opts.session ? 'hook' : 'cli',
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

main();
