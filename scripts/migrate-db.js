/**
 * Run additive migrations on existing database.
 * Usage: node scripts/migrate-db.js
 * Safe to run multiple times.
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
  const migrationsPath = path.join(__dirname, '..', 'src', 'db', 'migrations.sql');
  const sql = fs.readFileSync(migrationsPath, 'utf8');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      console.log('OK:', stmt.slice(0, 60) + '...');
    } catch (err) {
      console.warn('Skip (may already exist):', err.message);
    }
  }
  console.log('Migrations complete.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
