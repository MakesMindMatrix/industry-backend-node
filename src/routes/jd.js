'use strict';

const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');
const { authMiddleware, optionalAuthMiddleware } = require('../middleware/auth');
const { pool } = require('../db/pool');
const {
  JD_SUGGESTIONS,
  CACHE_SYSTEM_INSTRUCTION,
  parseGeminiJson,
  ensureJdCacheTable,
  embedText,
  findSimilarJd,
  saveJdToCache,
  getAddonSuggestions,
  generateCompetencyFromJd,
  generateStudentCompetencyFromProfile,
  computeMatchScore,
  shuffleArray,
} = require('../services/jdAi');
const { loadDocumentIdsFromCsv } = require('../services/studentCsv');

const TOP_MATCHES_COUNT = 10;

/** Prefer document_id from student_ids table (admin-loaded CSV), else temp/student.csv. */
async function getDocumentIdsForMatch() {
  try {
    const r = await pool.query(
      `SELECT document_id FROM student_ids WHERE document_id IS NOT NULL AND document_id != '' ORDER BY id DESC LIMIT 20`
    );
    if (r.rows.length > 0) return r.rows.map((row) => row.document_id).filter(Boolean);
  } catch (_) {}
  return loadDocumentIdsFromCsv();
}
const MIN_MATCH_SCORE = 80;
const EXTERNAL_LEARNERS_BASE = () => process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io';

// Display match % so it's always above 70: 50–60 add 20, below 50 add 40; floor 70, cap 95
function displayMatchPercent(score) {
  if (typeof score !== 'number') return null;
  const add = score >= 50 ? 20 : 40;
  const displayed = Math.round(score + add);
  return Math.min(95, Math.max(70, displayed));
}

// Normalize learner from external API (Strapi v4 may use attributes or nested relation objects)
function normalizeLearnerFromApi(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const attrs = raw.attributes || raw;
  const pickRelation = (r) => {
    if (!r) return r;
    if (r?.data?.attributes) return { name: r.data.attributes.name, id: r.data.id };
    if (typeof r?.name === 'string' || typeof r?.id !== 'undefined') return r;
    return r;
  };
  return {
    id: raw.id ?? attrs.id,
    documentId: raw.documentId ?? attrs.documentId,
    name: raw.name ?? attrs.name,
    user_category: raw.user_category ?? attrs.user_category,
    education_level: raw.education_level ?? attrs.education_level,
    specialisation: raw.specialisation ?? attrs.specialisation,
    master_college: pickRelation(raw.master_college ?? attrs.master_college),
    university: pickRelation(raw.university ?? attrs.university),
    branch: pickRelation(raw.branch ?? attrs.branch),
    career_aspiration: pickRelation(raw.career_aspiration ?? attrs.career_aspiration),
    career_interests: raw.career_interests ?? attrs.career_interests,
    user: raw.user ?? attrs.user,
  };
}

function buildLearnerSnapshot(student) {
  return {
    id: student.id,
    documentId: student.documentId,
    name: student.name,
    user_category: student.user_category,
    education_level: student.education_level,
    specialisation: student.specialisation,
    master_college: student.master_college,
    university: student.university,
    branch: student.branch,
    career_aspiration: student.career_aspiration,
    career_interests: student.career_interests,
    user: student.user,
  };
}

async function resolveCompetencyMatrixId(req, body) {
  let competencyMatrixId = body.competencyMatrixId != null ? parseInt(body.competencyMatrixId, 10) : null;
  const jdId = body.jdId != null ? parseInt(body.jdId, 10) : null;
  if (!competencyMatrixId && jdId && req.user) {
    const cmRes = await pool.query(
      'SELECT c.id FROM competency_matrices c JOIN job_descriptions j ON j.id = c.job_description_id WHERE c.job_description_id = $1 AND (j.created_by IS NULL OR j.created_by = $2)',
      [jdId, req.user.id]
    );
    if (cmRes.rows[0]) competencyMatrixId = cmRes.rows[0].id;
  }
  return competencyMatrixId;
}

async function ensureMatrixOwnership(userId, competencyMatrixId) {
  const check = await pool.query(
    'SELECT c.id FROM competency_matrices c JOIN job_descriptions j ON j.id = c.job_description_id WHERE c.id = $1 AND (j.created_by IS NULL OR j.created_by = $2)',
    [competencyMatrixId, userId]
  );
  return !!check.rows[0];
}

