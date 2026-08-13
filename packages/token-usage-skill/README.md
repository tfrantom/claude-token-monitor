# token-usage-skill

A Claude Code skill that reports real-time token usage, cost, and a
reading/writing/thinking/tool-call breakdown for any active session on this
machine. One package in the
[claude-token-monitor suite](../../README.md); the installed copy reads
`packages/token-monitor-core`'s `state/status.json` by path and needs nothing
else from the suite.

## Requirements

- Windows PowerShell 5.1, for the installer
- Node 18+
- The suite's watcher running: `node packages/token-monitor-core/watcher.js`

## Install

```powershell
.\install.ps1
```

Copies `SKILL.md` and `scripts/lookup.js` into
`~/.claude/skills/token-usage/`, writes a `config.json` there with the resolved
suite paths, and inserts or updates the `<!-- token-usage-skill:start/end -->`
block in `~/.claude/CLAUDE.md`. Idempotent.

**Editing `SKILL.md` or `scripts/lookup.js` here changes nothing until you
re-run this** — Claude Code runs the installed copy, and a newly installed
skill only appears in the skill listing at the next session start.

## Usage

Claude invokes the skill itself. By hand:

```powershell
node "$env:USERPROFILE\.claude\skills\token-usage\scripts\lookup.js"
```

| Flag | Effect |
|---|---|
| `--session <id>` | Force a session instead of auto-detecting from `CLAUDE_CODE_SESSION_ID` |
| `--project <path>` | Match by project directory instead of session id |
| `--json` | Raw `status.json` instead of the formatted summary |

## Configuration

Written by the installer to `~/.claude/skills/token-usage/config.json`.

| Key | |
|---|---|
| `suiteRoot` | Where the suite was installed from |
| `statusFile` | The `status.json` `lookup.js` reads |
| `watcherCmd` | Printed when there is no data to read |

## Contributing

[`CLAUDE.md`](CLAUDE.md).
