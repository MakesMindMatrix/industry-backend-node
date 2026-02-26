const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyName: row.company_name,
    officialEmail: row.official_email,
    industryType: row.industry_type,
    companySize: row.company_size,
    headquarters: row.headquarters,
    briefDescription: row.brief_description,
    hiringIntent: row.hiring_intent,
    internshipAvailability: row.internship_availability,
    preferredRoles: row.preferred_roles || [],
    preferredSkillDomains: row.preferred_skill_domains || [],
    mentorshipInterest: row.mentorship_interest,
    guestLectureInterest: row.guest_lecture_interest,
    hackathonParticipation: row.hackathon_participation,
    trainForUsModel: row.train_for_us_model,
    createdAt: row.created_at,
  };
}

// GET /api/industry-profiles/me
router.get('/me', async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM industry_profiles WHERE user_id = $1',
    [req.user.id]
  );
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: { message: 'Industry profile not found' } });
  return res.json(rowToProfile(row));
});

// PUT /api/industry-profiles/me
router.put('/me', async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM industry_profiles WHERE user_id = $1',
    [req.user.id]
  );
  const profile = r.rows[0];
  if (!profile) return res.status(404).json({ error: { message: 'Industry profile not found' } });

  const editable = [
    'companySize', 'headquarters', 'briefDescription', 'hiringIntent',
    'internshipAvailability', 'preferredRoles', 'preferredSkillDomains',
    'mentorshipInterest', 'guestLectureInterest', 'hackathonParticipation', 'trainForUsModel',
  ];
  const body = req.body || {};
  const updates = {};
  editable.forEach((k) => {
    if (body[k] !== undefined) {
      const col = k.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
      if (k === 'preferredRoles' || k === 'preferredSkillDomains') {
        updates[col] = JSON.stringify(Array.isArray(body[k]) ? body[k] : []);
      } else if (k === 'internshipAvailability' || k === 'mentorshipInterest' || k === 'guestLectureInterest' || k === 'hackathonParticipation' || k === 'trainForUsModel') {
        updates[col] = !!body[k];
      } else {
        updates[col] = body[k];
      }
    }
  });
  if (Object.keys(updates).length === 0) {
    return res.json(rowToProfile(profile));
  }
  const keys = Object.keys(updates);
  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = [req.user.id, ...keys.map((k) => updates[k])];
  await pool.query(
    `UPDATE industry_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $1`,
    values
  );
  const r2 = await pool.query('SELECT * FROM industry_profiles WHERE user_id = $1', [req.user.id]);
  const updated = r2.rows[0];
  if (!updated) return res.status(500).json({ error: { message: 'Failed to update profile' } });
  return res.json(rowToProfile(updated));
});

module.exports = router;
