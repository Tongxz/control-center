const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { nanoid } = require('nanoid');
const indexer = require('./indexer');
const poll = require('./poll');

const RUNTIME_DIR = path.join(__dirname, 'runtime');

// ── JSON file helpers ─────────────────────────────────────────

function readJson(relPath) {
  const filePath = path.join(RUNTIME_DIR, relPath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(relPath, data) {
  const filePath = path.join(RUNTIME_DIR, relPath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── JSONL append helper ───────────────────────────────────────
function appendJsonl(relPath, entry) {
  const filePath = path.join(RUNTIME_DIR, relPath);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

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

app.get('/api/tasks', (req, res) => res.json(readJson('tasks.json') || []));

app.get('/api/projects', (req, res) => {
  res.json(readJson('projects.json') || []);
});

// GET /api/projects/:projectId
app.get('/api/projects/:projectId', (req, res) => {
  const projects = readJson('projects.json') || [];
  const project = projects.find(p => p.projectId === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'not found' });
  res.json(project);
});

// POST /api/projects
app.post('/api/projects', (req, res) => {
  const { name, summary, owner } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const projects = readJson('projects.json') || [];
  const newProject = {
    projectId: `proj-${nanoid(10)}`,
    name,
    summary: summary || '',
    status: 'planning',
    owner: owner || 'main',
    taskIds: [],
    createdAt: new Date().toISOString(),
  };
  projects.push(newProject);
  writeJson('projects.json', projects);
  res.status(201).json(newProject);
});

// PATCH /api/projects/:projectId
app.patch('/api/projects/:projectId', (req, res) => {
  const projects = readJson('projects.json') || [];
  const idx = projects.findIndex(p => p.projectId === req.params.projectId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const allowed = ['name', 'summary', 'status', 'owner'];
  const updates = req.body;
  const updated = { ...projects[idx] };
  for (const key of allowed) {
    if (updates[key] !== undefined) updated[key] = updates[key];
  }
  updated.updatedAt = new Date().toISOString();
  projects[idx] = updated;
  writeJson('projects.json', projects);
  res.json(updated);
});

// GET /api/projects/:projectId/summary
app.get('/api/projects/:projectId/summary', (req, res) => {
  const projects = readJson('projects.json') || [];
  const project = projects.find(p => p.projectId === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'not found' });

  const tasks = readJson('tasks.json') || [];
  const projectTasks = tasks.filter(t => t.projectId === req.params.projectId);

  res.json({
    projectId: project.projectId,
    name: project.name,
    status: project.status,
    taskCount: projectTasks.length,
    doneCount: projectTasks.filter(t => t.status === 'done').length,
    inProgressCount: projectTasks.filter(t => t.status === 'in-progress').length,
    blockedCount: projectTasks.filter(t => t.status === 'blocked').length,
  });
});

app.get('/api/exceptions', (req, res) => res.json([]));

app.get('/api/approve', (req, res) => res.json([]));

// ── Approvals ─────────────────────────────────────────────────

// GET /api/approvals
app.get('/api/approvals', (req, res) => {
  const approvals = readJson('approvals.json') || [];
  const { status } = req.query;
  if (status) {
    return res.json(approvals.filter(a => a.status === status));
  }
  res.json(approvals);
});

// GET /api/approvals/:approvalId
app.get('/api/approvals/:approvalId', (req, res) => {
  const approvals = readJson('approvals.json') || [];
  const approval = approvals.find(a => a.approvalId === req.params.approvalId);
  if (!approval) return res.status(404).json({ error: 'not found' });
  res.json(approval);
});

// POST /api/approvals/:approvalId/approve
app.post('/api/approvals/:approvalId/approve', (req, res) => {
  const approvals = readJson('approvals.json') || [];
  const idx = approvals.findIndex(a => a.approvalId === req.params.approvalId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const comment = req.body.comment || '';
  approvals[idx] = {
    ...approvals[idx],
    status: 'approved',
    actedAt: new Date().toISOString(),
  };
  writeJson('approvals.json', approvals);

  const logEntry = {
    approvalId: approvals[idx].approvalId,
    action: 'approve',
    comment,
    actedAt: approvals[idx].actedAt,
  };
  appendJsonl('approval-actions.log', logEntry);

  res.json(approvals[idx]);
});

// POST /api/approvals/:approvalId/reject
app.post('/api/approvals/:approvalId/reject', (req, res) => {
  const approvals = readJson('approvals.json') || [];
  const idx = approvals.findIndex(a => a.approvalId === req.params.approvalId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const comment = req.body.comment || '';
  approvals[idx] = {
    ...approvals[idx],
    status: 'rejected',
    actedAt: new Date().toISOString(),
  };
  writeJson('approvals.json', approvals);

  const logEntry = {
    approvalId: approvals[idx].approvalId,
    action: 'reject',
    comment,
    actedAt: approvals[idx].actedAt,
  };
  appendJsonl('approval-actions.log', logEntry);

  res.json(approvals[idx]);
});

// GET /api/approval-actions
app.get('/api/approval-actions', (req, res) => {
  const filePath = path.join(RUNTIME_DIR, 'approval-actions.log');
  let entries = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    entries = content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);
  } catch {
    entries = [];
  }
  const { approvalId } = req.query;
  if (approvalId) {
    entries = entries.filter(e => e.approvalId === approvalId);
  }
  res.json(entries);
});

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
