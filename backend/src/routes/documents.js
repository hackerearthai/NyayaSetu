const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const db = require('../db');
const authMiddleware = require('../middleware/auth');
const chain = require('../blockchain/contract');
const { analyzeDocument } = require('../services/aiService');
const { findSimilarDocuments } = require('../services/documentSimilarity');

sharp.cache(false);

const router = express.Router();

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function removeFileQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn('[FILES] Could not remove file:', err.message);
  }
}

async function copyFileWithRetry(src, dest, retries = 5, delay = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      await fs.promises.copyFile(src, dest);
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

router.use(authMiddleware);

// ═════════════════════════════════════════════════════════════
// 1. POST /api/documents/upload
// ═════════════════════════════════════════════════════════════
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const uploaderId = req.body.uploaderId || req.user.userId;
    const filePath = req.file.path;
    const filename = req.file.originalname;
    const docId = uuidv4();

    const docHash = await hashFile(filePath);
    const { aiRiskFlag } = await analyzeDocument(filePath, filename);

    const exactMatch = await db.query(
      'SELECT "docId", filename, "docHash", timestamp FROM documents WHERE "docHash" = $1 LIMIT 1',
      [docHash],
    );

    if (exactMatch.rows.length) {
      removeFileQuietly(filePath);
      const match = exactMatch.rows[0];
      return res.status(409).json({
        error: 'Duplicate document detected',
        code: 'DUPLICATE_DOCUMENT',
        message: 'This file is already registered in Sentinel.',
        match: {
          docId: match.docId,
          filename: match.filename,
          similarity: 1,
          matchType: 'exact_hash',
          existingHash: match.docHash,
          newHash: docHash,
          timestamp: match.timestamp,
        },
      });
    }

    const existingDocs = await db.query(
      'SELECT "docId", filename, filepath, "docHash", timestamp FROM documents',
    );

    const similar = await findSimilarDocuments(filePath, existingDocs.rows, 0.93);

    if (similar.length) {
      removeFileQuietly(filePath);
      const match = similar[0];
      return res.status(409).json({
        error: 'Possible modified duplicate detected',
        code: 'POSSIBLE_MODIFIED_DUPLICATE',
        message: 'This upload is highly similar to an already registered document but has a different SHA-256 hash. Registration was blocked for review.',
        match: {
          docId: match.docId,
          filename: match.filename,
          similarity: match.score,
          matchType: match.matchType,
          visualSimilarity: match.visualSimilarity,
          textSimilarity: match.textSimilarity,
          existingHash: match.docHash,
          newHash: docHash,
          timestamp: match.timestamp,
        },
      });
    }

    const chainResult = await chain.registerDocument(docId, docHash, uploaderId);
    if (!chainResult) {
      removeFileQuietly(filePath);
      return res.status(503).json({
        error: 'Blockchain service unavailable',
        message: 'Document was not stored because its integrity record could not be registered on-chain.',
      });
    }

    await db.query(
      `INSERT INTO documents ("docId", filename, filepath, "docHash", "uploaderId", timestamp, "aiRiskFlag", "currentVersion")
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, 1)`,
      [docId, filename, filePath, docHash, uploaderId, aiRiskFlag],
    );

    await db.query(
      `INSERT INTO document_versions ("docId", version, filepath, "docHash", reason, "updatedBy", timestamp)
       VALUES ($1, 1, $2, $3, 'Initial upload', $4, NOW())`,
      [docId, filePath, docHash, uploaderId],
    );

    return res.status(201).json({
      docId,
      docHash,
      aiRiskFlag,
      txHash: chainResult.txHash,
    });
  } catch (err) {
    console.error('[UPLOAD] Error:', err);
    return res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// 2. GET /api/documents
// ═════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT "docId", filename, "docHash", "uploaderId", timestamp FROM documents ORDER BY timestamp DESC',
    );

    const docs = await Promise.all(
      result.rows.map(async (doc) => {
        let status = 'pending';

        try {
          const fileResult = await db.query(
            'SELECT filepath FROM documents WHERE "docId" = $1',
            [doc.docId],
          );

          const filePath = fileResult.rows[0]?.filepath;
          if (filePath && fs.existsSync(filePath)) {
            const currentHash = await hashFile(filePath);
            const chainResult = await chain.verifyDocument(doc.docId, currentHash);

            if (chainResult) {
              status = chainResult.verified ? 'verified' : 'tampered';
            }
          }
        } catch (err) {
          console.warn(`[LIST] Verify check failed for ${doc.docId}:`, err.message);
        }

        return {
          docId: doc.docId,
          filename: doc.filename,
          status,
          uploaderId: doc.uploaderId,
          timestamp: doc.timestamp,
        };
      }),
    );

    return res.json(docs);
  } catch (err) {
    console.error('[LIST] Error:', err);
    return res.status(500).json({ error: 'Failed to list documents' });
  }
});

