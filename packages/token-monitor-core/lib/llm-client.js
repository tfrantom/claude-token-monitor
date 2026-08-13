'use strict';

const { BASE_URL } = require('../../llama-local-server/server');

const SYSTEM_PROMPT =
  'You name coding/chat sessions in 5 words or fewer, title case. ' +
  'Reply with only the name — no punctuation, no quotes, no explanation.';

// Thin hand-rolled client for llama.cpp's OpenAI-compatible endpoint —
// intentionally not the Ollama API or any SDK, just a fetch call.
async function nameSession(firstUserText) {
  if (!firstUserText) return null;
  const prompt = firstUserText.slice(0, 800);
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 20,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const name = data.choices?.[0]?.message?.content?.trim();
    return name || null;
  } catch {
    return null;
  }
}

const NAME_CHANGE_SYSTEM_PROMPT =
  'You track what a coding/chat session is about. You are given the session\'s ' +
  'current name and the user\'s newest message(s) since that name was set. If the ' +
  'user is still working on the same task -- a follow-up, correction, clarification, ' +
  'or continuation -- reply with the current name repeated back exactly, unchanged, ' +
  'character for character. Only if the user has genuinely moved on to a different ' +
  'task or topic, reply with a new name (5 words or fewer, title case, no ' +
  'punctuation) describing what they are doing now.';

const NAME_CHANGE_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
};

// SUPERSEDED -- no longer used by watcher.js, kept as a documented dead end.
// Anchoring the model to its current name and asking "same or different?"
// fails badly on small models: measured 0/8 renames on a blatant topic switch
// (llama3.2, temp 0.1), because echoing back the name it was just handed is
// the lowest-effort token path. Asked to name the same text cold, with no
// current name in the prompt, `nameSession` was 8/8 correct. watcher.js now
// names unanchored and decides "did the topic change?" in code (`sameTopic`).
// Left here because the failure is non-obvious and worth not rediscovering.
//
// Deliberately one field, not a separate changed:boolean -- an earlier
// version asked for both and the model would produce a perfectly good new
// name while still (inconsistently) reporting changed:false. Whether the
// name actually changed is derived by the caller comparing strings, which
// turned out far more reliable than trusting the model's own self-report of
// its own decision. The judgment call itself ("is this the same task or a
// real switch") still lives entirely in the model, on purpose -- cheaper
// local heuristics (word/char count) can only gate *whether* to ask.
async function checkNameChange(currentName, newUserText) {
  if (!currentName || !newUserText) return null;
  const prompt = `Current name: "${currentName}"\n\nNewest user message(s):\n${newUserText}`;
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: NAME_CHANGE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 40,
        temperature: 0.1,
        response_format: { type: 'json_schema', json_schema: { name: 'name_change', schema: NAME_CHANGE_SCHEMA, strict: true } },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
    const name = parsed.name.trim();
    return { name, changed: name.toLowerCase() !== currentName.trim().toLowerCase() };
  } catch {
    return null;
  }
}

module.exports = { nameSession, checkNameChange };
