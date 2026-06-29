#!/usr/bin/env node
/**
 * reframe-server.js — Reframe live thinking-canvas backend (dependency-free, Node built-ins only).
 *
 * Holds an append-only board state (CONTRACT §1), persists it to disk, serves the
 * canvas SPA + a full REST/SSE API (CONTRACT §3), and ingests utterances from Bee
 * (CONTRACT §6) — or from /api/reframe/inject + /api/reframe/command for replay/dev.
 *
 * Inputs are processed SEQUENTIALLY through a simple async queue so concurrent
 * utterances cannot corrupt the append-only state.
 *
 * Args:
 *   --port  PORT   listen port               (default 9998)
 *   --state PATH   board.json path           (default tools/reframe/.tmp/board.json)
 *   --cli   CMD    AI CLI (auto-detect claude then kiro-cli)
 *
 * On listen: prints the URL to stderr and writes 'READY\n' to stdout.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const brain = require('./reframe-brain.js');

// ─── Argument parsing ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let PORT = 9998;
let STATE_PATH = path.join(__dirname, '.tmp', 'board.json');
let CLI_CMD = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port' && argv[i + 1]) PORT = parseInt(argv[++i], 10);
  else if (argv[i] === '--state' && argv[i + 1]) STATE_PATH = path.resolve(argv[++i]);
  else if (argv[i] === '--cli' && argv[i + 1]) CLI_CMD = argv[++i];
}
STATE_PATH = path.resolve(STATE_PATH);

const BOARD_HTML = path.join(__dirname, 'board.html');
const BEE_CLI = process.env.BEE_CLI_PATH || 'bee';
const EXEC_ENV = Object.assign({}, process.env, {
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
});

// ─── CLI detection (adapted from proxy-worker.js) ─────────────────────────────
function detectCli() {
  if (CLI_CMD) return CLI_CMD;
  try { execSync('which claude', { stdio: 'ignore' }); return 'claude'; } catch (_) {}
  try { execSync('which kiro-cli', { stdio: 'ignore' }); return 'kiro-cli'; } catch (_) {}
  const kiroPath = (process.env.HOME || '') + '/.local/bin/kiro-cli';
  if (fs.existsSync(kiroPath)) return kiroPath;
  process.stderr.write('[reframe] WARNING: No AI CLI detected. Install claude or kiro-cli.\n');
  return 'claude';
}
const CLI = detectCli();

// ─── Cluster colour palette ───────────────────────────────────────────────────
const PALETTE = [
  '#5A969E', '#C58B5A', '#7E9E5A', '#9E5A8B', '#5A6E9E',
  '#9E9152', '#5A9E83', '#9E5A5A', '#7A5A9E', '#5A9E5A',
];

// ─── State ────────────────────────────────────────────────────────────────────
let state = freshState();
let thinking = false;
let beeStatus = 'disconnected';
let beeStreamProcess = null;
let sseClients = [];
let nodeSeq = 0;
let clusterSeq = 0;
let sourceSeq = 0;

function freshState() {
  return {
    sessionId: 's-' + Date.now(),
    title: '',
    sources: [],
    nodes: [],
    clusters: [],
    view: { type: 'board', spec: {} },
    coverage: { total: 0, covered: 0, lost: [] },
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
      state = Object.assign(freshState(), loaded);
      // Re-seed sequence counters from existing ids.
      nodeSeq = maxSeq(state.nodes, 'n');
      clusterSeq = maxSeq(state.clusters, 'c');
      sourceSeq = maxSeq(state.sources, 's');
      process.stderr.write('[reframe] Loaded state from ' + STATE_PATH + ' (' + state.nodes.length + ' nodes)\n');
    }
  } catch (e) {
    process.stderr.write('[reframe] Could not load state: ' + e.message + ' (starting fresh)\n');
    state = freshState();
  }
}

function maxSeq(arr, prefix) {
  let m = 0;
  (arr || []).forEach(o => {
    const match = String(o.id || '').match(new RegExp('^' + prefix + '(\\d+)$'));
    if (match) m = Math.max(m, parseInt(match[1], 10));
  });
  return m;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write('[reframe] Persist failed: ' + e.message + '\n');
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function sseSend(res, data) {
  try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (_) {}
}

function broadcastState() {
  const payload = { type: 'state', state };
  sseClients.forEach(c => sseSend(c, payload));
}

function broadcastStatus() {
  const payload = { type: 'status', bee: beeStatus, thinking };
  sseClients.forEach(c => sseSend(c, payload));
}

function setThinking(v) {
  if (thinking === v) return;
  thinking = v;
  broadcastStatus();
}

function setBeeStatus(v) {
  if (beeStatus === v) return;
  beeStatus = v;
  broadcastStatus();
}

// ─── Patch application (CONTRACT §4) ──────────────────────────────────────────
function findClusterByLabel(label) {
  if (!label) return null;
  const lc = label.trim().toLowerCase();
  return (state.clusters || []).find(c => (c.label || '').trim().toLowerCase() === lc) || null;
}

function ensureCluster(label, color) {
  let cl = findClusterByLabel(label);
  if (cl) return cl;
  clusterSeq++;
  cl = {
    id: 'c' + clusterSeq,
    label: label || 'Unsorted',
    color: color || PALETTE[(clusterSeq - 1) % PALETTE.length],
  };
  state.clusters.push(cl);
  return cl;
}

/**
 * Apply a brain patch for a given source. Returns true if any node was added.
 */
