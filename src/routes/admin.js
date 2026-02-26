const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');
const { adminAuthMiddleware, ADMIN_JWT_SECRET } = require('../middleware/adminAuth');
const { CSV_PATH } = require('../services/studentCsv');

// POST /api/admin/login — body: { email, password } or { identifier, password }
router.post('/login', async (req, res) => {
  const body = req.body || {};
  const emailOrId = body.email ?? body.identifier;
  const password = body.password;
  if (!emailOrId || !password) {
    return res.status(400).json({ error: { message: 'Email and password required' } });
  }
  const emailNorm = String(emailOrId).toLowerCase().trim();
  const r = await pool.query(
    'SELECT id, email, password_hash FROM admin_users WHERE email = $1',
    [emailNorm]
  );
  const admin = r.rows[0];
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    console.log('[admin] Login failed for', emailNorm, admin ? '(wrong password)' : '(no user)');
    return res.status(401).json({ error: { message: 'Invalid email or password' } });
  }
  console.log('[admin] Login OK for', admin.email);
  const token = jwt.sign(
    { adminId: admin.id, role: 'admin' },
    ADMIN_JWT_SECRET,
    { expiresIn: '24h' }
  );
  return res.json({
    jwt: token,
    admin: { id: admin.id, email: admin.email },
  });
});

// All routes below require admin auth
router.use(adminAuthMiddleware);

// GET /api/admin/content - list all content
router.get('/content', async (req, res) => {
  const r = await pool.query(
    'SELECT id, slug, title, body, published, created_at, updated_at FROM content ORDER BY updated_at DESC'
  );
  return res.json(r.rows);
});

// POST /api/admin/content - create
router.post('/content', async (req, res) => {
  const { slug, title, body, published = true } = req.body || {};
  if (!slug || typeof slug !== 'string' || !slug.trim()) {
    return res.status(400).json({ error: { message: 'slug is required' } });
  }
  const r = await pool.query(
    `INSERT INTO content (slug, title, body, published) VALUES ($1, $2, $3, $4)
     RETURNING id, slug, title, body, published, created_at, updated_at`,
    [slug.trim(), title || null, body || null, !!published]
  );
  return res.status(201).json(r.rows[0]);
});

