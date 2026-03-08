const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware, optionalAuthMiddleware } = require('../middleware/auth');

router.get('/metrics', (req, res) => {
  res.json({
    metrics: [
      { label: 'Active Postings', value: 12, trend: '+3' },
      { label: 'New Matches (>85%)', value: 47, trend: '+8' },
      { label: 'Interviewing Today', value: 5 },
      { label: 'Training Pipeline', value: 120, trend: '+25' },
    ],
  });
});

router.get('/home', (req, res) => {
  res.json({ hiringHighlights: [], newsFeed: [] });
});

router.get('/competency', (req, res) => {
  res.json({ competencies: [], suggestions: [] });
});

// GET /api/industry/future-hiring — list current user's requirements (auth)
router.get('/future-hiring', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, role_title, candidates_count, timeline, job_description_id, status, progress, ready_date, skills, created_at
       FROM future_hiring_requirements WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    const pipelines = r.rows.map((row) => {
      const readyDate = row.ready_date
        ? new Date(row.ready_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';
      return {
        id: row.id,
        role: row.role_title || '',
        candidates: row.candidates_count ?? 0,
        timeline: row.timeline || '3 months',
        job_description_id: row.job_description_id ?? null,
        status: row.status || 'Planned',
        progress: row.progress ?? 0,
        readyDate,
        skills: Array.isArray(row.skills) ? row.skills : [],
      };
    });
    return res.json({ pipelines });
  } catch (err) {
    console.error('[industry] future-hiring GET', err);
    return res.status(500).json({ pipelines: [] });
  }
});

// POST /api/industry/future-hiring — create a new requirement (auth)
router.post('/future-hiring', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const roleTitle = body.role_title ?? body.roleTitle ?? '';
  const candidatesCount = parseInt(body.candidates_count ?? body.candidatesCount ?? 1, 10);
  const timeline = body.timeline ?? '3 months';
  const jdId = body.job_description_id ?? body.job_descriptionId ?? body.attachedJdId;
  const jobDescriptionId = jdId != null && jdId !== '' ? parseInt(String(jdId), 10) : null;
  if (!roleTitle || String(roleTitle).trim() === '') {
    return res.status(400).json({ error: { message: 'Role title is required' } });
  }
  const num = Number.isNaN(candidatesCount) || candidatesCount < 1 ? 1 : Math.min(candidatesCount, 999);
  const timelineMonths = { '3': '3 months', '6': '6 months', '9': '9 months', '12': '12 months' };
  const timelineLabel = timelineMonths[String(timeline)] || (String(timeline).match(/^\d+$/) ? `${timeline} months` : String(timeline));
  try {
    if (jobDescriptionId != null && !Number.isNaN(jobDescriptionId)) {
      const jdCheck = await pool.query('SELECT id, created_by FROM job_descriptions WHERE id = $1', [jobDescriptionId]);
      const jd = jdCheck.rows[0];
      if (!jd || (jd.created_by != null && jd.created_by !== req.user.id)) {
        return res.status(400).json({ error: { message: 'Invalid or forbidden job description' } });
      }
    }
    const r = await pool.query(
      `INSERT INTO future_hiring_requirements (user_id, role_title, candidates_count, timeline, job_description_id, status, progress, skills)
       VALUES ($1, $2, $3, $4, $5, 'Planned', 0, '[]')
       RETURNING id, role_title, candidates_count, timeline, status, progress, ready_date, skills, created_at`,
      [req.user.id, String(roleTitle).trim(), num, timelineLabel, jobDescriptionId]
    );
    const row = r.rows[0];
    if (!row) {
      return res.status(500).json({ error: { message: 'Failed to create requirement' } });
    }
    const readyDate = row.ready_date
      ? new Date(row.ready_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
    return res.status(201).json({
      id: row.id,
      role: row.role_title,
      candidates: row.candidates_count,
      timeline: row.timeline,
      status: row.status || 'Planned',
      progress: row.progress ?? 0,
      readyDate,
      skills: Array.isArray(row.skills) ? row.skills : [],
    });
  } catch (err) {
    console.error('[industry] future-hiring POST', err);
    return res.status(500).json({ error: { message: 'Failed to create requirement' } });
  }
});

