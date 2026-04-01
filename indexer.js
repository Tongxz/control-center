const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.join(process.env.HOME, '.openclaw', 'workspace');
const MEMORY_DIR = path.join(WORKSPACE_ROOT, 'memory');

function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * List all *.md files in ~/.openclaw/workspace/ (excluding memory/ subdirectory).
 * Returns [{id, path, size, updatedAt}]
 */
function listDocs() {
  let files;
  try {
    files = fs.readdirSync(WORKSPACE_ROOT);
  } catch {
    return [];
  }

  return files
    .filter(f => f.endsWith('.md'))
    .map(id => {
      const filePath = path.join(WORKSPACE_ROOT, id);
      const stat = statOrNull(filePath);
      return {
        id,
        path: id,
        size: stat ? stat.size : 0,
        updatedAt: stat ? stat.mtime.toISOString() : null,
      };
    })
    .filter(doc => doc.updatedAt !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Get a single doc by id (e.g. "IDENTITY.md").
 * Returns {id, path, content, size, updatedAt} or null.
 */
function getDoc(id) {
  const filePath = path.join(WORKSPACE_ROOT, id);
  const stat = statOrNull(filePath);
  if (!stat) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      id,
      path: id,
      content,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Write a doc by id.
 * Returns {ok: true} or throws.
 */
function putDoc(id, content) {
  const filePath = path.join(WORKSPACE_ROOT, id);
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true };
}

/**
 * List memory entries — one entry per distinct "agent" inferred from filenames.
 * Returns [{agentId, status, lastUpdated}]
 * "main" covers all bare YYYY-MM-DD.md files; suffixed files get their slug as agentId.
 */
function listMemory() {
  let files;
  try {
    files = fs.readdirSync(MEMORY_DIR);
  } catch {
    return [];
  }

  const mdFiles = files.filter(f => f.endsWith('.md'));

  // Map: agentId -> most recent mtime
  const agentMap = {};

  for (const file of mdFiles) {
    const filePath = path.join(MEMORY_DIR, file);
    const stat = statOrNull(filePath);
    if (!stat) continue;

    // Pattern: YYYY-MM-DD[-slug].md
    const slugMatch = file.match(/^\d{4}-\d{2}-\d{2}(-(.+))\.md$/);
    const agentId = slugMatch ? (slugMatch[2] || 'main') : 'main';

    const existing = agentMap[agentId];
    if (!existing || stat.mtime > existing.mtime) {
      agentMap[agentId] = { mtime: stat.mtime, file };
    }
  }

  return Object.entries(agentMap)
    .map(([agentId, { mtime, file }]) => ({
      agentId,
      status: 'ok',
      lastUpdated: mtime.toISOString(),
      _file: file,
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Get memory for an agentId.
 * Reads the most recently modified memory file matching that agentId.
 * Returns {agentId, content, status, lastUpdated} or {agentId, content:"", status:"empty"}.
 */
function getMemory(agentId) {
  let files;
  try {
    files = fs.readdirSync(MEMORY_DIR);
  } catch {
    return { agentId, content: '', status: 'empty', lastUpdated: null };
  }

  const mdFiles = files.filter(f => f.endsWith('.md'));
  const matches = [];

  for (const file of mdFiles) {
    const filePath = path.join(MEMORY_DIR, file);
    const stat = statOrNull(filePath);
    if (!stat) continue;

    const slugMatch = file.match(/^\d{4}-\d{2}-\d{2}(-(.+))\.md$/);
    const fileAgentId = slugMatch ? (slugMatch[2] || 'main') : 'main';

    if (fileAgentId === agentId) {
      matches.push({ file, stat });
    }
  }

  if (matches.length === 0) {
    return { agentId, content: '', status: 'empty', lastUpdated: null };
  }

  // Pick most recently modified
  matches.sort((a, b) => b.stat.mtime - a.stat.mtime);
  const { file, stat } = matches[0];

  try {
    const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
    return {
      agentId,
      content,
      status: 'ok',
      lastUpdated: stat.mtime.toISOString(),
    };
  } catch {
    return { agentId, content: '', status: 'empty', lastUpdated: null };
  }
}

/**
 * Write memory for an agentId.
 * Writes to the most recently modified file for the agent.
 * If no file exists, creates YYYY-MM-DD[-agentId].md in MEMORY_DIR.
 * Returns {ok: true, file} or throws.
 */
function putMemory(agentId, content) {
  let targetFile = null;

  try {
    const files = fs.readdirSync(MEMORY_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const matches = [];

    for (const file of mdFiles) {
      const filePath = path.join(MEMORY_DIR, file);
      const stat = statOrNull(filePath);
      if (!stat) continue;
      const slugMatch = file.match(/^\d{4}-\d{2}-\d{2}(-(.+))\.md$/);
      const fileAgentId = slugMatch ? (slugMatch[2] || 'main') : 'main';
      if (fileAgentId === agentId) matches.push({ file, stat });
    }

    if (matches.length > 0) {
      matches.sort((a, b) => b.stat.mtime - a.stat.mtime);
      targetFile = matches[0].file;
    }
  } catch {
    // MEMORY_DIR may not exist yet
  }

  if (!targetFile) {
    const today = new Date().toISOString().slice(0, 10);
    targetFile = agentId === 'main' ? `${today}.md` : `${today}-${agentId}.md`;
    try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch {}
  }

  fs.writeFileSync(path.join(MEMORY_DIR, targetFile), content, 'utf8');
  return { ok: true, file: targetFile };
}

module.exports = { listDocs, getDoc, putDoc, listMemory, getMemory, putMemory };