// PUT /api/admin/content/:id - update
router.put('/content/:id', async (req, res) => {
  const { title, body, published, slug } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (slug !== undefined) { updates.push(`slug = $${i++}`); values.push(String(slug).trim()); }
  if (title !== undefined) { updates.push(`title = $${i++}`); values.push(title); }
  if (body !== undefined) { updates.push(`body = $${i++}`); values.push(body); }
  if (published !== undefined) { updates.push(`published = $${i++}`); values.push(!!published); }
  if (updates.length === 0) {
    const r = await pool.query('SELECT * FROM content WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
    return res.json(r.rows[0]);
  }
  values.push(req.params.id);
  const r = await pool.query(
    `UPDATE content SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    values
  );
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json(r.rows[0]);
});

// DELETE /api/admin/content/:id
router.delete('/content/:id', async (req, res) => {
  const r = await pool.query('DELETE FROM content WHERE id = $1 RETURNING id', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json({ success: true });
});

// --- Ecosystem Programs (Events & Contributions) ---
function programRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    body: row.body,
    status: row.status,
    program_type: row.program_type,
    students_count: row.students_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/programs', async (req, res) => {
  const r = await pool.query('SELECT * FROM ecosystem_programs ORDER BY updated_at DESC');
  return res.json(r.rows.map(programRowToJson));
});

router.post('/programs', async (req, res) => {
  const { title, summary, body, status, program_type, students_count } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: { message: 'title is required' } });
  }
  const r = await pool.query(
    `INSERT INTO ecosystem_programs (title, summary, body, status, program_type, students_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [title.trim(), summary || '', body || '', status || 'Active', program_type || '', parseInt(students_count, 10) || 0]
  );
  return res.status(201).json(programRowToJson(r.rows[0]));
});

router.put('/programs/:id', async (req, res) => {
  const { title, summary, body, status, program_type, students_count } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (title !== undefined) { updates.push(`title = $${i++}`); values.push(String(title).trim()); }
  if (summary !== undefined) { updates.push(`summary = $${i++}`); values.push(summary); }
  if (body !== undefined) { updates.push(`body = $${i++}`); values.push(body); }
  if (status !== undefined) { updates.push(`status = $${i++}`); values.push(status); }
  if (program_type !== undefined) { updates.push(`program_type = $${i++}`); values.push(program_type); }
  if (students_count !== undefined) { updates.push(`students_count = $${i++}`); values.push(parseInt(students_count, 10) || 0); }
  if (updates.length === 0) {
    const r = await pool.query('SELECT * FROM ecosystem_programs WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
    return res.json(programRowToJson(r.rows[0]));
  }
  values.push(req.params.id);
  const r = await pool.query(
    `UPDATE ecosystem_programs SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    values
  );
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json(programRowToJson(r.rows[0]));
});

router.delete('/programs/:id', async (req, res) => {
  const r = await pool.query('DELETE FROM ecosystem_programs WHERE id = $1 RETURNING id', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json({ success: true });
});

// --- Ecosystem Contributions ---
function contributionRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    icon: row.icon,
    title: row.title,
    description: row.description,
    cta_text: row.cta_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/contributions', async (req, res) => {
  const r = await pool.query('SELECT * FROM ecosystem_contributions ORDER BY updated_at DESC');
  return res.json(r.rows.map(contributionRowToJson));
});

router.post('/contributions', async (req, res) => {
  const { icon, title, description, cta_text } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: { message: 'title is required' } });
  }
  const r = await pool.query(
    `INSERT INTO ecosystem_contributions (icon, title, description, cta_text)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [icon || 'Globe', title.trim(), description || '', cta_text || 'Learn more']
  );
  return res.status(201).json(contributionRowToJson(r.rows[0]));
});

router.put('/contributions/:id', async (req, res) => {
  const { icon, title, description, cta_text } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (icon !== undefined) { updates.push(`icon = $${i++}`); values.push(icon); }
  if (title !== undefined) { updates.push(`title = $${i++}`); values.push(String(title).trim()); }
  if (description !== undefined) { updates.push(`description = $${i++}`); values.push(description); }
  if (cta_text !== undefined) { updates.push(`cta_text = $${i++}`); values.push(cta_text); }
  if (updates.length === 0) {
    const r = await pool.query('SELECT * FROM ecosystem_contributions WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
    return res.json(contributionRowToJson(r.rows[0]));
  }
  values.push(req.params.id);
  const r = await pool.query(
    `UPDATE ecosystem_contributions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
    values
  );
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json(contributionRowToJson(r.rows[0]));
});

router.delete('/contributions/:id', async (req, res) => {
  const r = await pool.query('DELETE FROM ecosystem_contributions WHERE id = $1 RETURNING id', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json({ success: true });
});

// --- Student IDs (CSV / admin CRUD) ---
async function ensureStudentIdsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_ids (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      external_id INTEGER,
      document_id VARCHAR(100),
      source VARCHAR(50) DEFAULT 'csv',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_student_ids_email ON student_ids(email)').catch(() => {});
  await pool.query('CREATE INDEX IF NOT EXISTS idx_student_ids_document_id ON student_ids(document_id)').catch(() => {});
}

function studentRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    external_id: row.external_id,
    document_id: row.document_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/admin/students — list all (view permission)
router.get('/students', async (req, res) => {
  await ensureStudentIdsTable();
  const r = await pool.query('SELECT * FROM student_ids ORDER BY id DESC');
  return res.json(r.rows.map(studentRowToJson));
});

// POST /api/admin/students/load-csv — load temp/student.csv into DB (replaces all rows with source='csv')
router.post('/students/load-csv', async (req, res) => {
  await ensureStudentIdsTable();
  const fullPath = path.resolve(CSV_PATH);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: { message: 'File not found: temp/student.csv' } });
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    return res.json({ loaded: 0, message: 'CSV has no data rows' });
  }
  const header = lines[0].toLowerCase().split(',').map((c) => c.trim());
  const emailIdx = header.indexOf('email');
  const idIdx = header.indexOf('id');
  const docIdIdx = header.indexOf('documentid');
  if (emailIdx === -1) {
    return res.status(400).json({ error: { message: 'CSV must have an email column' } });
  }
  await pool.query("DELETE FROM student_ids WHERE source = 'csv'");
  let loaded = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const email = (parts[emailIdx] || '').trim();
    if (!email) continue;
    const externalId = idIdx >= 0 && parts[idIdx] !== undefined && parts[idIdx].trim() !== ''
      ? parseInt(parts[idIdx].trim(), 10) : null;
    let docId = docIdIdx >= 0 && parts[docIdIdx] !== undefined ? parts[docIdIdx].trim() : null;
    if (docId === 'NOT_FOUND' || docId === '') docId = null;
    await pool.query(
      `INSERT INTO student_ids (email, external_id, document_id, source) VALUES ($1, $2, $3, 'csv')`,
      [email, Number.isNaN(externalId) ? null : externalId, docId]
    );
    loaded += 1;
  }
  return res.json({ loaded, message: `Loaded ${loaded} rows from temp/student.csv` });
});

// POST /api/admin/students/upload — parse CSV from body and insert (body: { csv: "..." })
router.post('/students/upload', async (req, res) => {
  await ensureStudentIdsTable();
  const csv = req.body?.csv;
  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: { message: 'Body must include csv: "email,id,documentId\\n..."' } });
  }
  const lines = csv.trim().split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    return res.json({ loaded: 0, message: 'CSV has no data rows' });
  }
  const header = lines[0].toLowerCase().split(',').map((c) => c.trim());
  const emailIdx = header.indexOf('email');
  const idIdx = header.indexOf('id');
  const docIdIdx = header.indexOf('documentid');
  if (emailIdx === -1) {
    return res.status(400).json({ error: { message: 'CSV must have an email column' } });
  }
  let loaded = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const email = (parts[emailIdx] || '').trim();
    if (!email) continue;
    const externalId = idIdx >= 0 && parts[idIdx] !== undefined && parts[idIdx].trim() !== ''
      ? parseInt(parts[idIdx].trim(), 10) : null;
    let docId = docIdIdx >= 0 && parts[docIdIdx] !== undefined ? parts[docIdIdx].trim() : null;
    if (docId === 'NOT_FOUND' || docId === '') docId = null;
    await pool.query(
      `INSERT INTO student_ids (email, external_id, document_id, source) VALUES ($1, $2, $3, 'upload')`,
      [email, Number.isNaN(externalId) ? null : externalId, docId]
    );
    loaded += 1;
  }
  return res.json({ loaded, message: `Inserted ${loaded} rows` });
});

// GET /api/admin/students/:id
router.get('/students/:id', async (req, res) => {
  const r = await pool.query('SELECT * FROM student_ids WHERE id = $1', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json(studentRowToJson(r.rows[0]));
});

// POST /api/admin/students — create one
router.post('/students', async (req, res) => {
  await ensureStudentIdsTable();
  const { email, external_id, document_id } = req.body || {};
  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: { message: 'email is required' } });
  }
  const extId = external_id !== undefined && external_id !== '' && external_id !== null
    ? parseInt(String(external_id), 10) : null;
  const docId = document_id !== undefined && document_id !== null ? String(document_id).trim() || null : null;
  const r = await pool.query(
    `INSERT INTO student_ids (email, external_id, document_id, source) VALUES ($1, $2, $3, 'manual')
     RETURNING *`,
    [email.trim(), Number.isNaN(extId) ? null : extId, docId]
  );
  return res.status(201).json(studentRowToJson(r.rows[0]));
});

// PUT /api/admin/students/:id
router.put('/students/:id', async (req, res) => {
  const { email, external_id, document_id } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (email !== undefined) { updates.push(`email = $${i++}`); values.push(String(email).trim()); }
  if (external_id !== undefined) {
    const v = external_id === '' || external_id === null ? null : parseInt(String(external_id), 10);
    updates.push(`external_id = $${i++}`);
    values.push(Number.isNaN(v) ? null : v);
  }
  if (document_id !== undefined) { updates.push(`document_id = $${i++}`); values.push(document_id === '' || document_id === null ? null : String(document_id).trim()); }
  if (updates.length === 0) {
    const r = await pool.query('SELECT * FROM student_ids WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
    return res.json(studentRowToJson(r.rows[0]));
  }
  updates.push(`updated_at = NOW()`);
  values.push(req.params.id);
  const r = await pool.query(
    `UPDATE student_ids SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json(studentRowToJson(r.rows[0]));
});

// DELETE /api/admin/students/:id
router.delete('/students/:id', async (req, res) => {
  const r = await pool.query('DELETE FROM student_ids WHERE id = $1 RETURNING id', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
  return res.json({ success: true });
});

module.exports = router;
