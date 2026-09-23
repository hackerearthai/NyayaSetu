const express = require('express');
const authMiddleware = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const db = require('../db');

const router = express.Router();

// All /api/users routes require authentication
router.use(authMiddleware);

// -------------------------------------------------------------
// GET /api/users  [admin only]
// Returns the list of all users (without password hashes).
// -------------------------------------------------------------
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT "userId", username, role
         FROM users
        ORDER BY username ASC`,
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[USERS] List error:', err);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;