function applyPatch(patch, source) {
  let addedNode = false;

  if (patch.title && (!state.title || patch.title.length > 3)) {
    state.title = patch.title;
  }

  // Pre-create clusters declared in patch.clusters so colours are honoured.
  (patch.clusters || []).forEach(c => ensureCluster(c.label, c.color));

  // View intent: change the view, generally no nodes.
  if (patch.view && (patch.intent === 'view' || patch.intent === 'mixed')) {
    state.view = { type: patch.view.type, spec: patch.view.spec || {} };
  }

  // Map tempId -> created node id (within this patch) for parent resolution.
  const tempToId = {};
  const created = [];

  (patch.newNodes || []).forEach(nn => {
    nodeSeq++;
    const id = 'n' + nodeSeq;
    const cluster = ensureCluster(nn.clusterLabel || 'Unsorted');
    const node = {
      id,
      text: String(nn.text || '').trim(),
      kind: ['idea', 'action', 'question', 'decision', 'risk'].includes(nn.kind) ? nn.kind : 'idea',
      cluster: cluster.id,
      parent: null,
      sourceIds: source ? [source.id] : [],
      ts: Date.now(),
      _parentTempId: nn.parentTempId || null,
    };
    if (nn.tempId) tempToId[nn.tempId] = id;
    state.nodes.push(node);
    created.push(node);
    if (source && !source.nodeIds.includes(id)) source.nodeIds.push(id);
    addedNode = true;
  });

  // Resolve parents (tempId within patch first, then existing node id).
  created.forEach(node => {
    const pt = node._parentTempId;
    delete node._parentTempId;
    if (!pt) return;
    if (tempToId[pt]) node.parent = tempToId[pt];
    else if (state.nodes.find(n => n.id === pt)) node.parent = pt;
  });

  // Mark whether the source was idea-bearing. Pure view commands and noise do
  // not count toward coverage (a "show as mindmap" is not a lost idea).
  source._ideaBearing = patch.intent === 'content' || patch.intent === 'mixed';

  recomputeCoverage();
  return addedNode;
}

function recomputeCoverage() {
  const ideaBearing = (state.sources || []).filter(s => s._ideaBearing);
  const total = ideaBearing.length;
  const covered = ideaBearing.filter(s => (s.nodeIds || []).length > 0).length;
  const lost = ideaBearing.filter(s => (s.nodeIds || []).length === 0).map(s => s.id);
  state.coverage = { total, covered, lost };
}

