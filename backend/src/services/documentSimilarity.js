const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, 'document_similarity.py');

function runPython(args) {
  const candidates = [];
  if (process.env.PYTHON_BIN) candidates.push([process.env.PYTHON_BIN, []]);
  candidates.push(['python', []], ['python3', []], ['py', ['-3']]);

  for (const [command, prefix] of candidates) {
    try {
      const result = spawnSync(command, [...prefix, scriptPath, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (result.error) continue;
      if (result.status !== 0) continue;

      const parsed = JSON.parse((result.stdout || '').trim());
      if (parsed.ok) return parsed.results || [];
    } catch {
      // Try the next Python executable.
    }
  }

  return [];
}

async function findSimilarDocuments(candidatePath, documents, threshold = 0.93) {
  const existing = documents
    .filter((doc) => doc.filepath && doc.filepath !== candidatePath)
    .map((doc) => ({
      ...doc,
      filepath: path.resolve(doc.filepath),
    }))
    .filter((doc) => {
      try { return require('fs').existsSync(doc.filepath); } catch { return false; }
    });

  if (!existing.length) return [];

  const results = runPython([
    path.resolve(candidatePath),
    ...existing.map((doc) => doc.filepath),
  ]);

  return results
    .filter((item) => item.score >= threshold)
    .map((item) => {
      const doc = existing.find((candidate) => candidate.filepath === item.path);
      return {
        ...item,
        docId: doc?.docId,
        filename: doc?.filename,
        docHash: doc?.docHash,
        timestamp: doc?.timestamp,
      };
    });
}

module.exports = { findSimilarDocuments };