// GET /api/industry/future-hiring/:id — get one requirement (auth, own only)
router.get('/future-hiring/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: { message: 'Invalid id' } });
  try {
    const r = await pool.query(
      `SELECT id, role_title, candidates_count, timeline, job_description_id, status, progress, ready_date, skills, created_at
       FROM future_hiring_requirements WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: { message: 'Requirement not found' } });
    const readyDate = row.ready_date
      ? new Date(row.ready_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
    return res.json({
      id: row.id,
      role: row.role_title || '',
      candidates: row.candidates_count ?? 0,
      timeline: row.timeline || '3 months',
      job_description_id: row.job_description_id ?? null,
      status: row.status || 'Planned',
      progress: row.progress ?? 0,
      readyDate,
      skills: Array.isArray(row.skills) ? row.skills : [],
      created_at: row.created_at,
    });
  } catch (err) {
    console.error('[industry] future-hiring GET :id', err);
    return res.status(500).json({ error: { message: 'Failed to load requirement' } });
  }
});

// PUT /api/industry/future-hiring/:id — update requirement (auth, own only)
router.put('/future-hiring/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: { message: 'Invalid id' } });
  const body = req.body || {};
  const roleTitle = body.role_title ?? body.roleTitle ?? '';
  const candidatesCount = parseInt(body.candidates_count ?? body.candidatesCount ?? 1, 10);
  const timeline = body.timeline ?? '3 months';
  const jdId = body.job_description_id ?? body.job_descriptionId ?? body.attachedJdId;
  const jobDescriptionId = jdId != null && jdId !== '' ? parseInt(String(jdId), 10) : null;
  if (!roleTitle || String(roleTitle).trim() === '') {
    return res.status(400).json({ error: { message: 'Role title is required' } });
  }
  const num = Number.isNaN(candidatesCount) || candidatesCount < 1 ? 1 : Math.min(candidatesCount, 999);
  const timelineMonths = { '3': '3 months', '6': '6 months', '9': '9 months', '12': '12 months' };
  const timelineLabel = timelineMonths[String(timeline)] || (String(timeline).match(/^\d+$/) ? `${timeline} months` : String(timeline));
  try {
    const existing = await pool.query(
      'SELECT id FROM future_hiring_requirements WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: { message: 'Requirement not found' } });
    if (jobDescriptionId != null && !Number.isNaN(jobDescriptionId)) {
      const jdCheck = await pool.query('SELECT id, created_by FROM job_descriptions WHERE id = $1', [jobDescriptionId]);
      const jd = jdCheck.rows[0];
      if (!jd || (jd.created_by != null && jd.created_by !== req.user.id)) {
        return res.status(400).json({ error: { message: 'Invalid or forbidden job description' } });
      }
    }
    await pool.query(
      `UPDATE future_hiring_requirements
       SET role_title = $1, candidates_count = $2, timeline = $3, job_description_id = $4, updated_at = NOW()
       WHERE id = $5 AND user_id = $6`,
      [String(roleTitle).trim(), num, timelineLabel, jobDescriptionId, id, req.user.id]
    );
    const r = await pool.query(
      `SELECT id, role_title, candidates_count, timeline, job_description_id, status, progress, ready_date, skills, created_at
       FROM future_hiring_requirements WHERE id = $1`,
      [id]
    );
    const row = r.rows[0];
    const readyDate = row.ready_date
      ? new Date(row.ready_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
    return res.json({
      id: row.id,
      role: row.role_title,
      candidates: row.candidates_count,
      timeline: row.timeline,
      job_description_id: row.job_description_id ?? null,
      status: row.status || 'Planned',
      progress: row.progress ?? 0,
      readyDate,
      skills: Array.isArray(row.skills) ? row.skills : [],
    });
  } catch (err) {
    console.error('[industry] future-hiring PUT', err);
    return res.status(500).json({ error: { message: 'Failed to update requirement' } });
  }
});

router.get('/contribute', optionalAuthMiddleware, async (req, res) => {
  try {
    const [programsRes, contributionsRes] = await Promise.all([
      pool.query('SELECT id, title, summary, body, status, program_type, students_count, created_at, updated_at FROM ecosystem_programs ORDER BY updated_at DESC'),
      pool.query('SELECT id, icon, title, description, cta_text, created_at, updated_at FROM ecosystem_contributions ORDER BY updated_at DESC'),
    ]);
    const programs = programsRes.rows.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary || '',
      body: row.body || '',
      status: row.status || 'Active',
      program_type: row.program_type || '',
      students_count: row.students_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    let contributions = contributionsRes.rows.map((row) => ({
      id: row.id,
      icon: row.icon || 'Globe',
      title: row.title,
      description: row.description || '',
      cta_text: row.cta_text || 'Learn more',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      interested: false,
    }));
    const userId = req.user?.id;
    if (userId && contributions.length > 0) {
      const ids = contributions.map((c) => c.id);
      const interestRes = await pool.query(
        'SELECT contribution_id FROM contribution_interests WHERE user_id = $1 AND contribution_id = ANY($2)',
        [userId, ids]
      );
      const interestedIds = new Set(interestRes.rows.map((r) => r.contribution_id));
      contributions = contributions.map((c) => ({ ...c, interested: interestedIds.has(c.id) }));
    }
    return res.json({ programs, contributions, talentPush: [] });
  } catch (err) {
    console.error('[industry] contribute', err);
    return res.status(500).json({ programs: [], contributions: [], talentPush: [] });
  }
});

router.post('/contribute/interest', authMiddleware, async (req, res) => {
  const contributionId = req.body?.contribution_id ?? req.body?.contributionId;
  if (!contributionId) {
    return res.status(400).json({ error: { message: 'contribution_id is required' } });
  }
  const id = parseInt(contributionId, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: { message: 'Invalid contribution_id' } });
  }
  try {
    await pool.query(
      `INSERT INTO contribution_interests (contribution_id, user_id) VALUES ($1, $2)
       ON CONFLICT (contribution_id, user_id) DO NOTHING`,
      [id, req.user.id]
    );
    return res.json({ success: true, interested: true });
  } catch (err) {
    console.error('[industry] contribute/interest', err);
    return res.status(500).json({ error: { message: 'Failed to record interest' } });
  }
});

// --- Talent Push (AI-matched students per company profile; cached, refresh manually or weekly) ---
const talentPushAi = require('../services/talentPushAi');
const { GoogleGenAI } = require('@google/genai');
const { generateStudentCompetencyFromProfile, computeMatchScore } = require('../services/jdAi');
const { getLearnersForOurStudents } = require('../services/fetchLearnersDirect');
const { learnersByDocumentId } = require('../lib/strapiQuery');

const EXTERNAL_LEARNERS_BASE = () => (process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io').replace(/\/$/, '');

async function fetchLearnerByDocumentId(documentId) {
  if (!documentId || typeof documentId !== 'string') return null;
  const baseUrl = EXTERNAL_LEARNERS_BASE();
  try {
    const query = learnersByDocumentId(documentId, { populateUser: false });
    const url = `${baseUrl}/api/learners?${query}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(data.data) && data.data.length > 0) {
      const raw = data.data[0];
      const attrs = raw.attributes || raw;
      return {
        id: raw.id ?? attrs.id,
        name: attrs.name,
        education_level: attrs.education_level,
        specialisation: attrs.specialisation,
        user_category: attrs.user_category,
        master_college: attrs.master_college?.data?.attributes ? { name: attrs.master_college.data.attributes.name } : attrs.master_college,
        university: attrs.university?.data?.attributes ? { name: attrs.university.data.attributes.name } : attrs.university,
        branch: attrs.branch?.data?.attributes ? { name: attrs.branch.data.attributes.name } : attrs.branch,
        career_aspiration: attrs.career_aspiration?.data?.attributes ? { title: attrs.career_aspiration.data.attributes.title } : attrs.career_aspiration,
        career_interests: attrs.career_interests?.data?.attributes ? { interests: (attrs.career_interests.data.attributes.interests || []).map((i) => ({ career_interest: i?.career_interest ?? i?.data?.attributes?.career_interest })) } : attrs.career_interests,
        user: attrs.user?.data?.attributes ? { email: attrs.user.data.attributes.email, username: attrs.user.data.attributes.username } : attrs.user,
      };
    }
  } catch (err) {
    console.warn('[industry] fetchLearnerByDocumentId', documentId, err?.message);
  }
  return null;
}