// ─── Sequential input queue ───────────────────────────────────────────────────
let queue = Promise.resolve();

function enqueueInput(input) {
  queue = queue.then(() => handleInput(input)).catch(err => {
    process.stderr.write('[reframe] input handler error: ' + err.message + '\n');
  });
  return queue;
}

async function handleInput(input) {
  // Append to the append-only ledger first (the "never lose" guarantee).
  sourceSeq++;
  const source = {
    id: 's' + sourceSeq,
    speaker: input.speaker || null,
    text: input.text,
    ts: Date.now(),
    nodeIds: [],
    _ideaBearing: true,
  };
  state.sources.push(source);
  persist();
  broadcastState();

  setThinking(true);
  let patch;
  try {
    patch = await brain.processInput(state, {
      text: input.text,
      speaker: input.speaker || null,
      isCommand: !!input.isCommand,
    }, { cli: CLI });
  } catch (e) {
    process.stderr.write('[reframe] brain threw: ' + e.message + '\n');
    patch = { intent: 'content', newNodes: [{ tempId: 't1', text: input.text, kind: 'idea', clusterLabel: 'Unsorted' }], clusters: [], view: null };
  }
  applyPatch(patch, source);
  setThinking(false);
  persist();
  broadcastState();
}

// ─── Bee integration (CONTRACT §6, adapted from proxy-worker.js) ──────────────
const seenUtterances = new Set();

// Real-time utterance debounce: spoken phrases arrive as small fragments via the
// `new-utterance` stream event. We buffer them and flush a grouped thought after a
// short pause (or when the speaker changes), so one spoken sentence becomes one node
// instead of a dozen fragments. Each fragment's key is marked "seen" immediately, so
// the later `update-conversation` transcript reconciliation never re-creates it.
const UTTER_DEBOUNCE_MS = 1500;
let uttBuffer = [];
let uttSpeaker = null;
let uttTimer = null;
let loggedSampleUtterance = false;

function flushUtterances() {
  if (uttTimer) { clearTimeout(uttTimer); uttTimer = null; }
  if (uttBuffer.length === 0) return;
  const text = uttBuffer.join(' ').replace(/\s+/g, ' ').trim();
  const speaker = uttSpeaker;
  uttBuffer = [];
  uttSpeaker = null;
  if (text) enqueueInput({ speaker: speaker || null, text, isCommand: false });
}

// Pull a {speaker, text} out of a `new-utterance` event across the shapes Bee might use.
function extractUtterance(event) {
  const u = (event && (event.utterance || event.data)) || event;
  if (!u) return null;
  let text = (typeof u === 'string') ? u : (u.text || u.transcript || u.content || u.body);
  if (!text) return null;
  const speaker = (typeof u === 'object' && (u.speaker || u.speaker_name || u.user || u.user_name)) || null;
  return { speaker: speaker || null, text: String(text).trim() };
}

function ingestLiveUtterance(event) {
  if (!loggedSampleUtterance) {
    loggedSampleUtterance = true;
    process.stderr.write('[reframe][bee] sample utterance event: ' + JSON.stringify(event).slice(0, 400) + '\n');
  }
  const u = extractUtterance(event);
  if (!u || !u.text) return;
  const key = (u.speaker || '') + '|' + u.text;
  if (seenUtterances.has(key)) return;     // already ingested (live or via transcript)
  seenUtterances.add(key);
  // Speaker change → flush the in-progress thought first.
  if (uttBuffer.length && u.speaker && uttSpeaker && u.speaker !== uttSpeaker) flushUtterances();
  uttBuffer.push(u.text);
  uttSpeaker = u.speaker || uttSpeaker;
  if (uttTimer) clearTimeout(uttTimer);
  uttTimer = setTimeout(flushUtterances, UTTER_DEBOUNCE_MS);
}

