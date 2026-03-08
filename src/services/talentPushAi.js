'use strict';

const { GoogleGenAI } = require('@google/genai');
const { pool } = require('../db/pool');
const { getLearnersForTalentPush } = require('./fetchLearnersDirect');

const GEMINI_MODEL = process.env.GEMINI_JD_MODEL || 'gemini-2.5-flash';
const EXTERNAL_LEARNERS_API_URL = (process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io').replace(/\/$/, '');
const BATCH_SIZE = 15;
const MIN_SCORE = 30;
const TOP_N = 30; // Only store and return top N students for Talent Push
// Testing: use a random sample of 20 students so refresh stays fast; increase later for production
const SAMPLE_SIZE = 20;

const TALENT_PUSH_SYSTEM = `You are an HR analyst. Given a company profile (preferred roles, skill domains, hiring intent) and a list of student/learner summaries, score how well each student fits the company's hiring needs from 0 to 100.
Consider: alignment of career aspirations and interests with company roles, skill domain overlap, education and specialisation relevance.
Output valid JSON only: { "scores": [ number, number, ... ] } with one score per student in the exact same order as the students list. Use only integers 0-100.`;

function rowToProfile(row) {
  if (!row) return null;
  return {
    companyName: row.company_name,
    preferredRoles: row.preferred_roles || [],
    preferredSkillDomains: row.preferred_skill_domains || [],
    briefDescription: row.brief_description || '',
    hiringIntent: row.hiring_intent || 'Both',
    internshipAvailability: row.internship_availability,
  };
}

function studentSummary(student) {
  const o = student?.attributes || student || {};
  const parts = [];
  if (o.name) parts.push(`Name: ${o.name}`);
  if (o.education_level) parts.push(`Education: ${o.education_level}`);
  if (o.specialisation) parts.push(`Specialisation: ${o.specialisation}`);
  const college = o.master_college?.name ?? o.university?.name;
  if (college) parts.push(`College: ${college}`);
  const branch = o.branch?.name;
  if (branch) parts.push(`Branch: ${branch}`);
  const aspiration = o.career_aspiration?.title ?? o.career_aspiration?.data?.attributes?.title;
  if (aspiration) parts.push(`Career aspiration: ${aspiration}`);
  const interests = o.career_interests?.interests ?? o.career_interests?.data?.attributes?.interests;
  if (Array.isArray(interests)) {
    const list = interests.map((i) => i?.career_interest ?? i?.data?.attributes?.career_interest).filter(Boolean).join(', ');
    if (list) parts.push(`Interests: ${list}`);
  }
  return parts.join(' | ') || 'No details';
}

async function ensureTalentPushCacheTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS talent_push_cache (
      user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      results JSONB DEFAULT '[]',
      computed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getCompanyProfileByUserId(userId) {
  const r = await pool.query(
    'SELECT company_name, preferred_roles, preferred_skill_domains, brief_description, hiring_intent, internship_availability FROM industry_profiles WHERE user_id = $1',
    [userId]
  );
  return rowToProfile(r.rows[0]);
}

function parseGeminiJson(text) {
  const stripped = (text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (_) {
    return { scores: [] };
  }
}

async function scoreBatchWithGemini(ai, companyProfile, studentsBatch) {
  if (studentsBatch.length === 0) return [];
  const companyStr = [
    `Preferred roles: ${(companyProfile.preferredRoles || []).join(', ') || 'Not specified'}`,
    `Preferred skill domains: ${(companyProfile.preferredSkillDomains || []).join(', ') || 'Not specified'}`,
    `Hiring intent: ${companyProfile.hiringIntent || 'Both'}`,
    companyProfile.briefDescription ? `About company: ${companyProfile.briefDescription}` : '',
  ].filter(Boolean).join('\n');

  const studentsStr = studentsBatch.map((s, i) => `[${i}] ${studentSummary(s)}`).join('\n');
  const prompt = `Company profile:\n${companyStr}\n\nStudents (score each 0-100 fit):\n${studentsStr}\n\nReturn JSON only: { "scores": [ ... ] } one integer per student in order.`;

  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { systemInstruction: TALENT_PUSH_SYSTEM, responseMimeType: 'application/json' },
    });
    const text = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseGeminiJson(text);
    const scores = Array.isArray(parsed.scores) ? parsed.scores : [];
    return studentsBatch.map((s, i) => ({ student: s, score: typeof scores[i] === 'number' ? Math.min(100, Math.max(0, Math.round(scores[i]))) : 50 }));
  } catch (err) {
    console.warn('[talentPushAi] Gemini batch score error:', err?.message);
    return studentsBatch.map((s) => ({ student: s, score: 50 }));
  }
}

async function computeAndSave(userId) {
  await ensureTalentPushCacheTable();
  const profile = await getCompanyProfileByUserId(userId);
  if (!profile) {
    throw new Error('Company profile not found. Complete your Company Profile first.');
  }
  const learners = await getLearnersForTalentPush(SAMPLE_SIZE);
  if (learners.length === 0) {
    await pool.query(
      'INSERT INTO talent_push_cache (user_id, results, computed_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET results = $2, computed_at = NOW()',
      [userId, JSON.stringify([])]
    );
    return { students: [], computedAt: new Date().toISOString() };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[talentPushAi] GEMINI_API_KEY not set; returning learners with default score.');
    const withScore = learners.map((s) => ({ student: s, score: 50 }));
    const sorted = withScore.sort((a, b) => b.score - a.score);
    const results = sorted.filter((r) => r.score >= MIN_SCORE).map((r) => ({ ...r.student, fitScore: r.score })).slice(0, TOP_N);
    await pool.query(
      'INSERT INTO talent_push_cache (user_id, results, computed_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET results = $2, computed_at = NOW()',
      [userId, JSON.stringify(results)]
    );
    return { students: results, computedAt: new Date().toISOString() };
  }

  const ai = new GoogleGenAI({ apiKey });
  const allScored = [];
  for (let i = 0; i < learners.length; i += BATCH_SIZE) {
    const batch = learners.slice(i, i + BATCH_SIZE);
    const scored = await scoreBatchWithGemini(ai, profile, batch);
    allScored.push(...scored);
  }
  const sorted = allScored.sort((a, b) => b.score - a.score);
  const filtered = sorted.filter((r) => r.score >= MIN_SCORE);
  const results = filtered.map((r) => ({ ...r.student, fitScore: r.score })).slice(0, TOP_N);

  await pool.query(
    'INSERT INTO talent_push_cache (user_id, results, computed_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET results = $2, computed_at = NOW()',
    [userId, JSON.stringify(results)]
  );
  return { students: results, computedAt: new Date().toISOString() };
}

async function getCached(userId) {
  await ensureTalentPushCacheTable();
  const r = await pool.query('SELECT results, computed_at FROM talent_push_cache WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  if (!row) return { students: [], computedAt: null };
  const results = Array.isArray(row.results) ? row.results : (typeof row.results === 'string' ? JSON.parse(row.results || '[]') : []);
  return { students: results, computedAt: row.computed_at ? new Date(row.computed_at).toISOString() : null };
}

module.exports = {
  computeAndSave,
  getCached,
  ensureTalentPushCacheTable,
};
