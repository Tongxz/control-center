const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { nanoid } = require('nanoid');
const indexer = require('./indexer');
const poll = require('./poll');
const sessionWatcher = require('./session-watcher');

const RUNTIME_DIR = path.join(__dirname, 'runtime');
const TASKS_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 1000;

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


function extractJsonPayload(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  for (const marker of ['{', '[']) {
    const idx = trimmed.indexOf(marker);
    if (idx !== -1) {
      try {
        return JSON.parse(trimmed.slice(idx));
      } catch {
        // keep trying
      }
    }
  }
  return null;
}

function runOpenClawJson(args, { allowMissingCommand = false } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', args, { shell: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => resolve({ ok: false, error: err.message, code: -1, stdout, stderr }));
    proc.on('close', (code) => {
      const payload = extractJsonPayload(stdout || stderr);
      const combined = `${stdout}
${stderr}`;
      if (code === 0 && payload !== null) {
        return resolve({ ok: true, data: payload, stdout, stderr, code });
      }
      if (allowMissingCommand && /unknown command 'flows'|unknown command 'flow'|Did you mean logs\?/i.test(combined)) {
        return resolve({ ok: false, missingCommand: true, error: combined.trim(), stdout, stderr, code });
      }
      resolve({ ok: false, error: combined.trim() || `openclaw ${args.join(' ')} failed`, data: payload, stdout, stderr, code });
    });
  });
}

function getSnapshotFileMeta(relPath) {
  const filePath = path.join(RUNTIME_DIR, relPath);
  try {
    return { filePath, stat: fs.statSync(filePath) };
  } catch {
    return null;
  }
}

function normalizeTasksPayload(payload) {
  if (Array.isArray(payload)) return { tasks: payload, count: payload.length };
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const count = typeof payload?.count === 'number' ? payload.count : tasks.length;
  return { tasks, count };
}

async function getLiveTasksPayload() {
  const result = await runOpenClawJson(['tasks', 'list', '--json']);
  if (!result.ok) throw new Error(result.error || 'failed to load tasks from openclaw');
  return normalizeTasksPayload(result.data);
}

async function getPreferredTasksPayload() {
  const meta = getSnapshotFileMeta('tasks-snapshot.json');
  if (meta) {
    const ageMs = Date.now() - meta.stat.mtimeMs;
    const cached = normalizeTasksPayload(readJson('tasks-snapshot.json'));
    if (ageMs <= TASKS_SNAPSHOT_MAX_AGE_MS && cached.tasks.length) {
      return { ...cached, source: 'snapshot', stale: false };
    }
    if (ageMs <= TASKS_SNAPSHOT_MAX_AGE_MS) {
      return { ...cached, source: 'snapshot', stale: false };
    }
  }

  const live = await getLiveTasksPayload();
  return { ...live, source: 'live', stale: false };
}