// GET /api/industry/our-students — fetch learners directly (populate), random order (auth)
router.get('/our-students', authMiddleware, async (req, res) => {
  try {
    const data = await getLearnersForOurStudents(500);
    return res.json({ data });
  } catch (err) {
    console.error('[industry] our-students GET', err?.message);
    return res.status(500).json({ data: [] });
  }
});

// GET /api/industry/talent-push — return cached list (auth)
router.get('/talent-push', authMiddleware, async (req, res) => {
  try {
    const cached = await talentPushAi.getCached(req.user.id);
    return res.json({
      students: cached.students,
      computedAt: cached.computedAt,
    });
  } catch (err) {
    console.error('[industry] talent-push GET', err);
    return res.status(500).json({ students: [], computedAt: null });
  }
});

// POST /api/industry/talent-push/refresh — recompute with AI and store (auth)
router.post('/talent-push/refresh', authMiddleware, async (req, res) => {
  try {
    const result = await talentPushAi.computeAndSave(req.user.id);
    return res.json({
      students: result.students,
      computedAt: result.computedAt,
    });
  } catch (err) {
    console.error('[industry] talent-push/refresh', err);
    return res.status(500).json({
      error: { message: err.message || 'Failed to refresh talent push' },
      students: [],
      computedAt: null,
    });
  }
});

