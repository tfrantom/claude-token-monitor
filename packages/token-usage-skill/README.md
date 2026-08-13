# token-usage-skill

A Claude Code skill, packaged for install into `~/.claude/skills/token-usage/`.
Part of the [claude-token-monitor suite](../../README.md), but the *installed
copy* is self-contained: it requires nothing from the suite and keeps working
if the suite moves, breaks, or is absent, as long as
`packages/token-monitor-core`'s `state/status.json` is where `config.json`
says it is.

## Files

- `SKILL.md` — the skill definition (frontmatter + instructions for Claude).
  Copied verbatim to `~/.claude/skills/token-usage/SKILL.md`.
- `scripts/lookup.js` — self-contained Node script. Copied to
  `~/.claude/skills/token-usage/scripts/lookup.js`.
- `install.ps1` — copies both into place, writes
  `~/.claude/skills/token-usage/config.json` with the resolved suite paths,
  and inserts or updates a marked block in `~/.claude/CLAUDE.md`
  (`<!-- token-usage-skill:start/end -->`) so future sessions know the skill
  exists. Idempotent: it replaces the installed copies and the CLAUDE.md block
  in place rather than duplicating.

## Install / reinstall

```powershell
.\install.ps1
```

**Editing `SKILL.md` or `scripts/lookup.js` here changes nothing until you
re-run this.** Claude Code reads the copy under `~/.claude/skills/`. See
[`CLAUDE.md`](CLAUDE.md).

## What the numbers include

`lookup.js` treats `status.json` as an opaque blob, so it inherits whatever the
watcher writes:

- **Session totals include subagent (Task) spend** — worth roughly 18%.
- Sessions carry an `agents` array of currently-running agents. `lookup.js`
  does not render it; `--json` exposes it.
