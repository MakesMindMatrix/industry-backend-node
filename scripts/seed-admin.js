/**
 * Create or update the admin user from .env (ADMIN_EMAIL, ADMIN_PASSWORD).
 * Run when admin login fails: npm run seed-admin
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (process.env.DATABASE_HOST && process.env.DATABASE_NAME && process.env.DATABASE_USER && process.env.DATABASE_PASSWORD
    ? `postgresql://${process.env.DATABASE_USER}:${process.env.DATABASE_PASSWORD}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 5432}/${process.env.DATABASE_NAME}`
    : null),
});

async function main() {
  if (!pool.options.connectionString) {
    console.error('Set DATABASE_URL (or DATABASE_HOST, DATABASE_NAME, USER, PASSWORD) in .env');
    process.exit(1);
  }
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
  const hash = await bcrypt.hash(adminPassword, 10);
  await pool.query(
    `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [adminEmail, hash]
  );
  console.log('Admin upserted. Login at /admin/login with:', adminEmail, 'and your ADMIN_PASSWORD from .env');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
