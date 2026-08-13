# Proposed addendum to `bug-me-claude`'s `SKILL.md`

**Status: NOT APPLIED. Requires someone with authority over `C:\projects\bug-me-claude\`.**

This project deliberately does not edit anything under `C:\projects\bug-me-claude\` — it's
a separate project outside this suite. But design option 2 (a wrapper script rather than a
patched `ask-question.ps1`, see [`../README.md`](../README.md)) only takes effect if Claude
is actually told to call the wrapper. That instruction lives in `bug-me-claude`'s
`skill\SKILL.md` (and its installed copy at `~\.claude\commands\bug-me-claude.md`).

The prefilter is fully functional without this — it just won't be reached unless a session
is told about it. Applying this addendum is what turns it on globally.

Nothing below removes or weakens the existing proactive posture; the prefilter's suppression
bar is set high on purpose and fails open.

---

## Suggested replacement for the "Ask a question" section

Replace this block in `SKILL.md`:

~~~markdown
### Ask a question

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$env:USERPROFILE\.claude\bin\ask-question.ps1" \
  -Question "Brief spoken question -- one sentence, plays on speakers" \
  -Detail "Longer context shown in the popup window"
```
~~~

with:

~~~markdown
### Ask a question

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "C:\projects\claude-token-monitor\projects\ask-question-prefilter\scripts\ask-question-prefilter.ps1" \
  -Question "Brief spoken question -- one sentence, plays on speakers" \
  -Detail "Longer context shown in the popup window" \
  -Context "Anything already decided that might make this question redundant"
```

This is a thin wrapper around `ask-question.ps1`. A local 3B model (~0.2s, no API cost)
checks whether the question is already answered by `-Detail`/`-Context` and shortens an
overly long `-Question` before TTS speaks it. In the overwhelming majority of cases it
forwards straight to the real popup and you get the user's answer on stdout exactly as
before.

Two outcomes to handle:

- **Normal case** — the popup fires; the user's typed answer is stdout, same as always.
- **Suppressed** — stdout is a single line starting with `SUPPRESSED:`, and no popup
  appeared. The question was judged already answered by what you supplied. Read the reason,
  act on the information you already had, and continue. **Do not** re-ask by calling
  `ask-question.ps1` directly to route around the filter. If you genuinely believe the
  suppression was wrong, re-run the wrapper with `-NoSuppress`.

Escape hatches (pass when you know better than the filter):

- `-NoSuppress` — never skip; only shorten the spoken question. Use for anything
  destructive, irreversible, or where a wrong guess is expensive.
- `-NoTighten` — speak your `-Question` verbatim; suppression still applies.

Prefer `-NoSuppress` over calling `ask-question.ps1` directly, so the tightening still
happens.

Calling `ask-question.ps1` directly still works and is still correct if the local model
server isn't running — but you don't need to check: the wrapper detects that in ~2s and
forwards anyway.
~~~

## Also worth adding, under "Important notes"

~~~markdown
- Avoid embedded double quotes in `-Question` / `-Detail`. `powershell.exe -File` re-parses
  its arguments and silently truncates the value at the first `"` — the failure is silent
  and you get a half-message spoken aloud. Use single quotes or no quotes.
~~~

This one is worth applying **regardless** of whether the prefilter is adopted — it's a
pre-existing hazard in the current contract, confirmed in practice, not something the
prefilter introduces.

## Optional: permissions

`~\.claude\settings.json` on this machine currently has `permissions.defaultMode: "auto"`
and no explicit allow list, so no permission change is needed for the wrapper to be
callable. If an explicit allow list is ever reintroduced, note that `bug-me-claude`'s
installer rule `Bash(powershell.exe*ask-question*)` already matches
`ask-question-prefilter.ps1` by substring — no new rule required.