function startBeeStream() {
  if (beeStreamProcess) {
    try { beeStreamProcess.kill(); } catch (_) {}
  }
  let child;
  try {
    child = spawn(BEE_CLI, ['stream', '--types', 'new-utterance,update-conversation', '--json'], {
      env: EXEC_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    setBeeStatus('disconnected');
    process.stderr.write('[reframe] Bee unavailable: ' + e.message + ', retrying in 10s...\n');
    setTimeout(startBeeStream, 10000);
    return;
  }

  beeStreamProcess = child;
  setBeeStatus('connecting');
  process.stderr.write('[reframe] Starting bee stream...\n');

  let buffer = '';
  child.stdout.on('data', (data) => {
    setBeeStatus('connected');
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleBeeEvent(JSON.parse(trimmed));
      } catch (_) { /* non-JSON banner line */ }
    }
  });

  child.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) process.stderr.write('[reframe][bee-stderr] ' + msg + '\n');
  });

  child.on('close', (code) => {
    setBeeStatus('disconnected');
    process.stderr.write('[reframe] Bee stream closed (code ' + code + '), reconnecting in 5s...\n');
    beeStreamProcess = null;
    setTimeout(startBeeStream, 5000);
  });

  child.on('error', (err) => {
    setBeeStatus('disconnected');
    process.stderr.write('[reframe] Bee stream error: ' + err.message + ', retrying in 10s...\n');
    beeStreamProcess = null;
    setTimeout(startBeeStream, 10000);
  });
}

function handleBeeEvent(event) {
  setBeeStatus('connected');

  // Real-time path: a single spoken phrase. Inject it live (debounced) for the
  // "post-its appear while you talk" effect.
  const type = (event && (event.type || event.event || event.kind) || '').toString().toLowerCase();
  const looksLikeUtterance = type.indexOf('utterance') !== -1 ||
    (event && (event.utterance || (event.text && !event.conversation)));
  if (looksLikeUtterance) { ingestLiveUtterance(event); return; }

  // Fallback / reconciliation path: a completed conversation. Its per-utterance
  // texts were already marked "seen" by the live path, so this only fills gaps.
  const conv = event && event.conversation;
  if (!conv) return;
  const convState = (conv.state || '').toLowerCase();
  const id = conv.id || conv.uuid;
  if (!id) return;
  if (convState !== 'processed' && convState !== 'completed') return;
  fetchTranscript(id, (utterances) => {
    (utterances || []).forEach(u => {
      const text = (u && u.text) ? String(u.text).trim() : '';
      if (!text) return;
      const key = (u.speaker || '') + '|' + text;
      if (seenUtterances.has(key)) return;
      seenUtterances.add(key);
      enqueueInput({ speaker: u.speaker || null, text, isCommand: false });
    });
  });
}

