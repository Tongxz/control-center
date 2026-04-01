'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = path.join(__dirname, 'runtime', 'last-snapshot.json');
const TASKS_SNAPSHOT_FILE = path.join(__dirname, 'runtime', 'tasks-snapshot.json');
const POLL_INTERVAL_MS = 30_000;

let lastSnapshot = null;

// ── CLI Helpers ────────────────────────────────────────────────

function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', args, { shell: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0 && stderr) {
        resolve({ ok: false, error: stderr.trim() });
      } else {
        // Some openclaw commands emit JSON on stderr (e.g. tasks list --json)
        resolve({ ok: true, data: stdout.trim() || stderr.trim() });
      }
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function tryParseJson(raw) {
  try { return { ok: true, data: JSON.parse(raw) }; }
  catch { return { ok: false }; }
}

function parseAgentsList(text) {
  // openclaw agents list --json emits plugin lines first (start with [plugins])
  // then the actual JSON array. Extract just the JSON portion.
  const firstBrace = text.indexOf('[');
  const lastBrace = text.lastIndexOf(']');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try {
    const arr = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function parseCronList(text) {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try {
    const obj = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    return obj.jobs || null;
  } catch {
    return null;
  }
}

function parseStatusJson(text) {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  try {
    return JSON.parse(text.slice(firstBrace));
  } catch {
    return null;
  }
}

function parseSessionsJson(text) {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  try {
    return JSON.parse(text.slice(firstBrace));
  } catch {
    return null;
  }
}

function parseTasksJson(text) {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  try {
    const obj = JSON.parse(text.slice(firstBrace));
    return Array.isArray(obj?.tasks) ? obj.tasks : [];
  } catch {
    return null;
  }
}

// ── Snapshot Builder ────────────────────────────────────────────

function buildSnapshot(statusData, agentsData, cronJobs, sessionsData, tasksData) {
  // Gateway
  const gateway = {
    status: 'healthy',
    version: statusData?.runtimeVersion || 'unknown',
    uptime: statusData?.uptime || null,
    os: statusData?.os || null,
    nodeVersion: statusData?.nodeVersion || null,
    address: statusData?.address || null,
    channelStatus: (statusData?.channelSummary || []).map((c) => {
      const parts = c.split(':');
      return { channel: parts[0]?.trim() || c, status: parts[1]?.trim() || 'unknown' };
    }),
  };

  // Agents
  const agents = (agentsData || []).map((a) => {
    // find active sessions for this agent
    const agentSessions = (sessionsData?.sessions || []).filter(
      (s) => s.agentId === a.id
    );
    const activeCount = agentSessions.length;
    const lastSession = agentSessions.sort((x, y) => y.updatedAt - x.updatedAt)[0];
    const isBusy = activeCount > 0;
    return {
      agentId: a.id,
      displayName: a.identityEmoji
        ? `${a.identityEmoji} ${a.identityName || a.id}`
        : (a.identityName || a.id),
      model: a.model || null,
      status: isBusy ? 'busy' : 'idle',
      currentTaskId: null,
      activeSessionCount: activeCount,
      lastActivity: lastSession
        ? new Date(lastSession.updatedAt).toISOString()
        : null,
    };
  });

  // Cron
  const cron = {
    jobs: (cronJobs || []).map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule?.expr || (j.schedule?.everyMs ? `every ${j.schedule.everyMs}ms` : 'unknown'),
      nextRun: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
      lastRun: j.state?.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null,
      status: j.state?.lastStatus || (j.enabled ? 'ok' : 'disabled'),
      lastError: j.state?.lastRunStatus === 'error' ? j.state.lastError : null,
    })),
  };

  // Sessions overview
  const allSessions = sessionsData?.sessions || [];
  const sessions = {
    totalActive: allSessions.length,
    errorCount: allSessions.filter((s) => s.flags?.includes('error')).length,
    blockedCount: 0,
    _raw: allSessions,
  };

  // System
  const system = {
    mode: 'readonly',
    openclawVersion: statusData?.runtimeVersion || 'unknown',
    securityFlags: [],
  };

  return {
    generatedAt: new Date().toISOString(),
    gateway,
    agents,
    cron,
    sessions,
    exceptions: { critical: 0, high: 0, medium: 0, low: 0, pendingAction: 0 },
    memory: { mainMemoryStatus: 'ok', lastUpdated: null },
    system,
    tasks: tasksData || [],
  };
}

// ── Poll Loop ───────────────────────────────────────────────────

let pollTimer = null;

async function pollOnce() {
  const [statusResult, agentsResult, cronResult, sessionsResult, tasksResult] = await Promise.all([
    runCli(['status', '--json']),
    runCli(['agents', 'list', '--json']),
    runCli(['cron', 'list', '--json']),
    runCli(['sessions', '--all-agents', '--active', '60', '--json']),
    runCli(['tasks', 'list', '--json']),
  ]);

  const statusData = statusResult.ok ? parseStatusJson(statusResult.data)?.ok !== false ? parseStatusJson(statusResult.data) : null : null;
  const agentsData = agentsResult.ok ? parseAgentsList(agentsResult.data) : null;
  const cronJobs = cronResult.ok ? parseCronList(cronResult.data) : null;
  const sessionsData = sessionsResult.ok ? parseSessionsJson(sessionsResult.data) : null;
  const tasksData = tasksResult.ok ? parseTasksJson(tasksResult.data) : [];

  const snapshot = buildSnapshot(
    statusData,
    agentsData,
    cronJobs,
    sessionsData,
    tasksData
  );

  // Write to file, but don't crash if it fails
  try {
    const dir = path.dirname(SNAPSHOT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tasksSnapshot = {
      generatedAt: snapshot.generatedAt,
      tasks: Array.isArray(tasksData) ? tasksData : [],
      count: Array.isArray(tasksData) ? tasksData.length : 0,
    };
    fs.writeFileSync(TASKS_SNAPSHOT_FILE, JSON.stringify(tasksSnapshot, null, 2), 'utf8');
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
    lastSnapshot = snapshot;
    console.log(`[poll] snapshot updated at ${snapshot.generatedAt}, agents=${snapshot.agents.length}, jobs=${snapshot.cron.jobs.length}, tasks=${tasksSnapshot.count}`);
  } catch (err) {
    console.error('[poll] failed to write snapshot:', err.message);
  }
}

function start() {
  if (pollTimer) return; // already running
  // Run immediately, then on interval
  pollOnce().catch((err) => console.error('[poll] pollOnce error:', err));
  pollTimer = setInterval(() => {
    pollOnce().catch((err) => console.error('[poll] pollOnce error:', err));
  }, POLL_INTERVAL_MS);
  console.log(`[poll] started (interval=${POLL_INTERVAL_MS}ms)`);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[poll] stopped');
  }
}

function getSnapshot() {
  return lastSnapshot;
}

// Load last snapshot from disk if available (for cold start)
try {
  if (fs.existsSync(SNAPSHOT_FILE)) {
    lastSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  }
} catch (err) {
  console.error('[poll] failed to load existing snapshot:', err.message);
}

module.exports = { start, stop, getSnapshot };
