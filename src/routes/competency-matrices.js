const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

function rowToCm(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_description: row.job_description_id,
    skillGroups: row.skill_groups || [],
    approved: row.approved,
    vacancies: row.vacancies != null ? row.vacancies : 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Ensure vacancies column exists (migration for existing DBs)
async function ensureVacanciesColumn() {
  await pool.query(`ALTER TABLE competency_matrices ADD COLUMN IF NOT EXISTS vacancies INTEGER DEFAULT 1`);
}

// GET /api/competency-matrices/by-jd/:jdId
router.get('/by-jd/:jdId', async (req, res) => {
  await ensureVacanciesColumn().catch(() => {});
  const jdId = parseInt(req.params.jdId, 10);
  if (Number.isNaN(jdId)) return res.status(400).json({ error: { message: 'Invalid JD id' } });
  const jdCheck = await pool.query(
    'SELECT id, created_by FROM job_descriptions WHERE id = $1',
    [jdId]
  );
  const jd = jdCheck.rows[0];
  if (!jd) return res.status(404).json({ error: { message: 'JD not found' } });
  if (jd.created_by != null && jd.created_by !== req.user.id) {
    return res.status(403).json({ error: { message: 'Forbidden' } });
  }
  const r = await pool.query(
    'SELECT * FROM competency_matrices WHERE job_description_id = $1',
    [jdId]
  );
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: { message: 'Competency matrix not found for this JD. Generate one from the JD first.' } });
  return res.json(rowToCm(row));
});

// POST /api/competency-matrices
router.post('/', async (req, res) => {
  const body = req.body || {};
  const jobDescriptionRaw = body.job_description;
  if (jobDescriptionRaw == null || jobDescriptionRaw === '') {
    return res.status(400).json({ error: { message: 'job_description is required' } });
  }
  const job_description = parseInt(jobDescriptionRaw, 10);
  if (Number.isNaN(job_description)) {
    return res.status(400).json({ error: { message: 'job_description must be a number' } });
  }
  const jdCheck = await pool.query(
    'SELECT id, created_by FROM job_descriptions WHERE id = $1',
    [job_description]
  );
  const jd = jdCheck.rows[0];
  if (!jd) return res.status(404).json({ error: { message: 'JD not found' } });
  if (jd.created_by != null && jd.created_by !== req.user.id) {
    return res.status(403).json({ error: { message: 'Forbidden' } });
  }
  const skillGroups = Array.isArray(body.skillGroups) ? body.skillGroups : [];
  const approved = !!body.approved;
  const r = await pool.query(
    `INSERT INTO competency_matrices (job_description_id, skill_groups, approved)
     VALUES ($1, $2, $3)
     ON CONFLICT (job_description_id) DO UPDATE SET skill_groups = EXCLUDED.skill_groups, approved = EXCLUDED.approved, updated_at = NOW()
     RETURNING *`,
    [job_description, JSON.stringify(skillGroups), approved]
  );
  const row = r.rows[0];
  if (!row) return res.status(500).json({ error: { message: 'Failed to save competency matrix' } });
  return res.status(201).json(rowToCm(row));
});

// PUT /api/competency-matrices/:id
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: { message: 'Invalid id' } });
  const r = await pool.query(
    `SELECT c.*, j.created_by FROM competency_matrices c
     JOIN job_descriptions j ON j.id = c.job_description_id
     WHERE c.id = $1`,
    [id]
  );
  const existing = r.rows[0];
  if (!existing) return res.status(404).json({ error: { message: 'Not found' } });
  if (existing.created_by != null && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: { message: 'Forbidden' } });
  }
  const body = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (body.skillGroups !== undefined) {
    updates.push(`skill_groups = $${i++}`);
    values.push(JSON.stringify(Array.isArray(body.skillGroups) ? body.skillGroups : []));
  }
  if (body.approved !== undefined) {
    updates.push(`approved = $${i++}`);
    values.push(!!body.approved);
  }
  if (body.vacancies !== undefined) {
    const v = Math.max(1, Math.min(999, parseInt(body.vacancies, 10) || 1));
    updates.push(`vacancies = $${i++}`);
    values.push(v);
  }
  if (updates.length === 0) {
    return res.json(rowToCm(existing));
  }
  values.push(id);
  await pool.query(
    `UPDATE competency_matrices SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
    values
  );
  const r2 = await pool.query('SELECT * FROM competency_matrices WHERE id = $1', [id]);
  const updated = r2.rows[0];
  if (!updated) return res.status(500).json({ error: { message: 'Failed to update competency matrix' } });
  return res.json(rowToCm(updated));
});

module.exports = router;
