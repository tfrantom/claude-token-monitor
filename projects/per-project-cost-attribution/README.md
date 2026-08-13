# per-project-cost-attribution

`node attribute.js` answers "how much did building this actually cost", for
this suite or any other project on this machine, broken down by real repo or
working directory rather than Claude Code's coarse per-terminal `C--projects`
grouping. One project in the
[claude-token-monitor suite](../../README.md).

```
$ node attribute.js
per-project cost attribution -- 7 sessions, all history

project                  cost      %  turns  sess  out(think/write/tool)     cache r/w  last
--------------------  -------  -----  -----  ----  ---------------------  ------------  ----------------
some-big-repo            $110  78.9%    919     2    197.4k/33.7k/345.6k   209.0M/3.8M  2026-08-06 04:38
projects (root)        $15.27  11.0%    192     7      74.5k/12.2k/70.4k  22.7M/875.9k  2026-08-06 04:34
notes                   $7.51   5.4%     24     1        3.8k/2.2k/19.0k   12.8M/48.1k  2026-08-06 04:23
...
```

## Requirements

- Node 18+
- Claude Code transcripts under `~/.claude/projects/` (read only)
- Optionally the watcher's `state/status.json`, for session names and the
  `ended` flag

## Usage

```sh
node attribute.js                        # rollup by project, all history
node attribute.js --since 7d             # last 7 days of transcripts
node attribute.js --by path              # break down by cwd instead
node attribute.js --by project,agent_type
node attribute.js --session 223305b4     # one session (id prefix is enough)
node attribute.js --ended-only           # only sessions whose cost is final
node attribute.js --limit 20             # top N rows
node attribute.js --json                 # full nested report
node attribute.js --jsonl                # flat slice rows, history-ready
node attribute.js --no-subagents         # main transcripts only

node verify.js                           # reconcile + assert, against real data
```

Dimensions for `--by`: `project`, `path`/`cwd`, `subpath`, `session`,
`claude_project`, `root`, `agent`, `agent_type`, `resolver` — combine with
commas.

## Configuration

`config.js`:

| Setting | Default | |
|---|---|---|
| `PROJECTS_DIR` | `~/.claude/projects` | Transcript source, read only |
| `STATUS_FILE` | `../../packages/token-monitor-core/state/status.json` | Optional |
| `WORKSPACE_ROOTS` | `C:\projects`, `~/projects` | Directories whose immediate children are each a project |
| `PROJECT_OVERRIDES` | `{}` | `path prefix: 'name'`; longest matching prefix wins |
| `ASSUME_ENDED_WHEN_ABSENT` | `true` | Sessions absent from `status.json` count as ended |

## Contributing

[`CLAUDE.md`](CLAUDE.md).