// GET /api/jd/suggestions
router.get('/suggestions', (req, res) => {
  res.json(JD_SUGGESTIONS);
});

// POST /api/jd/generate
router.post('/generate', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return res.status(503).json({
      error: 'Gemini API key not configured',
      code: 'GEMINI_API_KEY_MISSING',
      message: 'Add GEMINI_API_KEY to the server .env to enable AI JD Builder.',
    });
  }
  const { prompt, answers = [], useCache = true } = req.body || {};
  const fullPrompt = [prompt, ...answers].filter(Boolean).join('\n\n');
  if (!fullPrompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  let ragAvailable = false;
  try {
    await ensureJdCacheTable();
    ragAvailable = true;
  } catch (e) {
    console.warn('jd_cache init skipped', e?.message);
  }

  const ai = new GoogleGenAI({ apiKey });

  if (useCache && ragAvailable) {
    try {
      const embedding = await embedText(ai, fullPrompt);
      const similar = await findSimilarJd(embedding);
      if (similar) {
        return res.json({
          jd: similar.content,
          title: similar.title,
          usedCachedContext: true,
          cachedJdId: similar.id,
          questions: [],
        });
      }
    } catch (err) {
      console.warn('RAG similarity search failed', err?.message);
    }
  }

  let cachedContentName = null;
  try {
    const cache = await ai.caches.create({
      model: process.env.GEMINI_JD_MODEL || 'gemini-2.5-flash',
      config: {
        contents: [{ role: 'user', parts: [{ text: 'JD creation context.' }] }],
        systemInstruction: CACHE_SYSTEM_INSTRUCTION,
        displayName: 'jd-builder-context',
        ttl: '3600s',
      },
    });
    cachedContentName = cache.name;
  } catch (_) {}

  const config = cachedContentName ? { cachedContent: cachedContentName } : { systemInstruction: CACHE_SYSTEM_INSTRUCTION };
  const followupRule =
    answers.length > 0
      ? 'You have already asked follow-up questions earlier. Now DO NOT ask any more questions. Use the information you have to write the full job description.'
      : 'You may ask at most one round of follow-up questions (1-3 short questions) if absolutely necessary. After the user answers once, do not ask any more follow-up questions; instead, write the full job description.';
  const userContent = `The user wants to create a job description. Here is their input:\n\n${fullPrompt}\n\nFollow-up behaviour:\n${followupRule}\n\nRespond with JSON only. If you need more details, include a "questions" array (1-3 questions). Otherwise include "jd" (full JD text) and optionally "title".`;

  let result;
  try {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_JD_MODEL || 'gemini-2.5-flash',
      contents: userContent,
      config,
    });
    const text = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    result = parseGeminiJson(text);
  } catch (err) {
    return res.status(502).json({
      error: 'Gemini API error',
      message: err.message || 'Failed to generate JD',
    });
  }

  const jdText = result.jd || '';
  const questions = Array.isArray(result.questions) ? result.questions : [];
  const title = result.title || null;

  if (jdText && useCache && ragAvailable) {
    try {
      const embedding = await embedText(ai, (title || '') + '\n' + jdText.slice(0, 8000));
      await saveJdToCache(title, jdText, fullPrompt.slice(0, 500), embedding);
    } catch (_) {}
  }

  const addonSuggestions = jdText ? await getAddonSuggestions(ai, title, jdText) : [];

  return res.json({
    jd: jdText,
    title,
    questions,
    addonSuggestions,
    usedCachedContext: false,
  });
});

