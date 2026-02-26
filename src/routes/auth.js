const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');

const INDUSTRY_TYPES = ['Tech', 'Fintech', 'SaaS', 'AI', 'Consulting', 'Healthcare', 'Manufacturing', 'Other'];
const COMPANY_SIZES = ['size_1_10', 'size_11_50', 'size_50_200', 'size_200_plus'];

// POST /api/auth/local - industry login
router.post('/local', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ error: { message: 'Identifier and password required' } });
  }
  const email = String(identifier).toLowerCase().trim();
  const r = await pool.query(
    'SELECT id, email, username, password_hash FROM users WHERE email = $1',
    [email]
  );
  const user = r.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(400).json({ error: { message: 'Invalid identifier or password' } });
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  return res.json({
    jwt: token,
    user: { id: user.id, email: user.email, username: user.username },
  });
});

// POST /api/auth/industry-register
router.post('/industry-register', async (req, res) => {
  const body = req.body || {};
  const {
    companyName,
    officialEmail,
    password,
    industryType,
    companySize = 'size_1_10',
    headquarters = '',
    briefDescription = '',
    hiringIntent = 'Both',
  } = body;

  if (!companyName || !officialEmail || !password || !industryType) {
    return res.status(400).json({ error: { message: 'companyName, officialEmail, password, and industryType are required' } });
  }
  const email = String(officialEmail).toLowerCase().trim();
  if (!INDUSTRY_TYPES.includes(industryType)) {
    return res.status(400).json({ error: { message: 'Invalid industryType' } });
  }
  const size = COMPANY_SIZES.includes(body.companySize) ? body.companySize : companySize;
  if (!COMPANY_SIZES.includes(size)) {
    return res.status(400).json({ error: { message: 'Invalid companySize' } });
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: { message: 'An account with this email already exists' } });
  }

  const password_hash = await bcrypt.hash(password, 10);
  const userRes = await pool.query(
    `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, username`,
    [email, email, password_hash]
  );
  const newUser = userRes.rows[0];

  await pool.query(
    `INSERT INTO industry_profiles (
      user_id, company_name, official_email, industry_type, company_size,
      headquarters, brief_description, hiring_intent
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newUser.id,
      String(companyName).trim(),
      email,
      industryType,
      size,
      String(headquarters || '').slice(0, 255),
      String(briefDescription || '').slice(0, 300),
      body.hiringIntent || hiringIntent,
    ]
  );

  const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: '7d' });
  return res.json({
    jwt: token,
    user: { id: newUser.id, email: newUser.email, username: newUser.username },
  });
});

module.exports = router;
