'use strict';

const os = require('os');
const path = require('path');

const STATE_DIR = process.env.COMMENT_AUDITOR_STATE_DIR || path.join(__dirname, 'state');

module.exports = {
  STATE_DIR,
  CACHE_FILE: path.join(STATE_DIR, 'verdict-cache.json'),

  STATUS_FILE:
    process.env.COMMENT_AUDITOR_STATUS_FILE ||
    path.join(__dirname, '..', '..', 'packages', 'token-monitor-core', 'state', 'status.json'),

  // Whole files by default; past this the model is shown a window around each
  // comment instead. Sized for llama3.2's 4096-token window.
  MAX_FILE_CHARS: Number(process.env.COMMENT_AUDITOR_MAX_FILE_CHARS || 6000),
  CONTEXT_LINES: 6,

  MAX_COMMENTS_PER_REQUEST: 8,
  MAX_COMMENT_CHARS: 600,
  REQUEST_TIMEOUT_MS: Number(process.env.COMMENT_AUDITOR_TIMEOUT_MS || 20_000),

  // A whole-file audit must never hold up the turn that triggered it.
  TOTAL_BUDGET_MS: Number(process.env.COMMENT_AUDITOR_BUDGET_MS || 12_000),

  MIN_CONFIDENCE: Number(process.env.COMMENT_AUDITOR_MIN_CONFIDENCE || 0.75),

  // Off by default, and the surfaces still have to ask -- see CLAUDE.md
  // "The autonomous path".
  AUTOAPPLY: process.env.COMMENT_AUDITOR_AUTOAPPLY === '1',
  QUIESCENT_MS: Number(process.env.COMMENT_AUDITOR_QUIESCENT_MS || 45_000),

  HOME: os.homedir(),
};
