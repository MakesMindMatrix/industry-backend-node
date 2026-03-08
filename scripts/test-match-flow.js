#!/usr/bin/env node
/**
 * Test the full match flow: login, get JD+competency, run match, poll results.
 * Run: node scripts/test-match-flow.js
 * Uses INDUSTRY_SEED_EMAIL / INDUSTRY_SEED_PASSWORD from .env
 */
require('dotenv').config();
const BASE = process.env.VITE_API_URL || 'http://localhost:1337';

async function login() {
  const res = await fetch(`${BASE}/api/auth/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: process.env.INDUSTRY_SEED_EMAIL || 'industry@mx.com',
      password: process.env.INDUSTRY_SEED_PASSWORD || 'Industry@123',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Login failed');
  return data.jwt || data.token;
}

async function getJDs(token) {
  const res = await fetch(`${BASE}/api/job-descriptions/mine`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Failed to get JDs');
  return Array.isArray(data) ? data : [];
}

async function getCompetency(token, jdId) {
  const res = await fetch(`${BASE}/api/competency-matrices/by-jd/${jdId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Failed to get competency');
  return data;
}

async function runMatchBackground(token, body) {
  const res = await fetch(`${BASE}/api/jd/match-learners-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Match failed');
  return data;
}

async function getMatchResults(token, params) {
  const sp = new URLSearchParams(params);
  const res = await fetch(`${BASE}/api/jd/match-results?${sp}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to get results');
  return data;
}

async function main() {
  console.log('Testing match flow against', BASE);
  console.log('---');

  const token = await login();
  console.log('Logged in OK');

  const jds = await getJDs(token);
  const withMatrix = jds.filter((j) => j.status === 'published' && j.competency_matrix?.id);
  if (withMatrix.length === 0) {
    console.log('No published JDs with competency matrix. Create one first.');
    return;
  }
  const jd = withMatrix[0];
  console.log('Using JD:', jd.title, 'id:', jd.id);

  const comp = await getCompetency(token, jd.id);
  console.log('Competency matrix id:', comp.id, 'skillGroups:', comp.skillGroups?.length || 0);

  const body = {
    competencies: comp.skillGroups || [],
    competencyMatrixId: comp.id,
    jdId: jd.id,
    vacancies: 3,
  };
  await runMatchBackground(token, body);
  console.log('Match started. Waiting 60s for background job...');

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const results = await getMatchResults(token, { competencyMatrixId: comp.id });
    const count = Array.isArray(results.data) ? results.data.length : 0;
    console.log(`  Poll ${i + 1}: ${count} students`);
    if (count >= 15) {
      console.log('Got 15+ students. Done.');
      break;
    }
  }

  const final = await getMatchResults(token, { competencyMatrixId: comp.id });
  console.log('---');
  console.log('Final result count:', Array.isArray(final.data) ? final.data.length : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