// ── JSONL append helper ───────────────────────────────────────
function appendJsonl(relPath, entry) {
  const filePath = path.join(RUNTIME_DIR, relPath);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

// ── Timeline helper ──────────────────────────────────────────
// agent: 'main' | 'forge' | 'reviewer' | 'sentinel' | 'system'
function recordTimeline({ agent = 'system', type, targetId, summary, before = {}, after = {} }) {
  const entry = {
    ts: new Date().toISOString(),
    agent,
    type,
    targetId,
    summary,
    before,
    after,
  };
  appendJsonl('timeline.log', entry);
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

// GET /api/agents/:agentId/sessions
app.get('/api/agents/:agentId/sessions', (req, res) => {
  const snap = poll.getSnapshot();
  if (!snap) return res.status(503).json({ error: 'snapshot not ready yet' });
  const all = snap.sessions?._raw || [];
  const filtered = all.filter(s => s.agentId === req.params.agentId);
  res.json(filtered);
});

app.get('/api/tasks', async (req, res) => {
  try {
    const payload = await getPreferredTasksPayload();
    res.json({ tasks: payload.tasks, count: payload.count });
  } catch (err) {
    res.status(500).json({ error: err.message, tasks: [], count: 0 });
  }
});

app.get('/api/tasks/:taskId', async (req, res) => {
  const result = await runOpenClawJson(['tasks', 'show', req.params.taskId, '--json']);
  if (!result.ok) {
    return res.status(result.code === 0 ? 500 : 404).json({ error: result.error || 'task not found' });
  }
  res.json(result.data);
});

app.get('/api/flows', async (req, res) => {
  const result = await runOpenClawJson(['flows', 'list', '--json'], { allowMissingCommand: true });
  if (result.missingCommand) {
    return res.json({ flows: [], note: 'flows not available' });
  }
  if (!result.ok) {
    return res.status(500).json({ error: result.error || 'failed to load flows', flows: [] });
  }
  const flows = Array.isArray(result.data) ? result.data : (Array.isArray(result.data?.flows) ? result.data.flows : []);
  res.json({ flows, count: flows.length });
});

// POST /api/tasks
app.post('/api/tasks', (req, res) => {
  const { title, ownerAgentId, projectId, status, priority, riskLevel } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const tasks = readJson('tasks.json') || [];
  const newTask = {
    taskId: `task-${nanoid(10)}`,
    title,
    ownerAgentId: ownerAgentId || 'main',
    projectId: projectId || null,
    status: status || 'todo',
    priority: priority || 'medium',
    riskLevel: riskLevel || 'medium',
    createdAt: new Date().toISOString(),
  };
  tasks.push(newTask);
  writeJson('tasks.json', tasks);

  recordTimeline({
    agent: newTask.ownerAgentId,
    type: 'task_create',
    targetId: newTask.taskId,
    summary: `创建任务: ${title}`,
    before: {},
    after: newTask,
  });

  res.status(201).json({
    ...newTask,
    note: '3.31+ 推荐通过 openclaw tasks create 管理主任务；当前记录写入 runtime/tasks.json，作为本地补充任务。',
  });
});

// PATCH /api/tasks/:taskId
app.patch('/api/tasks/:taskId', (req, res) => {
  const tasks = readJson('tasks.json') || [];
  const idx = tasks.findIndex(t => t.taskId === req.params.taskId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const before = { ...tasks[idx] };
  const allowed = ['title', 'ownerAgentId', 'projectId', 'status', 'priority', 'riskLevel', 'dod', 'artifacts', 'rollbackPlan'];
  const updates = req.body;
  const updated = { ...before };
  for (const key of allowed) {
    if (updates[key] !== undefined) updated[key] = updates[key];
  }
  updated.updatedAt = new Date().toISOString();
  tasks[idx] = updated;
  writeJson('tasks.json', tasks);

  recordTimeline({
    agent: updated.ownerAgentId || 'system',
    type: 'task_update',
    targetId: updated.taskId,
    summary: `更新任务: ${updated.title}`,
    before,
    after: updated,
  });

  res.json(updated);
});

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

  recordTimeline({
    agent: newProject.owner,
    type: 'project_create',
    targetId: newProject.projectId,
    summary: `创建项目: ${name}`,
    before: {},
    after: newProject,
  });

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

// DELETE /api/projects/:projectId — archive (soft-delete) a project
app.delete('/api/projects/:projectId', (req, res) => {
  const projects = readJson('projects.json') || [];
  const idx = projects.findIndex(p => p.projectId === req.params.projectId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const before = { ...projects[idx] };
  projects[idx] = { ...before, status: 'archived', archivedAt: new Date().toISOString() };
  writeJson('projects.json', projects);

  recordTimeline({
    agent: 'system',
    type: 'project_archive',
    targetId: req.params.projectId,
    summary: `归档项目: ${before.name}`,
    before: { status: before.status },
    after: { status: 'archived' },
  });

  res.json(projects[idx]);
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

  recordTimeline({
    agent: 'main',
    type: 'approval_action',
    targetId: approvals[idx].approvalId,
    summary: `审批通过: ${approvals[idx].title || approvals[idx].approvalId}`,
    before: { status: 'pending' },
    after: { status: 'approved', comment },
  });

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

  recordTimeline({
    agent: 'main',
    type: 'approval_action',
    targetId: approvals[idx].approvalId,
    summary: `审批拒绝: ${approvals[idx].title || approvals[idx].approvalId}`,
    before: { status: 'pending' },
    after: { status: 'rejected', comment },
  });

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

// GET /api/timeline
app.get('/api/timeline', (req, res) => {
  const filePath = path.join(RUNTIME_DIR, 'timeline.log');
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

  // Filter by agent
  if (req.query.agent) {
    entries = entries.filter(e => e.agent === req.query.agent);
  }

  // Filter by type
  if (req.query.type) {
    entries = entries.filter(e => e.type === req.query.type);
  }

  // Filter by time range
  if (req.query.from) {
    const fromMs = new Date(req.query.from).getTime();
    entries = entries.filter(e => new Date(e.ts).getTime() >= fromMs);
  }
  if (req.query.to) {
    const toMs = new Date(req.query.to).getTime();
    entries = entries.filter(e => new Date(e.ts).getTime() <= toMs);
  }

  // Sort by ts descending (newest first)
  entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

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
    // Get doc before for timeline
    const before = indexer.getDoc(req.params.id) || {};
    const result = indexer.putDoc(req.params.id, content);
    recordTimeline({
      agent: 'main',
      type: 'doc_write',
      targetId: req.params.id,
      summary: `更新文档: ${req.params.id}`,
      before: { content: before.content || '' },
      after: { content },
    });
    res.json(result);
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

// PUT /api/memory/:agentId
app.put('/api/memory/:agentId', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  try {
    const before = indexer.getMemory(req.params.agentId) || {};
    const result = indexer.putMemory(req.params.agentId, content);
    recordTimeline({
      agent: req.params.agentId,
      type: 'memory_write',
      targetId: req.params.agentId,
      summary: `更新记忆: ${req.params.agentId}`,
      before: { content: before.content || '' },
      after: { content },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Budget helpers ──────────────────────────────────────────────

const BUDGET_CONFIG_FILE = path.join(RUNTIME_DIR, 'budget-config.json');

function loadBudgetConfig() {
  try {
    return JSON.parse(fs.readFileSync(BUDGET_CONFIG_FILE, 'utf8'));
  } catch {
    // Default: 1M tokens/month, warn at 80%
    return { monthlyLimit: 1_000_000, warnAtPercent: 80 };
  }
}

function getBudgetFromSessions() {
  const snap = poll.getSnapshot();
  if (!snap) return null;
  const sessions = snap.sessions?._raw || [];
  // Use the sessions data from snapshot to compute monthly usage
  // Fall back to aggregating from session list if available
  try {
    const out = execSync('openclaw status --json 2>&1', { shell: true, timeout: 10_000 });
    const firstBrace = out.indexOf('{');
    if (firstBrace === -1) return null;
    const statusData = JSON.parse(out.slice(firstBrace));
    const recentSessions = statusData?.sessions?.recent || [];
    const now = Date.now();
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const monthSessions = recentSessions.filter(s => s.updatedAt && s.updatedAt > monthAgo);
    const inputTokens = monthSessions.reduce((sum, s) => sum + (s.inputTokens || 0), 0);
    const outputTokens = monthSessions.reduce((sum, s) => sum + (s.outputTokens || 0), 0);
    const cacheRead = monthSessions.reduce((sum, s) => sum + (s.cacheRead || 0), 0);
    const totalTokens = monthSessions.reduce((sum, s) => sum + (s.totalTokens || 0), 0);
    return { inputTokens, outputTokens, cacheRead, totalTokens, sessionCount: monthSessions.length };
  } catch {
    return null;
  }
}

app.get('/api/settings/health', (req, res) => {
  const snap = poll.getSnapshot();
  let channelStatus = [];
  try {
    const out = execSync('openclaw channels status --probe 2>&1', { shell: true, timeout: 10_000 });
    channelStatus = parseChannelProbe(out.toString());
  } catch {
    channelStatus = (snap?.gateway?.channelStatus || []).map((c) => ({
      channel: c.channel,
      status: c.status,
    }));
  }

  const config = loadBudgetConfig();
  const usage = getBudgetFromSessions();
  const budget = usage
    ? {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheRead: usage.cacheRead,
        totalTokens: usage.totalTokens,
        monthlyLimit: config.monthlyLimit,
        warnAtPercent: config.warnAtPercent,
        percentUsed: Math.round((usage.totalTokens / config.monthlyLimit) * 100),
        sessionCount: usage.sessionCount,
        status: usage.totalTokens >= config.monthlyLimit
          ? 'exceeded'
          : usage.totalTokens >= config.monthlyLimit * (config.warnAtPercent / 100)
            ? 'warning'
            : 'ok',
      }
    : null;

  res.json({
    gateway: snap?.gateway || { status: 'unknown', version: 'unknown' },
    channel: channelStatus,
    openclawVersion: snap?.gateway?.version || 'unknown',
    budget,
  });
});

// PATCH /api/settings/budget — update budget config
app.patch('/api/settings/budget', (req, res) => {
  const config = loadBudgetConfig();
  const { monthlyLimit, warnAtPercent } = req.body;
  if (monthlyLimit !== undefined) config.monthlyLimit = Number(monthlyLimit);
  if (warnAtPercent !== undefined) config.warnAtPercent = Number(warnAtPercent);
  fs.writeFileSync(BUDGET_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  res.json({ updated: true, config });
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

app.get('/api/action-queue', (req, res) => {
  const acks = readJson('acks.json') || [];
  res.json(acks);
});

// POST /api/action-queue/:itemId/ack
app.post('/api/action-queue/:itemId/ack', (req, res) => {
  const acks = readJson('acks.json') || [];
  const { snoozeUntil } = req.body || {};
  const existing = acks.find(a => a.itemId === req.params.itemId);
  if (existing) {
    existing.ackedAt = new Date().toISOString();
    if (snoozeUntil) existing.snoozeUntil = snoozeUntil;
  } else {
    acks.push({
      itemId: req.params.itemId,
      ackedAt: new Date().toISOString(),
      ...(snoozeUntil ? { snoozeUntil } : {}),
    });
  }
  writeJson('acks.json', acks);
  recordTimeline({
    agent: 'system',
    type: 'exception_ack',
    targetId: req.params.itemId,
    summary: `确认异常: ${req.params.itemId}`,
    before: {},
    after: { ackedAt: new Date().toISOString() },
  });
  res.json({ ok: true, itemId: req.params.itemId });
});

// ── Live Sessions ─────────────────────────────────────────────

// GET /api/sessions/list — active session metadata from last snapshot
app.get('/api/sessions/list', (req, res) => {
  const snap = poll.getSnapshot();
  res.json(snap?.sessions?._raw || []);
});

// GET /api/sessions/stream — SSE stream of session events
const _sseClients = new Set();

app.get('/api/sessions/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay recent events on connect
  const recent = sessionWatcher.getRecentEvents(200);
  for (const ev of recent) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  _sseClients.add(res);
  req.on('close', () => _sseClients.delete(res));
});

sessionWatcher.on('event', (ev) => {
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const client of _sseClients) {
    client.write(payload);
  }
});

// ── Start ─────────────────────────────────────────────────────

poll.start();
sessionWatcher.start();

app.listen(PORT, () => {
  console.log(`OpenClaw Control Center listening on http://localhost:${PORT}`);
});