function fetchTranscript(conversationId, cb) {
  const child = spawn(BEE_CLI, ['conversations', 'transcript', String(conversationId), '--json'], {
    env: EXEC_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => out += d.toString());
  child.on('error', () => cb(null));
  child.on('close', () => {
    try {
      const data = JSON.parse(out.trim());
      const t = data.transcript || data.utterances || data;
      cb(Array.isArray(t) ? t : (t && t.utterances) || []);
    } catch (_) { cb(null); }
  });
}

// ─── Markdown export ──────────────────────────────────────────────────────────
const KIND_TAG = { idea: 'idea', action: 'action', question: 'question', decision: 'decision', risk: 'risk' };

function exportMarkdown() {
  const lines = [];
  lines.push('# ' + (state.title || 'Reframe Session'));
  lines.push('');
  const clusters = state.clusters || [];
  const nodesByCluster = {};
  (state.nodes || []).forEach(n => {
    (nodesByCluster[n.cluster] = nodesByCluster[n.cluster] || []).push(n);
  });

  clusters.forEach(c => {
    const ns = nodesByCluster[c.id] || [];
    if (ns.length === 0) return;
    lines.push('## ' + c.label);
    lines.push('');
    ns.forEach(n => {
      lines.push('- ' + n.text + ' `' + (KIND_TAG[n.kind] || 'idea') + '`');
    });
    lines.push('');
  });

  // Unsorted: nodes whose cluster id no longer exists.
  const known = new Set(clusters.map(c => c.id));
  const orphans = (state.nodes || []).filter(n => !known.has(n.cluster));
  if (orphans.length) {
    lines.push('## Unsorted');
    lines.push('');
    orphans.forEach(n => lines.push('- ' + n.text + ' `' + (KIND_TAG[n.kind] || 'idea') + '`'));
    lines.push('');
  }

  const cov = state.coverage || { total: 0, covered: 0, lost: [] };
  lines.push('---');
  lines.push('');
  lines.push('_' + cov.covered + '/' + cov.total + ' ideas captured · ' + (cov.lost || []).length + ' lost_');
  lines.push('');
  return lines.join('\n');
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
const CORS = { 'Access-Control-Allow-Origin': '*' };

function sendJson(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { cb(body ? JSON.parse(body) : {}); }
    catch (e) { cb(null, e); }
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }, CORS));
      res.end();
      return;
    }
  }

  // GET / -> board.html
  if (url === '/' || url === '/index.html') {
    if (fs.existsSync(BOARD_HTML)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(BOARD_HTML));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body style="font-family:sans-serif;background:#0F1111;color:#E8E8E8;padding:40px">'
        + '<h1>Reframe</h1><p>board.html not found yet. The API is live at <code>/api/reframe/state</code>.</p></body></html>');
    }
    return;
  }

  // SSE stream
  if (url === '/api/reframe/stream') {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }, CORS));
    sseSend(res, { type: 'hello', state });
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // Full state
  if (url === '/api/reframe/state' && req.method === 'GET') {
    sendJson(res, 200, state);
    return;
  }

  // Status
  if (url === '/api/reframe/status' && req.method === 'GET') {
    sendJson(res, 200, {
      bee: beeStatus,
      thinking,
      sources: state.sources.length,
      nodes: state.nodes.length,
      clusters: state.clusters.length,
    });
    return;
  }

  // Inject an utterance
  if (url === '/api/reframe/inject' && req.method === 'POST') {
    readBody(req, (body, err) => {
      if (err || !body || typeof body.text !== 'string' || !body.text.trim()) {
        sendJson(res, 400, { error: 'text required' });
        return;
      }
      enqueueInput({ speaker: body.speaker || null, text: body.text.trim(), isCommand: false });
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Explicit view/transform command
  if (url === '/api/reframe/command' && req.method === 'POST') {
    readBody(req, (body, err) => {
      if (err || !body || typeof body.text !== 'string' || !body.text.trim()) {
        sendJson(res, 400, { error: 'text required' });
        return;
      }
      enqueueInput({ speaker: body.speaker || null, text: body.text.trim(), isCommand: true });
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Reset
  if (url === '/api/reframe/reset' && req.method === 'POST') {
    state = freshState();
    nodeSeq = clusterSeq = sourceSeq = 0;
    seenUtterances.clear();
    persist();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return;
  }

  // Export markdown
  if (url === '/api/reframe/export' && req.method === 'GET') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/markdown; charset=utf-8' }, CORS));
    res.end(exportMarkdown());
    return;
  }

  res.writeHead(404, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(JSON.stringify({ error: 'not found' }));
});

// Keepalive comments for SSE.
setInterval(() => {
  sseClients.forEach(c => { try { c.write(': keepalive\n\n'); } catch (_) {} });
}, 15000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadState();

server.listen(PORT, () => {
  process.stderr.write('[reframe] Listening on http://localhost:' + PORT + '\n');
  process.stderr.write('[reframe] State file: ' + STATE_PATH + '\n');
  process.stderr.write('[reframe] AI CLI: ' + CLI + '\n');
  process.stdout.write('READY\n');
  startBeeStream();
});

process.on('exit', () => { if (beeStreamProcess) { try { beeStreamProcess.kill(); } catch (_) {} } });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
