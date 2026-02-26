/**
 * Create one industry user + profile so you can log in on the main Login page.
 * Usage: node scripts/seed-industry-user.js
 * Set in .env: INDUSTRY_SEED_EMAIL, INDUSTRY_SEED_PASSWORD (or SEED_EMAIL, SEED_PASSWORD)
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (process.env.DATABASE_HOST && process.env.DATABASE_NAME && process.env.DATABASE_USER && process.env.DATABASE_PASSWORD
    ? `postgresql://${process.env.DATABASE_USER}:${process.env.DATABASE_PASSWORD}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 5432}/${process.env.DATABASE_NAME}`
    : null),
});

const email = (process.env.INDUSTRY_SEED_EMAIL || process.env.SEED_EMAIL || '').trim().toLowerCase();
const password = process.env.INDUSTRY_SEED_PASSWORD || process.env.SEED_PASSWORD;

if (!email || !password) {
  console.error('Set INDUSTRY_SEED_EMAIL and INDUSTRY_SEED_PASSWORD (or SEED_EMAIL, SEED_PASSWORD) in .env');
  process.exit(1);
}

async function main() {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    console.log('Industry user already exists for', email);
    await pool.end();
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const userRes = await pool.query(
    `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [email, email, hash]
  );
  const userId = userRes.rows[0].id;
  const companyName = (email.split('@')[0] || 'Company').replace(/[^a-z0-9]/gi, ' ') + ' Company';
  await pool.query(
    `INSERT INTO industry_profiles (user_id, company_name, official_email, industry_type) VALUES ($1, $2, $3, 'Tech')`,
    [userId, companyName.trim() || 'Demo Company', email]
  );
  console.log('Created industry user:', email);
  console.log('You can now log in on the main Login page with this email and password.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