// POST /api/jd/generate-stream
router.post('/generate-stream', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return res.status(503).json({ error: 'Gemini API key not configured', code: 'GEMINI_API_KEY_MISSING' });
  }
  const { prompt, answers = [], useCache = true } = req.body || {};
  const fullPrompt = [prompt, ...answers].filter(Boolean).join('\n\n');
  if (!fullPrompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  let ragAvailable = false;
  try {
    await ensureJdCacheTable();
    ragAvailable = true;
  } catch (e) {
    console.warn('jd_cache init skipped', e?.message);
  }

  const ai = new GoogleGenAI({ apiKey });

  if (useCache && ragAvailable) {
    try {
      const embedding = await embedText(ai, fullPrompt);
      const similar = await findSimilarJd(embedding);
      if (similar) {
        const addonSuggestions = await getAddonSuggestions(ai, similar.title, similar.content);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ type: 'done', jd: similar.content, title: similar.title, questions: [], addonSuggestions })}\n\n`);
        return res.end();
      }
    } catch (err) {
      console.warn('RAG similarity search failed', err?.message);
    }
  }

  let cachedContentName = null;
  try {
    const cache = await ai.caches.create({
      model: process.env.GEMINI_JD_MODEL || 'gemini-2.5-flash',
      config: {
        contents: [{ role: 'user', parts: [{ text: 'JD creation context.' }] }],
        systemInstruction: CACHE_SYSTEM_INSTRUCTION,
        displayName: 'jd-builder-context',
        ttl: '3600s',
      },
    });
    cachedContentName = cache.name;
  } catch (_) {}

  const config = cachedContentName ? { cachedContent: cachedContentName } : { systemInstruction: CACHE_SYSTEM_INSTRUCTION };
  const followupRule =
    answers.length > 0
      ? 'You have already asked follow-up questions earlier. Now DO NOT ask any more questions. Use the information you have to write the full job description.'
      : 'You may ask at most one round of follow-up questions (1-3 short questions) if absolutely necessary. After the user answers once, do not ask any more follow-up questions; instead, write the full job description.';
  const userContent = `The user wants to create a job description. Here is their input:\n\n${fullPrompt}\n\nFollow-up behaviour:\n${followupRule}\n\nRespond with JSON only. If you need more details, include a "questions" array (1-3 questions). Otherwise include "jd" (full JD text) and optionally "title".`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  (async () => {
    try {
      const streamResult = await ai.models.generateContentStream({
        model: process.env.GEMINI_JD_MODEL || 'gemini-2.5-flash',
        contents: userContent,
        config,
      });
      let fullText = '';
      const iterable = streamResult.stream || streamResult;
      for await (const chunk of iterable) {
        const text = chunk.text ?? chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (text) {
          fullText += text;
          res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
        }
      }
      const result = parseGeminiJson(fullText);
      const jdText = result.jd || '';
      const questions = Array.isArray(result.questions) ? result.questions : [];
      const title = result.title || null;

      if (jdText && useCache && ragAvailable) {
        try {
          const embedding = await embedText(ai, (title || '') + '\n' + jdText.slice(0, 8000));
          await saveJdToCache(title, jdText, fullPrompt.slice(0, 500), embedding);
        } catch (_) {}
      }
      let addonSuggestions = [];
      try {
        addonSuggestions = jdText ? await getAddonSuggestions(ai, title, jdText) : [];
      } catch (_) {}
      res.write(`data: ${JSON.stringify({ type: 'done', jd: jdText, title, questions, addonSuggestions })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Failed to generate' })}\n\n`);
    } finally {
      res.end();
    }
  })();
});

// POST /api/jd/competency-from-jd
router.post('/competency-from-jd', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return res.status(503).json({ error: 'Gemini API key not configured', code: 'GEMINI_API_KEY_MISSING' });
  }
  const { title, jd } = req.body || {};
  if (!jd || typeof jd !== 'string' || jd.trim().length < 50) {
    return res.status(400).json({ error: 'Valid job description (jd) is required' });
  }
  try {
    const ai = new GoogleGenAI({ apiKey });
    const result = await generateCompetencyFromJd(ai, title || '', jd.trim());
    return res.json(result);
  } catch (err) {
    console.error('competency-from-jd', err?.message || err);
    return res.status(502).json({ error: 'Failed to generate competency', message: err?.message || 'AI error' });
  }
});

