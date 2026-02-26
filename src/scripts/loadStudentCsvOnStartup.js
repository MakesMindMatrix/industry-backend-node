'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');

const CSV_PATH = path.join(__dirname, '..', '..', 'temp', 'student.csv');

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

/**
 * Load ./temp/student.csv into student_ids table (replaces rows with source='csv').
 * Called on server start so DB is always in sync with the file.
 */
async function loadStudentCsvOnStartup() {
  try {
    await ensureStudentIdsTable();
    const fullPath = path.resolve(CSV_PATH);
    if (!fs.existsSync(fullPath)) {
      console.log('[startup] temp/student.csv not found, skipping student sync');
      return { loaded: 0 };
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) {
      console.log('[startup] temp/student.csv has no data rows');
      return { loaded: 0 };
    }
    const header = lines[0].toLowerCase().split(',').map((c) => c.trim());
    const emailIdx = header.indexOf('email');
    const idIdx = header.indexOf('id');
    const docIdIdx = header.indexOf('documentid');
    if (emailIdx === -1) {
      console.warn('[startup] temp/student.csv missing email column, skipping');
      return { loaded: 0 };
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
    console.log(`[startup] Loaded ${loaded} rows from temp/student.csv into student_ids`);
    return { loaded };
  } catch (err) {
    console.warn('[startup] loadStudentCsvOnStartup failed:', err?.message);
    return { loaded: 0 };
  }
}

module.exports = { loadStudentCsvOnStartup };
