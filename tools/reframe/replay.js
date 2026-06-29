#!/usr/bin/env node
/**
 * replay.js — rehearse a Reframe session without speaking.
 *
 * Reads sample-session.json and POSTs each utterance to the running reframe-server,
 * with a delay between utterances. View commands (e.g. "show as a mindmap",
 * "group by priority") are routed to /api/reframe/command; everything else to /inject.
 *
 * Usage:
 *   node replay.js [--port 9998] [--delay 2500] [--file sample-session.json]
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
let port = 9998;
let delay = 2500;
let file = path.join(__dirname, 'sample-session.json');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port' && argv[i + 1]) port = parseInt(argv[++i], 10);
  else if (argv[i] === '--delay' && argv[i + 1]) delay = parseInt(argv[++i], 10);
  else if (argv[i] === '--file' && argv[i + 1]) file = path.resolve(argv[++i]);
}

const utterances = JSON.parse(fs.readFileSync(file, 'utf-8'));

const VIEW_RE = /\b(mindmap|mind map|as a list|give me a list|group (these|this|them) by|by priority|as a table|timeline|show (this|these|it) as)\b/i;

function post(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost', port, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('[replay] Replaying ' + utterances.length + ' utterances to localhost:' + port + ' (delay ' + delay + 'ms)');
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    const isCommand = VIEW_RE.test(u.text);
    const endpoint = isCommand ? '/api/reframe/command' : '/api/reframe/inject';
    const label = isCommand ? 'COMMAND' : 'inject ';
    console.log('[replay] ' + (i + 1) + '/' + utterances.length + ' [' + label + '] ' + (u.speaker || '?') + ': ' + u.text);
    try {
      await post(endpoint, isCommand ? { text: u.text } : { speaker: u.speaker, text: u.text });
    } catch (e) {
      console.error('[replay] POST failed: ' + e.message + ' (is reframe-server running on port ' + port + '?)');
      process.exit(1);
    }
    if (i < utterances.length - 1) await sleep(delay);
  }
  console.log('[replay] Done. Open http://localhost:' + port + ' to see the board.');
})();
