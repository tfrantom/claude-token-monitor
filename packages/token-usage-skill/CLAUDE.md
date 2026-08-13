# token-usage-skill — working notes for Claude

A Claude Code skill that lets any session look up its own token usage. See
[`README.md`](README.md), [`SKILL.md`](SKILL.md), and the [suite
CLAUDE.md](../../CLAUDE.md).

## Editing files here does nothing until you reinstall

Claude Code reads `~/.claude/skills/token-usage/`, which is a **copy**. The
source in this directory is not what runs. After any edit:

```powershell
.\install.ps1
```

This is the single most common wasted debugging loop in the suite — changing
`SKILL.md` or `lookup.js`, seeing no effect, and concluding something deeper is
broken. It has cost a live re-path once already: the installed copy kept the
old path while the source here looked correct.

Newly installed skills also only appear in the available-skills listing at the
*next* session start.

## The installed copy must stay self-contained

`scripts/lookup.js` deliberately `require()`s nothing from the suite. Once
installed it lives outside the repo, so it has no relative path home and must
keep working if the suite moves or is mid-edit. Its only input is the one file
the watcher writes.

The paths it needs are resolved at install time into a sibling `config.json`,
not hardcoded. If the suite moves, re-run the installer.

**Do not add a `require('../../token-monitor-core/...')` here.** It will work
in the repo and break the moment it is installed.

Reading `status.json` **by path, with no code dependency on
`token-monitor-core`**, is the whole point — it is what keeps this package
extractable on its own. `token-monitor.nvim` consumes the file the same way.
Keep it that way.

## The numbers come from status.json, not from here

`lookup.js` renders whatever the watcher wrote, so what the skill reports
changes when `token-monitor-core` changes, with no edit here.

Worth knowing when a reported figure looks wrong: **a session's totals include
the spend of subagents it launched** (Task tool, separate sidechain
transcripts). That was missing before 2026-08-06 and is worth roughly 18%, so
a total reported now can legitimately exceed one quoted earlier in the same
session's history, or any number cached before then. It is a step change, not
a regression.

Sessions also carry an `agents` array of currently-running agents. `lookup.js`
does not render it; `--json` passes it through.

## Encoding

`install.ps1` writes two files that something else parses — `config.json` (Node)
and `~/.claude/CLAUDE.md` (Claude Code). Both must go out as UTF-8 **without**
a BOM via `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`.
`Set-Content -Encoding utf8` on PowerShell 5.1 adds one, and a BOM makes
`JSON.parse` throw outright. `lookup.js` also strips a leading BOM defensively;
that is belt-and-braces, not permission to write one.

The `CLAUDE.md` block is delimited by `<!-- token-usage-skill:start -->` /
`:end` markers and rewritten in place, so re-running the installer updates it
rather than appending a duplicate. Keep both markers intact.