// Ensure talent_push_competency_cache exists (cache competency so we don't recompute on every view)
async function ensureTalentPushCompetencyCacheTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS talent_push_competency_cache (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id VARCHAR(100) NOT NULL,
      skill_groups JSONB DEFAULT '[]',
      computed_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, document_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_talent_push_competency_user ON talent_push_competency_cache(user_id)').catch(() => {});
}

// POST /api/industry/talent-push/student-competency — AI competency breakdown for a student; cached after first view (auth)
router.post('/talent-push/student-competency', authMiddleware, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const body = req.body || {};
  const documentId = body.documentId ?? body.document_id;
  const learnerSnapshot = body.learnerSnapshot ?? body.learner_snapshot ?? {};
  if (!documentId && !(learnerSnapshot && typeof learnerSnapshot === 'object' && (learnerSnapshot.name || learnerSnapshot.id))) {
    return res.status(400).json({ error: { message: 'documentId or learnerSnapshot with name/id required' }, skillGroups: [] });
  }
  const docIdForCache = documentId && typeof documentId === 'string' ? documentId.trim() : null;
  try {
    await ensureTalentPushCompetencyCacheTable();
    if (docIdForCache) {
      const cached = await pool.query(
        'SELECT skill_groups FROM talent_push_competency_cache WHERE user_id = $1 AND document_id = $2',
        [req.user.id, docIdForCache]
      );
      if (cached.rows[0] && Array.isArray(cached.rows[0].skill_groups) && cached.rows[0].skill_groups.length > 0) {
        return res.json({ skillGroups: cached.rows[0].skill_groups });
      }
    }
    if (!apiKey) {
      return res.status(503).json({ error: { message: 'Gemini API key not configured' }, skillGroups: [] });
    }
    const profileRow = await pool.query(
      'SELECT preferred_roles, preferred_skill_domains FROM industry_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const profile = profileRow.rows[0];
    const roles = Array.isArray(profile?.preferred_roles) ? profile.preferred_roles.filter((r) => typeof r === 'string' && r.trim()) : [];
    const domains = Array.isArray(profile?.preferred_skill_domains) ? profile.preferred_skill_domains.filter((d) => typeof d === 'string' && d.trim()) : [];
    const jobSkillGroups = [];
    if (roles.length > 0) {
      jobSkillGroups.push({ category: 'Role alignment', skills: roles.slice(0, 8), weight: 50 });
    }
    if (domains.length > 0) {
      jobSkillGroups.push({ category: 'Skill domains', skills: domains.slice(0, 8), weight: 50 });
    }
    if (jobSkillGroups.length === 0) {
      jobSkillGroups.push(
        { category: 'General readiness', skills: ['Technical aptitude', 'Communication', 'Learning agility', 'Problem solving'], weight: 100 }
      );
    }
    let student = learnerSnapshot;
    if (documentId && typeof documentId === 'string') {
      const fetched = await fetchLearnerByDocumentId(documentId);
      if (fetched) student = { ...fetched, documentId };
      else student = { ...learnerSnapshot, documentId };
    }
    const ai = new GoogleGenAI({ apiKey });
    const { skillGroups } = await generateStudentCompetencyFromProfile(ai, student, jobSkillGroups);
    const groups = skillGroups || [];
    if (docIdForCache && groups.length > 0) {
      await pool.query(
        `INSERT INTO talent_push_competency_cache (user_id, document_id, skill_groups, computed_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (user_id, document_id) DO UPDATE SET skill_groups = EXCLUDED.skill_groups, computed_at = NOW()`,
        [req.user.id, docIdForCache, JSON.stringify(groups)]
      );
    }
    return res.json({ skillGroups: groups });
  } catch (err) {
    console.error('[industry] talent-push/student-competency', err?.message || err);
    return res.status(502).json({
      error: { message: err.message || 'Failed to compute competency' },
      skillGroups: [],
    });
  }
});

