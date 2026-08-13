# token-usage-skill

A Claude Code skill, packaged for install into `~/.claude/skills/token-usage/`.
Part of the [claude-token-monitor suite](../../README.md), but the *installed
copy* is deliberately self-contained (see `scripts/lookup.js`'s own comment)
— it survives this suite moving, breaking, or this repo not existing at all,
as long as `packages/token-monitor-core`'s `state/status.json` is still
where it expects it (hardcoded path, currently
`C:/projects/claude-token-monitor/packages/token-monitor-core/state/status.json`
— update both this source copy *and* re-run `install.ps1` if that ever
changes).

## Files

- `SKILL.md` — the actual skill definition (frontmatter + instructions for
  Claude). Copied verbatim to `~/.claude/skills/token-usage/SKILL.md`.
- `scripts/lookup.js` — self-contained Node script, no requires from the rest
  of this suite. Copied to `~/.claude/skills/token-usage/scripts/lookup.js`.
- `install.ps1` — copies both of the above into place, and idempotently
  inserts/updates a marked block in `~/.claude/CLAUDE.md`
  (`<!-- token-usage-skill:start/end -->`) so future sessions know the skill
  exists without having to rediscover it. Safe to re-run any time either
  source file changes — it replaces the installed copies and the CLAUDE.md
  block in place rather than duplicating.

## Install / reinstall

```powershell
.\install.ps1
```

**Watch out:** if you edit `scripts/lookup.js` or `SKILL.md` here, those
edits do nothing on their own — the installed copy under `~/.claude/skills/`
is what Claude Code actually reads, and it goes stale until you re-run
`install.ps1`. This bit a live re-path once already. **`SKILL.md` was edited on
2026-08-06** (to note that session totals now include subagent spend) and the
installed copy has not necessarily been refreshed since — re-run
`install.ps1` if in doubt.

## What the numbers now include

The lookup reads `status.json` as an opaque blob, so it inherits whatever the
watcher writes. Two changes there are visible through this skill without any
change to `lookup.js`:

- **Session totals include subagent (Task) spend** as of 2026-08-06 —
  previously missing, worth roughly 18%.
- Sessions carry an `agents` array (running agents only). `lookup.js` doesn't
  render it; `--json` exposes it if you want it.
