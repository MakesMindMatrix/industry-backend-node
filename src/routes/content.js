const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');

// GET /api/content - list published content (for display)
router.get('/', async (req, res) => {
  const r = await pool.query(
    'SELECT id, slug, title, body, created_at, updated_at FROM content WHERE published = true ORDER BY updated_at DESC'
  );
  return res.json(r.rows);
});

// GET /api/content/:slug - get one by slug (for display)
router.get('/:slug', async (req, res) => {
  const r = await pool.query(
    'SELECT id, slug, title, body, created_at, updated_at FROM content WHERE published = true AND slug = $1',
    [req.params.slug]
  );
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: { message: 'Content not found' } });
  return res.json(row);
});

module.exports = router;
