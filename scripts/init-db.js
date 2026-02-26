/**
 * Run once to create the database schema and optional default admin.
 * Usage: node scripts/init-db.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (process.env.DATABASE_HOST && process.env.DATABASE_NAME && process.env.DATABASE_USER && process.env.DATABASE_PASSWORD
    ? `postgresql://${process.env.DATABASE_USER}:${process.env.DATABASE_PASSWORD}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 5432}/${process.env.DATABASE_NAME}`
    : null),
});

if (!pool.options.connectionString) {
  console.error('Set DATABASE_URL or DATABASE_HOST, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD in .env');
  process.exit(1);
}

async function main() {
  const schemaPath = path.join(__dirname, '..', 'src', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('Schema created.');

  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(adminPassword, 10);
  await pool.query(
    `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [adminEmail, hash]
  );
  console.log('Admin user upserted:', adminEmail, '(use this email and ADMIN_PASSWORD to log in at /admin/login).');

  // Optional: seed one industry user so you can log in on the main Login page (without signing up first)
  const industryEmail = process.env.INDUSTRY_SEED_EMAIL || process.env.SEED_EMAIL;
  const industryPassword = process.env.INDUSTRY_SEED_PASSWORD || process.env.SEED_PASSWORD;
  if (industryEmail && industryPassword) {
    const emailNorm = String(industryEmail).toLowerCase().trim();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [emailNorm]);
    if (existing.rows.length === 0) {
      const userHash = await bcrypt.hash(industryPassword, 10);
      const userRes = await pool.query(
        `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [emailNorm, emailNorm, userHash]
      );
      const userId = userRes.rows[0].id;
      await pool.query(
        `INSERT INTO industry_profiles (user_id, company_name, official_email, industry_type) VALUES ($1, $2, $3, 'Tech')`,
        [userId, emailNorm.split('@')[0] + ' Company', emailNorm]
      );
      console.log('Seed industry user:', emailNorm, '(use this to log in on the main Login page).');
    } else {
      console.log('Industry user already exists for', emailNorm);
    }
  } else {
    console.log('Tip: Set INDUSTRY_SEED_EMAIL and INDUSTRY_SEED_PASSWORD in .env and re-run init-db to create a test industry login.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