// POST /api/jd/match-learners
// Optional: body.competencyMatrixId or body.jdId to save results (requires auth). body.competencies for AI matching.
// Temp: if temp/student.csv exists, loads up to 20 documentIds and fetches learners by documentId (populate=*); returns top 10 matches.
router.post('/match-learners', optionalAuthMiddleware, async (req, res) => {
  const body = req.body || {};
  const competencies = body.competencies;
  const jobSkillGroups = Array.isArray(competencies)
    ? competencies.map((c) => ({
        category: c.category || 'Category',
        skills: Array.isArray(c.skills) ? c.skills : [],
        weight: typeof c.weight === 'number' ? c.weight : 20,
      }))
    : [];
  const useAiMatching = jobSkillGroups.length > 0 && !!process.env.GEMINI_API_KEY?.trim();
  const baseUrl = EXTERNAL_LEARNERS_BASE();

  let list = [];
  const csvDocumentIds = await getDocumentIdsForMatch();

  if (useAiMatching && csvDocumentIds.length > 0) {
    // Temp: fetch learners by documentId (one request per id), then AI match and return top 10
    for (const docId of csvDocumentIds) {
      try {
        const url = `${baseUrl}/api/learners?filters[documentId][$eq]=${encodeURIComponent(docId)}&populate=*`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(data.data) && data.data.length > 0) {
          list.push(data.data[0]);
        }
      } catch (err) {
        console.warn('match-learners fetch by documentId failed', docId, err?.message);
      }
    }
  }

  if (!useAiMatching) {
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(body.pageSize, 10) || 50));
    const qs = `populate=*&pagination[page]=${page}&pagination[pageSize]=${pageSize}`;
    const url = `${baseUrl}/api/learners?${qs}`;
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return res.status(response.status).json(data);
      list = Array.isArray(data.data) ? data.data : [];
      return res.json({
        data: list,
        meta: { pagination: { total: data.meta?.pagination?.total ?? list.length, page, pageSize, pageCount: data.meta?.pagination?.pageCount ?? 1 } },
        suggestedFilters: { branchNames: [], careerAspirationTitles: [], specialisations: [], careerInterests: [] },
      });
    } catch (err) {
      return res.status(502).json({ error: 'Failed to fetch learners', message: err?.message || 'External API unreachable' });
    }
  }

  if (list.length === 0 && csvDocumentIds.length === 0) {
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(50, 100));
    const url = `${baseUrl}/api/learners?populate=*&pagination[page]=${page}&pagination[pageSize]=${pageSize}`;
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(data.data)) list = shuffleArray(data.data).slice(0, 20);
    } catch (_) {}
  }

  if (list.length === 0) {
    return res.json({
      data: [],
      meta: { pagination: { total: 0, page: 1, pageSize: 0, pageCount: 0 } },
      suggestedFilters: { branchNames: [], careerAspirationTitles: [], specialisations: [], careerInterests: [] },
    });
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const results = [];
  for (const student of list) {
    try {
      const { skillGroups: studentSkillGroups } = await generateStudentCompetencyFromProfile(ai, student, jobSkillGroups);
      const matchScore = computeMatchScore(jobSkillGroups, studentSkillGroups);
      const docId = student.documentId != null ? String(student.documentId) : (student.id != null ? String(student.id) : null);
      results.push({
        ...student,
        studentCompetencyMatrix: studentSkillGroups,
        matchScore,
        documentId: docId,
      });
    } catch (err) {
      console.warn('match-learners student competency failed', student?.id, err?.message);
      results.push({
        ...student,
        studentCompetencyMatrix: [],
        matchScore: 0,
        documentId: (student.documentId != null ? String(student.documentId) : (student.id != null ? String(student.id) : null)),
      });
    }
  }
  results.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  const onlyAboveMin = results.filter((r) => (r.matchScore ?? 0) >= MIN_MATCH_SCORE);
  const topResults = onlyAboveMin.slice(0, TOP_MATCHES_COUNT);

  // Save to DB: attach to JD via competency_matrix (when auth + competencyMatrixId or jdId)
  const competencyMatrixId = await resolveCompetencyMatrixId(req, body);
  if (req.user && competencyMatrixId && (await ensureMatrixOwnership(req.user.id, competencyMatrixId))) {
    try {
      await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS learner_snapshot JSONB DEFAULT '{}'`);
    } catch (_) {}
    for (const r of topResults) {
      const studentDocId = r.documentId ?? (r.id != null ? String(r.id) : null);
      if (!studentDocId) continue;
      const compJson = JSON.stringify(Array.isArray(r.studentCompetencyMatrix) ? r.studentCompetencyMatrix : []);
      const snapshot = JSON.stringify(buildLearnerSnapshot(r));
      await pool.query(
        `INSERT INTO competency_matrix_student_results (competency_matrix_id, student_document_id, match_score, student_competency_json, learner_snapshot)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (competency_matrix_id, student_document_id) DO UPDATE SET match_score = EXCLUDED.match_score, student_competency_json = EXCLUDED.student_competency_json, learner_snapshot = EXCLUDED.learner_snapshot`,
        [competencyMatrixId, studentDocId, r.matchScore ?? 0, compJson, snapshot]
      );
    }
  }

  const withDisplayScore = topResults.map((r) => ({
    ...r,
    matchScore: displayMatchPercent(r.matchScore) ?? r.matchScore,
  }));

  return res.json({
    data: withDisplayScore,
    meta: { pagination: { total: withDisplayScore.length, page: 1, pageSize: withDisplayScore.length, pageCount: 1 } },
    suggestedFilters: { branchNames: [], careerAspirationTitles: [], specialisations: [], careerInterests: [] },
  });
});

// POST /api/jd/match-learners-stream — SSE stream: one student per event, save each to JD immediately (auth required). Only match >= 80%.
router.post('/match-learners-stream', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const competencies = body.competencies;
  const jobSkillGroups = Array.isArray(competencies)
    ? competencies.map((c) => ({
        category: c.category || 'Category',
        skills: Array.isArray(c.skills) ? c.skills : [],
        weight: typeof c.weight === 'number' ? c.weight : 20,
      }))
    : [];
  const competencyMatrixId = await resolveCompetencyMatrixId(req, body);
  if (!req.user || !competencyMatrixId || !(await ensureMatrixOwnership(req.user.id, competencyMatrixId))) {
    return res.status(400).json({ error: 'Auth and competencyMatrixId or jdId required' });
  }
  if (jobSkillGroups.length === 0 || !process.env.GEMINI_API_KEY?.trim()) {
    return res.status(400).json({ error: 'competencies and GEMINI_API_KEY required' });
  }

  const baseUrl = EXTERNAL_LEARNERS_BASE();
  const csvDocumentIds = await getDocumentIdsForMatch();
  let list = [];
  if (csvDocumentIds.length > 0) {
    for (const docId of csvDocumentIds) {
      try {
        const url = `${baseUrl}/api/learners?filters[documentId][$eq]=${encodeURIComponent(docId)}&populate=*`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(data.data) && data.data.length > 0) list.push(data.data[0]);
      } catch (err) {
        console.warn('match-learners-stream fetch failed', docId, err?.message);
      }
    }
  }
  if (list.length === 0) {
    try {
      const url = `${baseUrl}/api/learners?populate=*&pagination[page]=1&pagination[pageSize]=50`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(data.data)) list = shuffleArray(data.data).slice(0, 20);
    } catch (_) {}
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (res.flush) res.flush();
  };

  (async () => {
    try {
      await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS learner_snapshot JSONB DEFAULT '{}'`).catch(() => {});
      for (const student of list) {
        try {
          const { skillGroups: studentSkillGroups } = await generateStudentCompetencyFromProfile(ai, student, jobSkillGroups);
          const matchScore = computeMatchScore(jobSkillGroups, studentSkillGroups);
          if (matchScore < MIN_MATCH_SCORE) continue;
          const docId = student.documentId != null ? String(student.documentId) : (student.id != null ? String(student.id) : null);
          if (!docId) continue;
          const payload = {
            ...student,
            documentId: docId,
            studentCompetencyMatrix: studentSkillGroups,
            matchScore: displayMatchPercent(matchScore) ?? matchScore,
          };
          const compJson = JSON.stringify(studentSkillGroups);
          const snapshot = JSON.stringify(buildLearnerSnapshot({ ...student, documentId: docId }));
          await pool.query(
            `INSERT INTO competency_matrix_student_results (competency_matrix_id, student_document_id, match_score, student_competency_json, learner_snapshot)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
             ON CONFLICT (competency_matrix_id, student_document_id) DO UPDATE SET match_score = EXCLUDED.match_score, student_competency_json = EXCLUDED.student_competency_json, learner_snapshot = EXCLUDED.learner_snapshot`,
            [competencyMatrixId, docId, matchScore, compJson, snapshot]
          );
          send({ type: 'student', student: payload });
        } catch (err) {
          console.warn('match-learners-stream one failed', student?.id, err?.message);
        }
      }
      send({ type: 'done' });
    } catch (err) {
      send({ type: 'error', message: err?.message || 'Stream failed' });
    } finally {
      res.end();
    }
  })();
});

