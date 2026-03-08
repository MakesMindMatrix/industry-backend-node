'use strict';

const { pool } = require('../db/pool');
const { learnersForFilterSync } = require('../lib/strapiQuery');

const EXTERNAL_LEARNERS_BASE = () => (process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io').replace(/\/$/, '');

function getAttr(obj, ...paths) {
  if (!obj || typeof obj !== 'object') return '';
  const v = obj.attributes ?? obj;
  for (const p of paths) {
    const next = v?.[p] ?? v?.data?.attributes?.[p];
    if (next != null && typeof next === 'object' && next.name != null) return String(next.name).trim();
    if (next != null && typeof next === 'string') return next.trim();
  }
  return '';
}

async function ensureFilterOptionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS filter_options (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      value VARCHAR(500) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(type, value)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_filter_options_type ON filter_options(type)').catch(() => {});
}

/**
 * Sync colleges, branches, specialisations, universities from Strapi learners into filter_options table.
 * @returns {{ colleges: number, branches: number, specialisations: number, universities: number }}
 */
async function syncFilterOptionsFromStrapi() {
  const baseUrl = EXTERNAL_LEARNERS_BASE();
  const colleges = new Set();
  const branches = new Set();
  const specialisations = new Set();
  const universities = new Set();
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    try {
      const query = learnersForFilterSync(page, 100);
      const url = `${baseUrl}/api/learners?${query}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data.data) ? data.data : [];
      const meta = data.meta?.pagination || {};
      for (const item of list) {
        const attrs = item.attributes || item;
        const college = getAttr(attrs.master_college, 'name') || (attrs.master_college?.name ?? attrs.master_college?.data?.attributes?.name);
        if (college) colleges.add(String(college).trim());
        const branch = getAttr(attrs.branch, 'name') || (attrs.branch?.name ?? attrs.branch?.data?.attributes?.name);
        if (branch) branches.add(String(branch).trim());
        const uni = getAttr(attrs.university, 'name') || (attrs.university?.name ?? attrs.university?.data?.attributes?.name);
        if (uni) universities.add(String(uni).trim());
        const spec = attrs.specialisation || (typeof attrs.specialisation === 'string' ? attrs.specialisation : '');
        if (spec) specialisations.add(String(spec).trim());
      }
      hasMore = page < (meta.pageCount ?? 1);
      page += 1;
    } catch (err) {
      console.warn('[filterOptionsSync] fetch page failed', err?.message);
      break;
    }
  }
  await ensureFilterOptionsTable();
  for (const v of colleges) {
    await pool.query('INSERT INTO filter_options (type, value) VALUES ($1, $2) ON CONFLICT (type, value) DO NOTHING', ['college', v]).catch(() => {});
  }
  for (const v of branches) {
    await pool.query('INSERT INTO filter_options (type, value) VALUES ($1, $2) ON CONFLICT (type, value) DO NOTHING', ['branch', v]).catch(() => {});
  }
  for (const v of specialisations) {
    await pool.query('INSERT INTO filter_options (type, value) VALUES ($1, $2) ON CONFLICT (type, value) DO NOTHING', ['specialisation', v]).catch(() => {});
  }
  for (const v of universities) {
    await pool.query('INSERT INTO filter_options (type, value) VALUES ($1, $2) ON CONFLICT (type, value) DO NOTHING', ['university', v]).catch(() => {});
  }
  return {
    colleges: colleges.size,
    branches: branches.size,
    specialisations: specialisations.size,
    universities: universities.size,
  };
}

module.exports = { ensureFilterOptionsTable, syncFilterOptionsFromStrapi };
