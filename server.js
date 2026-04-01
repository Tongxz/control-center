const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn, execSync } = require('child_process');
const indexer = require('./indexer');
const poll = require('./poll');

const app = express();
const PORT = 18799;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────

app.get('/api/overview/snapshot', (req, res) => {
  const snap = poll.getSnapshot();
  if (!snap) return res.status(503).json({ error: 'snapshot not ready yet' });
  res.json(snap);
});

app.get('/api/agents', (req, res) => {
  const snap = poll.getSnapshot();
  if (!snap) return res.status(503).json({ error: 'snapshot not ready yet' });
  res.json(snap.agents);
});

app.get('/api/tasks', (req, res) => res.json([]));

app.get('/api/projects', (req, res) => res.json([]));

app.get('/api/exceptions', (req, res) => res.json([]));

app.get('/api/approve', (req, res) => res.json([]));

// ── Docs (workspace indexer) ─────────────────────────────────

app.get('/api/docs', (req, res) => {
  res.json(indexer.listDocs());
});

app.get('/api/docs/:id', (req, res) => {
  const doc = indexer.getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});

app.put('/api/docs/:id', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  try {
    res.json(indexer.putDoc(req.params.id, content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Memory (workspace indexer) ────────────────────────────────

app.get('/api/memory', (req, res) => {
  res.json(indexer.listMemory());
});

app.get('/api/memory/:agentId', (req, res) => {
  res.json(indexer.getMemory(req.params.agentId));
});

app.get('/api/settings/health', (req, res) => {
  const snap = poll.getSnapshot();
  let channelStatus = [];
  try {
    const out = execSync('openclaw channels status --probe 2>&1', { shell: true, timeout: 10_000 });
    channelStatus = parseChannelProbe(out.toString());
  } catch {
    // fallback to snapshot channel data
    channelStatus = (snap?.gateway?.channelStatus || []).map((c) => ({
      channel: c.channel,
      status: c.status,
    }));
  }
  res.json({
    gateway: snap?.gateway || { status: 'unknown', version: 'unknown' },
    channel: channelStatus,
    openclawVersion: snap?.gateway?.version || 'unknown',
  });
});

function parseChannelProbe(text) {
  const result = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^-\s+(.+?):\s+(.+)/);
    if (m) result.push({ channel: m[1].trim(), status: m[2].trim() });
  }
  return result;
}

app.get('/api/cron/history', async (req, res) => {
  const snap = poll.getSnapshot();
  if (!snap) return res.status(503).json({ error: 'snapshot not ready yet' });
  const jobs = snap.cron?.jobs || [];
  const historyJobs = await Promise.all(
    jobs.map(async (job) => {
      try {
        const out = await runCronRuns(job.id, 3);
        const entries = out?.entries || [];
        return {
          id: job.id,
          name: job.name,
          runs: entries.map((e) => ({
            ts: e.runAtMs ? new Date(e.runAtMs).toISOString() : null,
            status: e.status,
            summary: e.summary || '',
          })),
        };
      } catch {
        return { id: job.id, name: job.name, runs: [] };
      }
    })
  );

  res.json({ jobs: historyJobs });
});

function runCronRuns(jobId, limit) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', ['cron', 'runs', '--id', jobId, '--limit', String(limit)], { shell: true });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.on('close', () => {
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ entries: [] }); }
    });
    proc.on('error', () => resolve({ entries: [] }));
  });
}

app.get('/api/action-queue', (req, res) => res.json([]));

// ── Start ─────────────────────────────────────────────────────

poll.start();

app.listen(PORT, () => {
  console.log(`OpenClaw Control Center listening on http://localhost:${PORT}`);
});
