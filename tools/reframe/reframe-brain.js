#!/usr/bin/env node
/**
 * reframe-brain.js — distills a spoken utterance into a "patch" for the Reframe canvas.
 *
 * Exports:
 *   - async processInput(state, input, opts) -> patch  (CONTRACT §4)
 *   - buildPrompt(state, input)             -> string  (unit-testable, no CLI)
 *
 * The brain calls an AI CLI (claude -p, auto-detected) with a strict-JSON
 * system prompt and parses the single JSON object it returns. It NEVER throws:
 * on any failure it falls back to a safe patch that captures the raw input as
 * one node in an "Unsorted" cluster, so an idea is never lost.
 *
 * Env switches:
 *   REFRAME_FAKE_BRAIN=1   -> deterministic fake patch, no CLI call (for tests/smoke)
 *   REFRAME_CLI=<cmd>      -> force a specific AI CLI command
 *   BEE/AI timeout is fixed at 60s.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execSync } = require('child_process');

const CLI_TIMEOUT_MS = 60000;

// ─── CLI detection (adapted from proxy-worker.js) ─────────────────────────────
function detectCli() {
  if (process.env.REFRAME_CLI) return process.env.REFRAME_CLI;
  try { execSync('which claude', { stdio: 'ignore' }); return 'claude'; } catch (_) {}
  try { execSync('which kiro-cli', { stdio: 'ignore' }); return 'kiro-cli'; } catch (_) {}
  const kiroPath = (process.env.HOME || '') + '/.local/bin/kiro-cli';
  if (fs.existsSync(kiroPath)) return kiroPath;
  return 'claude';
}

function buildCliCommand(cli, promptFile) {
  const file = path.resolve(promptFile);
  if (cli.includes('claude')) {
    // sonnet for low latency
    return `cat ${file} | ${cli} -p --model sonnet`;
  }
  if (cli.includes('kiro')) {
    return `${cli} chat --no-interactive --effort high "$(cat ${file})"`;
  }
  return `cat ${file} | ${cli}`;
}

// ─── Output sanitising / JSON extraction ──────────────────────────────────────
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function extractJson(raw) {
  let s = stripAnsi(raw || '').trim();
  // Strip code fences if present.
  s = s.replace(/```(?:json)?/gi, '');
  // Find the first balanced {...} object.
  const start = s.indexOf('{');
  if (start === -1) throw new Error('no JSON object found');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(s.slice(start, i + 1));
      }
    }
  }
  throw new Error('unbalanced JSON object');
}

// ─── Compact view of state for the prompt ─────────────────────────────────────
function compactState(state) {
  const clusters = (state.clusters || []).map(c => c.label);
  const recent = (state.nodes || []).slice(-25).map(n => {
    const cl = (state.clusters || []).find(c => c.id === n.cluster);
    return { text: n.text, kind: n.kind, cluster: cl ? cl.label : null };
  });
  return {
    title: state.title || null,
    currentView: (state.view && state.view.type) || 'board',
    clusters,
    recentNodes: recent,
  };
}

function buildPrompt(state, input) {
  const compact = compactState(state);
  const isCommand = !!(input && input.isCommand);
  const speaker = (input && input.speaker) || null;

  return [
    'You are Reframe, a live "thinking canvas" engine for a brainstorm/planning session.',
    'You receive ONE new spoken utterance and the current board state, and you return',
    'a single JSON patch that captures the idea(s) and/or changes the view.',
    '',
    'Return ONLY one JSON object. No prose, no explanation, no markdown code fences.',
    '',
    'JSON schema (omit fields you do not need, but keep valid JSON):',
    '{',
    '  "intent": "content" | "view" | "mixed" | "noise",',
    '  "title": string | null,',
    '  "newNodes": [',
    '    { "tempId": "t1", "text": "concise distilled idea", "kind": "idea|action|question|decision|risk",',
    '      "clusterLabel": "Theme name", "parentTempId": null, "sourceText": "phrase that produced this" }',
    '  ],',
    '  "clusters": [ { "label": "Theme name", "color": "#5A969E" } ],',
    '  "view": { "type": "board|list|mindmap|table|timeline", "spec": {} },',
    '  "coveredSourceText": ["phrases from the input that became nodes"]',
    '}',
    '',
    'Rules:',
    '- Distinguish CONTENT (ideas to capture) from a VIEW/TRANSFORM COMMAND.',
    '  View commands look like: "show as a mindmap", "group these by priority",',
    '  "give me a list", "turn this into a table", "make a timeline".',
    '  For a pure view command set intent="view", set view.type accordingly, and',
    '  usually return NO newNodes.',
    '- For content, distill the utterance into a SMALL number of crisp nodes (often 1).',
    '  Cluster them into a SMALL number of meaningful themes. REUSE an existing cluster',
    '  label from the list below whenever it fits; only invent a new theme when needed.',
    '- "kind" is one of idea|action|question|decision|risk.',
    '- Pure filler / small talk / acknowledgements ("ok", "yeah totally", "hmm") -> intent="noise", no nodes.',
    '- Only set "title" when the session clearly has a topic and no good title exists yet.',
    '- "view" must be null (omitted) unless the view should actually change.',
    '',
    isCommand
      ? 'This utterance was sent as an EXPLICIT COMMAND — strongly prefer intent="view" if it asks to reshape the board.'
      : 'This utterance is regular speech — prefer capturing content unless it is clearly a view command.',
    '',
    'CURRENT BOARD (compact):',
    JSON.stringify(compact),
    '',
    'NEW UTTERANCE' + (speaker ? ' from ' + speaker : '') + ':',
    JSON.stringify((input && input.text) || ''),
    '',
    'Return the JSON patch now:',
  ].join('\n');
}

// ─── Fallback patch (never loses an idea) ─────────────────────────────────────
function fallbackPatch(input) {
  const text = ((input && input.text) || '').trim();
  return {
    intent: 'content',
    title: null,
    newNodes: [
      {
        tempId: 't1',
        text: text || '(empty)',
        kind: 'idea',
        clusterLabel: 'Unsorted',
        parentTempId: null,
        sourceText: text,
      },
    ],
    clusters: [{ label: 'Unsorted', color: '#8A8F98' }],
    view: null,
    coveredSourceText: text ? [text] : [],
  };
}

// ─── Deterministic fake brain (REFRAME_FAKE_BRAIN=1) ──────────────────────────────
function fakePatch(input) {
  const text = ((input && input.text) || '').trim();
  const lower = text.toLowerCase();
  const isView = /\b(mindmap|mind map|as a list|group (these|this|them) by|as a table|timeline|show (this|these|it) as)\b/.test(lower);
  if (isView) {
    let type = 'board';
    if (lower.includes('mindmap') || lower.includes('mind map')) type = 'mindmap';
    else if (lower.includes('list')) type = 'list';
    else if (lower.includes('table')) type = 'table';
    else if (lower.includes('timeline')) type = 'timeline';
    return { intent: 'view', title: null, newNodes: [], clusters: [], view: { type, spec: {} }, coveredSourceText: [] };
  }
  if (!text || lower.length < 3 || /^(ok|yeah|yep|hmm|right|sure)\.?$/.test(lower)) {
    return { intent: 'noise', title: null, newNodes: [], clusters: [], view: null, coveredSourceText: [] };
  }
  let kind = 'idea';
  if (text.includes('?')) kind = 'question';
  else if (/\b(we should|let's|decide|decision)\b/.test(lower)) kind = 'decision';
  else if (/\b(action|todo|task|build|ship|implement)\b/.test(lower)) kind = 'action';
  else if (/\b(risk|concern|worried|problem|blocker)\b/.test(lower)) kind = 'risk';
  return {
    intent: 'content',
    title: null,
    newNodes: [
      { tempId: 't1', text: text.slice(0, 120), kind, clusterLabel: 'Ideas', parentTempId: null, sourceText: text },
    ],
    clusters: [{ label: 'Ideas', color: '#5A969E' }],
    view: null,
    coveredSourceText: [text],
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────
async function processInput(state, input, opts) {
  opts = opts || {};

  if (process.env.REFRAME_FAKE_BRAIN === '1') {
    return fakePatch(input);
  }

  const cli = opts.cli || detectCli();
  const prompt = buildPrompt(state, input);

  let promptFile;
  try {
    promptFile = path.join(os.tmpdir(), 'reframe-prompt-' + process.pid + '-' + Date.now() + '.txt');
    fs.writeFileSync(promptFile, prompt);
  } catch (e) {
    return fallbackPatch(input);
  }

  const cmd = buildCliCommand(cli, promptFile);

  const patch = await new Promise((resolve) => {
    exec(cmd, { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 8, env: process.env, shell: '/bin/bash' }, (err, stdout, stderr) => {
      if (err) {
        process.stderr.write('[reframe-brain] CLI failed (' + cli + '): ' + (stderr || err.message).toString().slice(0, 300) + '\n');
        resolve(fallbackPatch(input));
        return;
      }
      try {
        const parsed = extractJson(stdout);
        resolve(normalizePatch(parsed, input));
      } catch (e) {
        process.stderr.write('[reframe-brain] parse failed: ' + e.message + '\n');
        resolve(fallbackPatch(input));
      }
    });
  });

  try { fs.unlinkSync(promptFile); } catch (_) {}
  return patch;
}

// Make sure the parsed patch has the expected shape (never throws).
function normalizePatch(p, input) {
  if (!p || typeof p !== 'object') return fallbackPatch(input);
  const out = {
    intent: ['content', 'view', 'mixed', 'noise'].includes(p.intent) ? p.intent : 'content',
    title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : null,
    newNodes: Array.isArray(p.newNodes) ? p.newNodes.filter(n => n && typeof n.text === 'string' && n.text.trim()) : [],
    clusters: Array.isArray(p.clusters) ? p.clusters.filter(c => c && typeof c.label === 'string') : [],
    view: p.view && typeof p.view === 'object' && typeof p.view.type === 'string' ? { type: p.view.type, spec: p.view.spec || {} } : null,
    coveredSourceText: Array.isArray(p.coveredSourceText) ? p.coveredSourceText.filter(t => typeof t === 'string') : [],
  };
  // If model claimed content but produced nothing, fall back so the idea survives.
  if (out.intent !== 'view' && out.intent !== 'noise' && out.newNodes.length === 0) {
    return fallbackPatch(input);
  }
  return out;
}

module.exports = { processInput, buildPrompt };
