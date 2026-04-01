'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');

const AGENTS = ['main', 'forge', 'reviewer', 'sentinel'];
const SESSIONS_BASE = path.join(os.homedir(), '.openclaw', 'agents');
const MAX_EVENTS = 500;

// ── Tool target extractor ─────────────────────────────────────

function getToolTarget(name, args) {
  if (!args || typeof args !== 'object') return '';
  const n = (name || '').toLowerCase();
  if (['read', 'write', 'edit', 'multiedit'].includes(n)) {
    return args.file_path || args.path || '';
  }
  if (n === 'bash') return (args.command || '').slice(0, 50);
  if (n === 'grep') return args.pattern || '';
  if (n === 'glob') return args.pattern || '';
  if (n === 'todowrite' || n === 'todoread') return 'todos';
  // fallback: first string value
  const first = Object.values(args).find(v => typeof v === 'string');
  return first ? String(first).slice(0, 50) : '';
}

// ── Session Watcher ───────────────────────────────────────────

class SessionWatcher extends EventEmitter {
  constructor() {
    super();
    this._events = [];           // flat array of normalized events
    this._fileOffsets = new Map(); // filePath -> byteOffset
    this._watcher = null;
  }

  start() {
    const dirs = AGENTS.map(a => path.join(SESSIONS_BASE, a, 'sessions'));

    this._watcher = chokidar.watch(dirs, {
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      ignored: (p) => {
        const base = path.basename(p);
        // skip files that aren't plain .jsonl (e.g. .jsonl.deleted.xxx, .jsonl.reset.xxx)
        return base.includes('.jsonl.') || (base !== path.basename(p, path.extname(p)) + '.jsonl' && base.endsWith('.jsonl') === false);
      },
      depth: 0,
    });

    this._watcher.on('add', fp => this._ingest(fp));
    this._watcher.on('change', fp => this._ingest(fp));
  }

  _ingest(filePath) {
    const base = path.basename(filePath);
    // Only process plain {uuid}.jsonl files
    if (!base.match(/^[0-9a-f-]+\.jsonl$/i)) return;

    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }

    const offset = this._fileOffsets.get(filePath) || 0;
    if (stat.size <= offset) return;

    let buf;
    try {
      const fd = fs.openSync(filePath, 'r');
      buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
    } catch { return; }

    this._fileOffsets.set(filePath, stat.size);

    const parts = filePath.split(path.sep);
    const sessionId = base.replace('.jsonl', '');
    const agentId = parts[parts.length - 3]; // agents/{agentId}/sessions/{file}

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }

      const normalized = this._normalize(raw, sessionId, agentId);
      if (!normalized) continue;

      this._events.push(normalized);
      if (this._events.length > MAX_EVENTS) {
        this._events = this._events.slice(-MAX_EVENTS);
      }
      this.emit('event', normalized);
    }
  }

  _normalize(raw, sessionId, agentId) {
    const ts = raw.timestamp || new Date().toISOString();
    const base = { sessionId, agentId, ts };

    if (raw.type === 'session') {
      return { ...base, type: 'session_opened', cwd: raw.cwd || null };
    }

    if (raw.type === 'message') {
      const msg = raw.message;
      if (!msg || !Array.isArray(msg.content)) return null;

      // Pick the most meaningful block from this message
      // Prefer toolCall, then text (non-system)
      const toolCalls = msg.content.filter(b => b.type === 'toolCall');
      const toolResults = msg.content.filter(b => b.type === 'toolResult');
      const textBlocks = msg.content.filter(b => b.type === 'text' && b.text);

      // Emit one event per tool call
      if (toolCalls.length > 0) {
        // Return the first one; watcher will be called again for file change
        const tc = toolCalls[0];
        const target = getToolTarget(tc.name, tc.arguments);
        return {
          ...base,
          type: 'tool_call',
          tool: tc.name,
          target,
          callId: tc.id,
          status: 'ok', // we see it after it completes
          usage: raw.usage ? { total: raw.usage.totalTokens, cost: raw.usage.cost?.total } : null,
        };
      }

      if (toolResults.length > 0) {
        const tr = toolResults[0];
        return {
          ...base,
          type: 'tool_result',
          callId: tr.toolCallId || tr.id || null,
          status: tr.isError ? 'error' : 'ok',
          error: tr.isError ? (Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('') : String(tr.content)) : null,
        };
      }

      if (textBlocks.length > 0 && msg.role) {
        const text = textBlocks[0].text;
        // Skip internal session-start system messages
        if (msg.role === 'user' && text.startsWith('A new session was started')) return null;
        return {
          ...base,
          type: 'message',
          role: msg.role,
          text: text.slice(0, 500), // cap for memory
          usage: raw.usage ? { total: raw.usage.totalTokens, cost: raw.usage.cost?.total } : null,
        };
      }
    }

    return null;
  }

  getRecentEvents(limit = 200) {
    return this._events.slice(-limit);
  }

  getSessionEvents(sessionId, limit = 200) {
    return this._events.filter(e => e.sessionId === sessionId).slice(-limit);
  }

  stop() {
    if (this._watcher) this._watcher.close();
  }
}

module.exports = new SessionWatcher();