// Ensure talent_push_shortlist table exists
async function ensureTalentPushShortlistTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS talent_push_shortlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id VARCHAR(100) NOT NULL,
      shortlisted BOOLEAN DEFAULT false,
      shortlisted_at TIMESTAMPTZ,
      schedule_requested BOOLEAN DEFAULT false,
      schedule_requested_at TIMESTAMPTZ,
      interview_date DATE,
      interview_time VARCHAR(50),
      interview_location VARCHAR(500),
      interview_type VARCHAR(50),
      learner_snapshot JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, document_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_talent_push_shortlist_user ON talent_push_shortlist(user_id)').catch(() => {});
}

// POST /api/industry/talent-push/shortlist — add student to shortlist (shows under Active Hiring)
router.post('/talent-push/shortlist', authMiddleware, async (req, res) => {
  const documentId = req.body?.documentId ?? req.body?.document_id;
  if (!documentId || typeof documentId !== 'string' || !documentId.trim()) {
    return res.status(400).json({ error: { message: 'documentId is required' } });
  }
  try {
    await ensureTalentPushShortlistTable();
    const snapshot = req.body?.learnerSnapshot ?? req.body?.learner_snapshot ?? {};
    await pool.query(
      `INSERT INTO talent_push_shortlist (user_id, document_id, shortlisted, shortlisted_at, learner_snapshot, updated_at)
       VALUES ($1, $2, true, NOW(), $3::jsonb, NOW())
       ON CONFLICT (user_id, document_id) DO UPDATE SET
         shortlisted = true, shortlisted_at = NOW(), learner_snapshot = COALESCE(EXCLUDED.learner_snapshot, talent_push_shortlist.learner_snapshot), updated_at = NOW()`,
      [req.user.id, documentId.trim(), JSON.stringify(snapshot)]
    );
    return res.json({ ok: true, shortlisted: true });
  } catch (err) {
    console.error('[industry] talent-push/shortlist', err);
    return res.status(500).json({ error: { message: err.message || 'Failed to shortlist' } });
  }
});

// POST /api/industry/talent-push/schedule — mark schedule interview (shows under Active Hiring)
router.post('/talent-push/schedule', authMiddleware, async (req, res) => {
  const documentId = req.body?.documentId ?? req.body?.document_id;
  if (!documentId || typeof documentId !== 'string' || !documentId.trim()) {
    return res.status(400).json({ error: { message: 'documentId is required' } });
  }
  try {
    await ensureTalentPushShortlistTable();
    const interviewDate = req.body?.interview_date ?? req.body?.interviewDate ?? null;
    const interviewTime = req.body?.interview_time ?? req.body?.interviewTime ?? null;
    const interviewLocation = req.body?.interview_location ?? req.body?.interviewLocation ?? null;
    const interviewType = req.body?.interview_type ?? req.body?.interviewType ?? null;
    const snapshot = req.body?.learnerSnapshot ?? req.body?.learner_snapshot ?? {};
    await pool.query(
      `INSERT INTO talent_push_shortlist (user_id, document_id, schedule_requested, schedule_requested_at, interview_date, interview_time, interview_location, interview_type, learner_snapshot, updated_at)
       VALUES ($1, $2, true, NOW(), $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (user_id, document_id) DO UPDATE SET
         schedule_requested = true, schedule_requested_at = NOW(),
         interview_date = COALESCE(EXCLUDED.interview_date, talent_push_shortlist.interview_date),
         interview_time = COALESCE(EXCLUDED.interview_time, talent_push_shortlist.interview_time),
         interview_location = COALESCE(EXCLUDED.interview_location, talent_push_shortlist.interview_location),
         interview_type = COALESCE(EXCLUDED.interview_type, talent_push_shortlist.interview_type),
         learner_snapshot = COALESCE(NULLIF(EXCLUDED.learner_snapshot::text, '{}'), talent_push_shortlist.learner_snapshot),
         updated_at = NOW()`,
      [req.user.id, documentId.trim(), interviewDate, interviewTime, interviewLocation, interviewType, JSON.stringify(snapshot)]
    );
    return res.json({ ok: true, scheduled: true });
  } catch (err) {
    console.error('[industry] talent-push/schedule', err);
    return res.status(500).json({ error: { message: err.message || 'Failed to schedule' } });
  }
});

module.exports = router;
