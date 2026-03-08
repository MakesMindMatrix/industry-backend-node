#!/usr/bin/env node
/**
 * Test external Strapi API connectivity (program-trackers, learners).
 * Run: node scripts/test-external-api.js
 * Set EXTERNAL_LEARNERS_API_URL in .env or it defaults to https://api-dev.mindmatrix.io
 */
require('dotenv').config();
const BASE = (process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io').replace(/\/$/, '');

async function test() {
  console.log('Testing external API:', BASE);
  console.log('---');

  try {
    const ptQuery = require('../src/lib/strapiQuery').programTrackersByCompletion(0, { page: 1, pageSize: 5 });
    const ptRes = await fetch(`${BASE}/api/program-trackers?${ptQuery}`);
    const ptJson = await ptRes.json().catch(() => ({}));
    const ptData = Array.isArray(ptJson.data) ? ptJson.data : [];
    console.log('program-trackers:', ptRes.status, 'count:', ptData.length);
    if (ptData.length > 0) {
      const r = ptData[0];
      const user = r.user ?? r.attributes?.user;
      const docId = user?.documentId ?? user?.data?.attributes?.documentId ?? user?.attributes?.documentId;
      console.log('  sample documentId:', docId);
    } else if (!ptRes.ok) {
      console.log('  error:', ptJson?.error?.message || ptJson?.message || ptRes.statusText);
    }
  } catch (e) {
    console.log('program-trackers: FAILED', e?.message);
  }

  try {
    const lRes = await fetch(`${BASE}/api/learners?pagination[page]=1&pagination[pageSize]=3`);
    const lJson = await lRes.json().catch(() => ({}));
    const lData = Array.isArray(lJson.data) ? lJson.data : [];
    console.log('learners:', lRes.status, 'count:', lData.length);
    if (lData.length > 0) {
      const r = lData[0];
      const attrs = r.attributes || r;
      console.log('  sample documentId:', attrs.documentId ?? r.documentId);
    } else if (!lRes.ok) {
      console.log('  error:', lJson?.error?.message || lJson?.message || lRes.statusText);
    }
  } catch (e) {
    console.log('learners: FAILED', e?.message);
  }

  console.log('---');
  console.log('Done. If counts are 0, check EXTERNAL_LEARNERS_API_URL and API availability.');
}

test();