// GET /api/jd/match-results?competencyMatrixId= or ?jdId= — load saved AI match results for JD (auth required)
router.get('/match-results', authMiddleware, async (req, res) => {
  const competencyMatrixId = parseInt(req.query.competencyMatrixId, 10);
  const jdId = parseInt(req.query.jdId, 10);
  let matrixId = Number.isNaN(competencyMatrixId) ? null : competencyMatrixId;
  if (!matrixId && !Number.isNaN(jdId)) {
    const cmRes = await pool.query(
      'SELECT c.id FROM competency_matrices c JOIN job_descriptions j ON j.id = c.job_description_id WHERE c.job_description_id = $1 AND (j.created_by IS NULL OR j.created_by = $2)',
      [jdId, req.user.id]
    );
    if (cmRes.rows[0]) matrixId = cmRes.rows[0].id;
  }
  if (!matrixId) return res.status(400).json({ error: 'competencyMatrixId or jdId required' });
  const allowed = await ensureMatrixOwnership(req.user.id, matrixId);
  if (!allowed) return res.status(404).json({ error: 'Not found' });
  try {
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS learner_snapshot JSONB DEFAULT '{}'`);
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_date DATE`);
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_time VARCHAR(50)`);
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_location VARCHAR(500)`);
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_type VARCHAR(50)`);
  } catch (_) {}
  const r = await pool.query(
    `SELECT student_document_id, match_score, student_competency_json, learner_snapshot, shortlisted, schedule_requested,
      interview_date, interview_time, interview_location, interview_type
     FROM competency_matrix_student_results WHERE competency_matrix_id = $1 ORDER BY match_score DESC`,
    [matrixId]
  );
  const data = [];
  for (const row of r.rows) {
    const snapshot = row.learner_snapshot && typeof row.learner_snapshot === 'object' ? row.learner_snapshot : {};
    const displayScore = displayMatchPercent(row.match_score);
    let item = {
      ...snapshot,
      documentId: row.student_document_id,
      id: snapshot.id || row.student_document_id,
      matchScore: displayScore != null ? displayScore : row.match_score,
      studentCompetencyMatrix: row.student_competency_json || [],
      shortlisted: row.shortlisted,
      schedule_requested: row.schedule_requested,
      interview_date: row.interview_date,
      interview_time: row.interview_time,
      interview_location: row.interview_location,
      interview_type: row.interview_type,
    };
    if (!item.name && row.student_document_id) {
      const meta = await fetchLearnerByDocumentId(row.student_document_id);
      if (meta) item = { ...meta, ...item };
    }
    data.push(item);
  }
  return res.json({ data });
});

// POST /api/jd/match-results/shortlist — set shortlisted for given matrix + students (auth required)
router.post('/match-results/shortlist', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const competencyMatrixId = parseInt(body.competencyMatrixId, 10);
  const studentDocumentIds = Array.isArray(body.studentDocumentIds) ? body.studentDocumentIds.map((id) => String(id).trim()).filter(Boolean) : [];
  if (Number.isNaN(competencyMatrixId) || studentDocumentIds.length === 0) {
    return res.status(400).json({ error: 'competencyMatrixId and studentDocumentIds[] required' });
  }
  const check = await pool.query(
    'SELECT c.id FROM competency_matrices c JOIN job_descriptions j ON j.id = c.job_description_id WHERE c.id = $1 AND (j.created_by IS NULL OR j.created_by = $2)',
    [competencyMatrixId, req.user.id]
  );
  if (!check.rows[0]) return res.status(404).json({ error: 'Competency matrix not found' });
  await pool.query(
    `UPDATE competency_matrix_student_results SET shortlisted = true, shortlisted_at = NOW() WHERE competency_matrix_id = $1 AND student_document_id = ANY($2::text[])`,
    [competencyMatrixId, studentDocumentIds]
  );
  return res.json({ ok: true, shortlisted: studentDocumentIds.length });
});

// POST /api/jd/match-results/schedule — set schedule_requested + interview details (auth required)
router.post('/match-results/schedule', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const competencyMatrixId = parseInt(body.competencyMatrixId, 10);
  const studentDocumentIds = Array.isArray(body.studentDocumentIds) ? body.studentDocumentIds.map((id) => String(id).trim()).filter(Boolean) : [];
  if (Number.isNaN(competencyMatrixId) || studentDocumentIds.length === 0) {
    return res.status(400).json({ error: 'competencyMatrixId and studentDocumentIds[] required' });
  }
  const check = await pool.query(
    'SELECT c.id FROM competency_matrices c JOIN job_descriptions j ON j.id = c.job_description_id WHERE c.id = $1 AND (j.created_by IS NULL OR j.created_by = $2)',
    [competencyMatrixId, req.user.id]
  );
  if (!check.rows[0]) return res.status(404).json({ error: 'Competency matrix not found' });
  const interviewDate = body.interviewDate && String(body.interviewDate).trim() ? String(body.interviewDate).trim() : null;
  const interviewTime = body.interviewTime && String(body.interviewTime).trim() ? String(body.interviewTime).trim() : null;
  const interviewLocation = body.interviewLocation && String(body.interviewLocation).trim() ? String(body.interviewLocation).trim() : null;
  const interviewType = body.interviewType && ['virtual', 'in-person', 'online'].includes(String(body.interviewType).toLowerCase()) ? String(body.interviewType).toLowerCase() : null;
  await pool.query(
    `UPDATE competency_matrix_student_results SET schedule_requested = true, schedule_requested_at = NOW(),
      interview_date = $3, interview_time = $4, interview_location = $5, interview_type = $6
      WHERE competency_matrix_id = $1 AND student_document_id = ANY($2::text[])`,
    [competencyMatrixId, studentDocumentIds, interviewDate, interviewTime, interviewLocation, interviewType]
  );
  return res.json({ ok: true, scheduled: studentDocumentIds.length });
});

// Fetch learner metadata by documentId from external API (for Active Hiring when snapshot is missing)
async function fetchLearnerByDocumentId(documentId) {
  if (!documentId || typeof documentId !== 'string') return null;
  const baseUrl = EXTERNAL_LEARNERS_BASE();
  try {
    const url = `${baseUrl}/api/learners?filters[documentId][$eq]=${encodeURIComponent(documentId)}&populate=*`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(data.data) && data.data.length > 0) {
      const normalized = normalizeLearnerFromApi(data.data[0]);
      return {
        name: normalized.name,
        id: normalized.id,
        documentId: normalized.documentId,
        user: normalized.user ? { email: normalized.user.email, username: normalized.user.username } : null,
        education_level: normalized.education_level,
        specialisation: normalized.specialisation,
        user_category: normalized.user_category,
        master_college: normalized.master_college,
        university: normalized.university,
        branch: normalized.branch,
        career_aspiration: normalized.career_aspiration,
        career_interests: normalized.career_interests,
      };
    }
  } catch (err) {
    console.warn('fetchLearnerByDocumentId failed', documentId, err?.message);
  }
  return null;
}

// GET /api/jd/active-hiring — JDs with shortlisted and scheduled students (auth required); enriches with learner metadata when snapshot missing
router.get('/active-hiring', authMiddleware, async (req, res) => {
  try {
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_date DATE`).catch(() => {});
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_time VARCHAR(50)`).catch(() => {});
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_location VARCHAR(500)`).catch(() => {});
    await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_type VARCHAR(50)`).catch(() => {});
  } catch (_) {}
  const jds = await pool.query(
    `SELECT j.id AS jd_id, j.title AS jd_title
     FROM job_descriptions j
     WHERE (j.created_by IS NULL OR j.created_by = $1)
       AND EXISTS (SELECT 1 FROM competency_matrices c WHERE c.job_description_id = j.id)
     ORDER BY j.updated_at DESC`,
    [req.user.id]
  );
  const jdList = [];
  for (const jd of jds.rows) {
    const r = await pool.query(
      `SELECT r.student_document_id, r.match_score, r.learner_snapshot, r.shortlisted, r.shortlisted_at,
        r.schedule_requested, r.schedule_requested_at, r.interview_date, r.interview_time, r.interview_location, r.interview_type
       FROM competency_matrix_student_results r
       JOIN competency_matrices c ON c.id = r.competency_matrix_id
       WHERE c.job_description_id = $1 AND (r.shortlisted = true OR r.schedule_requested = true)
       ORDER BY r.schedule_requested_at DESC NULLS LAST, r.shortlisted_at DESC NULLS LAST`,
      [jd.jd_id]
    );
    const shortlisted = [];
    const scheduled = [];
    for (const row of r.rows) {
      const snapshot = row.learner_snapshot && typeof row.learner_snapshot === 'object' ? row.learner_snapshot : {};
      let item = { ...snapshot, documentId: row.student_document_id, matchScore: row.match_score, shortlisted: row.shortlisted, schedule_requested: row.schedule_requested, interview_date: row.interview_date, interview_time: row.interview_time, interview_location: row.interview_location, interview_type: row.interview_type };
      if (!item.name && row.student_document_id) {
        const meta = await fetchLearnerByDocumentId(row.student_document_id);
        if (meta) item = { ...meta, ...item };
      }
      if (row.shortlisted) shortlisted.push(item);
      if (row.schedule_requested) scheduled.push(item);
    }
    jdList.push({ jdId: jd.jd_id, jdTitle: jd.jd_title, shortlisted, scheduled });
  }
  return res.json({ data: jdList });
});

// POST /api/jd/match-learners-background — start AI match in background, save to JD; returns immediately (auth required)
router.post('/match-learners-background', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const competencies = body.competencies;
  const jobSkillGroups = Array.isArray(competencies)
    ? competencies.map((c) => ({
        category: c.category || 'Category',
        skills: Array.isArray(c.skills) ? c.skills : [],
        weight: typeof c.weight === 'number' ? c.weight : 20,
      }))
    : [];
  const competencyMatrixId = await resolveCompetencyMatrixId(req, body);
  if (!competencyMatrixId || !(await ensureMatrixOwnership(req.user.id, competencyMatrixId))) {
    return res.status(400).json({ error: 'competencyMatrixId or jdId required' });
  }
  if (jobSkillGroups.length === 0 || !process.env.GEMINI_API_KEY?.trim()) {
    return res.status(400).json({ error: 'competencies and GEMINI_API_KEY required' });
  }
  const baseUrl = EXTERNAL_LEARNERS_BASE();
  const csvDocumentIds = await getDocumentIdsForMatch();
  let list = [];
  if (csvDocumentIds.length > 0) {
    for (const docId of csvDocumentIds) {
      try {
        const url = `${baseUrl}/api/learners?filters[documentId][$eq]=${encodeURIComponent(docId)}&populate=*`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(data.data) && data.data.length > 0) {
          list.push(normalizeLearnerFromApi(data.data[0]));
        }
      } catch (err) {
        console.warn('match-learners-background fetch failed', docId, err?.message);
      }
    }
  }
  if (list.length === 0) {
    try {
      const url = `${baseUrl}/api/learners?populate=*&pagination[page]=1&pagination[pageSize]=50`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(data.data)) {
        list = shuffleArray(data.data).slice(0, 20).map(normalizeLearnerFromApi);
      }
    } catch (_) {}
  }
  const matrixId = competencyMatrixId;
  setImmediate(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    try {
      await pool.query(`ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS learner_snapshot JSONB DEFAULT '{}'`).catch(() => {});
      for (const student of list) {
        try {
          const { skillGroups: studentSkillGroups } = await generateStudentCompetencyFromProfile(ai, student, jobSkillGroups);
          const matchScore = computeMatchScore(jobSkillGroups, studentSkillGroups);
          if (matchScore < MIN_MATCH_SCORE) continue;
          const docId = student.documentId != null ? String(student.documentId) : (student.id != null ? String(student.id) : null);
          if (!docId) continue;
          const compJson = JSON.stringify(studentSkillGroups);
          const forSnapshot = normalizeLearnerFromApi({ ...student, documentId: docId });
          const snapshot = JSON.stringify(buildLearnerSnapshot(forSnapshot));
          await pool.query(
            `INSERT INTO competency_matrix_student_results (competency_matrix_id, student_document_id, match_score, student_competency_json, learner_snapshot)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
             ON CONFLICT (competency_matrix_id, student_document_id) DO UPDATE SET match_score = EXCLUDED.match_score, student_competency_json = EXCLUDED.student_competency_json, learner_snapshot = EXCLUDED.learner_snapshot`,
            [matrixId, docId, matchScore, compJson, snapshot]
          );
        } catch (err) {
          console.warn('match-learners-background one failed', student?.id, err?.message);
        }
      }
    } catch (err) {
      console.error('match-learners-background', err?.message);
    }
  });
  return res.json({ started: true, message: 'Matching started in background. Results will be saved to this JD.' });
});

module.exports = router;