// ═════════════════════════════════════════════════════════════
// 3. GET /api/documents/:docId
// ═════════════════════════════════════════════════════════════
router.get('/:docId', async (req, res) => {
  try {
    const { docId } = req.params;

    const result = await db.query(
      'SELECT * FROM documents WHERE "docId" = $1',
      [docId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    await chain.logAccess(docId, req.user.userId, 'view');

    const doc = result.rows[0];

    const versions = await db.query(
      'SELECT version, "docHash", reason, "updatedBy", timestamp FROM document_versions WHERE "docId" = $1 ORDER BY version ASC',
      [docId],
    );

    const onChainHistory = await chain.getDocumentHistory(docId);

    return res.json({
      ...doc,
      versions: versions.rows,
      accessLog: onChainHistory || [],
    });
  } catch (err) {
    console.error('[DETAIL] Error:', err);
    return res.status(500).json({ error: 'Failed to get document details' });
  }
});

// ═════════════════════════════════════════════════════════════
// 4. POST /api/documents/:docId/verify
// ═════════════════════════════════════════════════════════════
router.post('/:docId/verify', async (req, res) => {
  try {
    const { docId } = req.params;

    const result = await db.query(
      'SELECT filepath, "docHash" FROM documents WHERE "docId" = $1',
      [docId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { filepath } = result.rows[0];

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const currentHash = await hashFile(filepath);
    const chainResult = await chain.verifyDocument(docId, currentHash);

    if (!chainResult) {
      return res.status(503).json({
        error: 'Blockchain service unavailable',
        message: 'The document could not be cryptographically verified.',
      });
    }

    const status = chainResult.verified ? 'verified' : 'tampered';

    return res.json({
      status,
      onChainHash: chainResult.onChainHash,
      currentHash,
      verifiedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[VERIFY] Error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// ═════════════════════════════════════════════════════════════
// Evidence Preview Routes
// ═════════════════════════════════════════════════════════════
router.get('/:docId/file/:type?', async (req, res) => {
  try {
    const { docId, type } = req.params;
    const result = await db.query(
      'SELECT filepath, filename FROM documents WHERE "docId" = $1',
      [docId],
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Document not found' });

    const currentPath = path.resolve(result.rows[0].filepath);
    let targetPath = currentPath;

    if (type === 'original') {
      const backupPath = `${currentPath}.sentinel-original`;
      if (fs.existsSync(backupPath)) {
        targetPath = backupPath;
      }
    }

    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Disposition', `inline; filename="${String(result.rows[0].filename).replace(/"/g, '')}"`);
    return res.sendFile(targetPath);
  } catch (err) {
    console.error('[FILE-PREVIEW] Error:', err);
    return res.status(500).json({ error: 'Unable to preview document' });
  }
});

router.get('/:docId/demo-original', async (req, res) => {
  try {
    const { docId } = req.params;
    const result = await db.query(
      'SELECT filepath, filename FROM documents WHERE "docId" = $1',
      [docId],
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Document not found' });

    const currentPath = path.resolve(result.rows[0].filepath);
    const backupPath = `${currentPath}.sentinel-original`;
    const filePath = fs.existsSync(backupPath) ? backupPath : currentPath;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Original file not found on disk' });

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Disposition', `inline; filename="${String(result.rows[0].filename).replace(/"/g, '')}"`);
    return res.sendFile(filePath);
  } catch (err) {
    console.error('[ORIGINAL-PREVIEW] Error:', err);
    return res.status(500).json({ error: 'Unable to preview original document' });
  }
});

// ═════════════════════════════════════════════════════════════
// 5. POST /api/documents/:docId/demo-tamper
// ═════════════════════════════════════════════════════════════
router.post('/:docId/demo-tamper', async (req, res) => {
  try {
    const { docId } = req.params;
    const result = await db.query(
      'SELECT filepath, "docHash" FROM documents WHERE "docId" = $1',
      [docId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { filepath, docHash } = result.rows[0];
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const backupPath = `${filepath}.sentinel-original`;
    if (!fs.existsSync(backupPath)) {
      await copyFileWithRetry(filepath, backupPath);
    }

    const ext = path.extname(filepath).toLowerCase();

    if (ext === '.pdf') {
      try {
        const existingPdfBytes = await fs.promises.readFile(filepath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const pages = pdfDoc.getPages();
        const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

        pages.forEach((page) => {
          const { width, height } = page.getSize();

          // 1. Exactly match the reference image: "Ram Nair (fictional)" with precise right-shift offset
          page.drawRectangle({
            x: width * 0.335,
            y: height * 0.770,
            width: width * 0.36,
            height: height * 0.026,
            color: rgb(1, 1, 1),
          });
          page.drawText('Ram Nair (fictional)', {
            x: width * 0.352,
            y: height * 0.775,
            size: 11,
            font: fontRegular,
            color: rgb(0, 0, 0),
          });

          // 2. Exactly match the reference image: "90,000" perfectly centered in the price column
          page.drawRectangle({
            x: width * 0.640,
            y: height * 0.268,
            width: width * 0.16,
            height: height * 0.028,
            color: rgb(1, 1, 1),
          });
          page.drawText('90,000', {
            x: width * 0.702,
            y: height * 0.274,
            size: 11,
            font: fontRegular,
            color: rgb(0, 0, 0),
          });
        });

        const modifiedPdfBytes = await pdfDoc.save();
        await fs.promises.writeFile(filepath, modifiedPdfBytes);
      } catch (pdfErr) {
        console.warn('[DEMO-TAMPER] PDF fallback applied:', pdfErr.message);
        await fs.promises.appendFile(filepath, Buffer.from('\nSENTINEL_DEMO_TAMPERED_RECORD\n', 'utf8'));
      }
    } else {
      try {
        const fileBuffer = await fs.promises.readFile(filepath);
        const metadata = await sharp(fileBuffer).metadata();
        const width = metadata.width || 800;
        const height = metadata.height || 1000;

        const svgOverlay = Buffer.from(`
          <svg width="${width}" height="${height}">
            <!-- Exact replica text: Ram Nair (fictional) with matching alignment -->
            <rect x="${Math.floor(width * 0.335)}" y="${Math.floor(height * 0.220)}" width="${Math.floor(width * 0.36)}" height="${Math.floor(height * 0.028)}" fill="white" />
            <text x="${Math.floor(width * 0.352)}" y="${Math.floor(height * 0.240)}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#000000">
              Ram Nair (fictional)
            </text>

            <!-- Exact replica text: 90,000 perfectly centered -->
            <rect x="${Math.floor(width * 0.640)}" y="${Math.floor(height * 0.696)}" width="${Math.floor(width * 0.16)}" height="${Math.floor(height * 0.030)}" fill="white" />
            <text x="${Math.floor(width * 0.702)}" y="${Math.floor(height * 0.716)}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#000000">
              90,000
            </text>
          </svg>
        `);

        const modifiedBuffer = await sharp(fileBuffer)
          .composite([{ input: svgOverlay, top: 0, left: 0 }])
          .toBuffer();

        await fs.promises.writeFile(filepath, modifiedBuffer);
      } catch (sharpError) {
        console.warn('[DEMO-TAMPER] Sharp fallback applied:', sharpError.message);
        await fs.promises.appendFile(filepath, Buffer.from('\nSENTINEL_DEMO_TAMPERED_RECORD\n', 'utf8'));
      }
    }

    const currentHash = await hashFile(filepath);

    return res.json({
      docId,
      status: currentHash === docHash ? 'verified' : 'tampered',
      originalHash: docHash,
      currentHash,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[DEMO-TAMPER] Error:', err);
    return res.status(500).json({ error: 'Demo tampering failed' });
  }
});

// ═════════════════════════════════════════════════════════════
// 6. POST /api/documents/:docId/demo-restore
// ═════════════════════════════════════════════════════════════
router.post('/:docId/demo-restore', async (req, res) => {
  try {
    const { docId } = req.params;
    const result = await db.query(
      'SELECT filepath, "docHash" FROM documents WHERE "docId" = $1',
      [docId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { filepath, docHash } = result.rows[0];
    const backupPath = `${filepath}.sentinel-original`;

    if (!fs.existsSync(backupPath)) {
      return res.status(409).json({
        error: 'No demo backup exists',
        message: 'Run Simulate Tampering first.',
      });
    }

    await copyFileWithRetry(backupPath, filepath);
    removeFileQuietly(backupPath);
    const currentHash = await hashFile(filepath);

    return res.json({
      docId,
      status: currentHash === docHash ? 'restored' : 'restore_failed',
      onChainHash: docHash,
      currentHash,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[DEMO-RESTORE] Error:', err);
    return res.status(500).json({ error: 'Restore failed' });
  }
});

// ═════════════════════════════════════════════════════════════
// 7. POST /api/documents/:docId/version
// ═════════════════════════════════════════════════════════════
router.post('/:docId/version', upload.single('file'), async (req, res) => {
  try {
    const { docId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const reason = req.body.reason || '';
    const updatedBy = req.body.updatedBy || req.user.userId;
    const filePath = req.file.path;

    if (!reason.trim()) {
      removeFileQuietly(filePath);
      return res.status(400).json({ error: 'Reason is required for a new version' });
    }

    const docResult = await db.query(
      'SELECT "currentVersion" FROM documents WHERE "docId" = $1',
      [docId],
    );

    if (docResult.rows.length === 0) {
      removeFileQuietly(filePath);
      return res.status(404).json({ error: 'Document not found' });
    }

    const newVersion = Number(docResult.rows[0].currentVersion) + 1;
    const newHash = await hashFile(filePath);

    const chainResult = await chain.addVersion(docId, newHash, reason, updatedBy);
    if (!chainResult) {
      removeFileQuietly(filePath);
      return res.status(503).json({
        error: 'Blockchain service unavailable',
        message: 'The new version was not stored because its integrity record could not be registered on-chain.',
      });
    }

    await db.query(
      `INSERT INTO document_versions ("docId", version, filepath, "docHash", reason, "updatedBy", timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [docId, newVersion, filePath, newHash, reason, updatedBy],
    );

    await db.query(
      `UPDATE documents SET "currentVersion" = $1, "docHash" = $2, filepath = $3 WHERE "docId" = $4`,
      [newVersion, newHash, filePath, docId],
    );

    return res.status(201).json({
      docId,
      version: newVersion,
      docHash: newHash,
      reason,
      updatedBy,
      txHash: chainResult.txHash,
    });
  } catch (err) {
    console.error('[VERSION] Error:', err);
    return res.status(500).json({ error: 'Version update failed' });
  }
});

// ═════════════════════════════════════════════════════════════
// 8. GET /api/documents/:docId/history
// ═════════════════════════════════════════════════════════════
router.get('/:docId/history', async (req, res) => {
  try {
    const { docId } = req.params;

    const history = await chain.getDocumentHistory(docId);

    if (history === null) {
      return res.status(503).json({
        error: 'Blockchain service unavailable',
        message: 'Document history could not be read from the blockchain.',
      });
    }

    return res.json(history);
  } catch (err) {
    console.error('[HISTORY] Error:', err);
    return res.status(500).json({ error: 'Failed to get history' });
  }
});

module.exports = router;