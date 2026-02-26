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

module.exports = router;
