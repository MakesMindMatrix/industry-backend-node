const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

function rowToJd(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    jd: row.jd,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    competency_matrix: row.competency_matrix_id
      ? { id: row.competency_matrix_id, approved: row.cm_approved }
      : undefined,
  };
}

// GET /api/job-descriptions/mine
router.get('/mine', async (req, res) => {
  const r = await pool.query(
    `SELECT j.id, j.title, j.jd, j.status, j.created_at, j.updated_at,
            c.id AS competency_matrix_id, c.approved AS cm_approved
     FROM job_descriptions j
     LEFT JOIN competency_matrices c ON c.job_description_id = j.id
     WHERE j.created_by = $1
     ORDER BY j.updated_at DESC`,
    [req.user.id]
  );
  const list = r.rows.map((row) => rowToJd(row));
  return res.json(list);
});

// POST /api/job-descriptions
router.post('/', async (req, res) => {
  const body = req.body?.data ?? req.body ?? {};
  const { title, jd, status = 'draft' } = body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: { message: 'title is required' } });
  }
  const st = status === 'published' ? 'published' : 'draft';
  const r = await pool.query(
    `INSERT INTO job_descriptions (title, jd, status, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, title, jd, status, created_at, updated_at`,
    [title.trim(), typeof jd === 'string' ? jd : '', st, req.user.id]
  );
  const row = r.rows[0];
  if (!row) return res.status(500).json({ error: { message: 'Failed to create JD' } });
  return res.status(201).json(rowToJd(row));
});

// GET /api/job-descriptions/:id
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: { message: 'Invalid id' } });
  const r = await pool.query(
    `SELECT j.id, j.title, j.jd, j.status, j.created_at, j.updated_at, j.created_by,
            c.id AS competency_matrix_id, c.approved AS cm_approved
     FROM job_descriptions j
     LEFT JOIN competency_matrices c ON c.job_description_id = j.id
     WHERE j.id = $1`,
    [id]
  );
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: { message: 'Not found' } });
  if (row.created_by != null && row.created_by !== req.user.id) {
    return res.status(403).json({ error: { message: 'Forbidden' } });
  }
  return res.json(rowToJd(row));
});

// PUT /api/job-descriptions/:id
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: { message: 'Invalid id' } });
  const r = await pool.query(
    'SELECT id, created_by FROM job_descriptions WHERE id = $1',
    [id]
  );
  const existing = r.rows[0];
  if (!existing) return res.status(404).json({ error: { message: 'Not found' } });
  if (existing.created_by != null && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: { message: 'Forbidden' } });
  }
  const body = req.body?.data ?? req.body ?? {};
  const updates = [];
  const values = [];
  let i = 1;
  if (body.title !== undefined) { updates.push(`title = $${i++}`); values.push(String(body.title).trim()); }
  if (body.jd !== undefined) { updates.push(`jd = $${i++}`); values.push(body.jd); }
  if (body.status !== undefined) {
    const st = body.status === 'published' ? 'published' : 'draft';
    updates.push(`status = $${i++}`);
    values.push(st);
  }
  if (updates.length === 0) {
    const r2 = await pool.query(
      `SELECT j.id, j.title, j.jd, j.status, j.created_at, j.updated_at,
              c.id AS competency_matrix_id, c.approved AS cm_approved
       FROM job_descriptions j LEFT JOIN competency_matrices c ON c.job_description_id = j.id WHERE j.id = $1`,
      [id]
    );
    return res.json(rowToJd(r2.rows[0]));
  }
  values.push(id);
  await pool.query(
    `UPDATE job_descriptions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
    values
  );
  const r2 = await pool.query(
    `SELECT j.id, j.title, j.jd, j.status, j.created_at, j.updated_at,
            c.id AS competency_matrix_id, c.approved AS cm_approved
     FROM job_descriptions j LEFT JOIN competency_matrices c ON c.job_description_id = j.id WHERE j.id = $1`,
    [id]
  );
  const updatedRow = r2.rows[0];
  if (!updatedRow) return res.status(500).json({ error: { message: 'Failed to update JD' } });
  return res.json(rowToJd(updatedRow));
});

// DELETE /api/job-descriptions/:id
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: { message: 'Invalid id' } });
  const r = await pool.query('SELECT id, created_by FROM job_descriptions WHERE id = $1', [id]);
  const existing = r.rows[0];
  if (!existing) return res.status(404).json({ error: { message: 'Not found' } });
  if (existing.created_by != null && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: { message: 'Forbidden' } });
  }
  await pool.query('DELETE FROM job_descriptions WHERE id = $1', [id]);
  return res.json({ success: true });
});

module.exports = router;
