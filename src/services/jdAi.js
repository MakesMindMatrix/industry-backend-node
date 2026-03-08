'use strict';

const { Readable } = require('stream');
const { GoogleGenAI } = require('@google/genai');
const { pool } = require('../db/pool');

const GEMINI_MODEL = process.env.GEMINI_JD_MODEL || 'gemini-2.5-flash';
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
const SIMILARITY_THRESHOLD = 0.82;
const CACHE_SYSTEM_INSTRUCTION = `You are an expert HR and job description writer. You help create clear, structured job descriptions (JDs) for industry hiring in a conversational way.

Standard JD fields to gather or include (ask the user if missing):
- Job title, department, location (or "Remote"/hybrid)
- Employment type: full-time, contract, internship, etc.
- Expected start date of joining (required)
- Reporting to (role/manager)
- Experience level (e.g. Junior, Mid, Senior, Lead)
- Key responsibilities, qualifications, and compensation range if applicable

Rules: Output valid JSON only. If you need more info, ask 1-3 short questions in a "questions" array (each string). 
When you have enough info, output a "jd" string (full job description text) and optionally "title" (job title). Do not repeat questions.
Do not use emojis, icons, or figures/diagrams in the JD. Plain text only.`;

const JD_SUGGESTIONS = {
  roles: [
    'Backend Engineer', 'Frontend Developer', 'Full Stack Engineer', 'Data Scientist', 'ML Engineer',
    'DevOps Engineer', 'Product Manager', 'UX Designer', 'QA Engineer', 'Solutions Architect',
  ],
  skills: [
    'Node.js', 'Python', 'React', 'AWS', 'Kubernetes', 'Machine Learning', 'SQL', 'REST APIs',
    'GenAI / LLMs', 'Prompt Engineering', 'RAG', 'Data Pipeline',
  ],
  experience: ['0-1 years', '1-3 years', '3-5 years', '5+ years'],
};

const COMPETENCY_SYSTEM = `You are an HR analyst. Given a job description, extract competency categories and skills relevant to that role.
Output valid JSON only with this exact structure:
{
  "competencies": [
    { "id": 1, "category": "Category name (e.g. Technical Skills)", "skills": ["skill1", "skill2"], "weight": 25, "importance": "Critical" or "High" or "Medium" },
    ...
  ],
  "suggestions": ["Short suggestion 1", "Short suggestion 2", ...]
}
- importance: Critical = must-have, High = important, Medium = nice-to-have
- weight: number 5-50 per category (total can exceed 100; we use for relative weight)
- skills: 2-6 per category, specific to the JD
- suggestions: 2-4 short actionable tips for hiring or assessing these competencies`;

async function ensureJdCacheTable() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch (_) {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jd_cache (
      id SERIAL PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL,
      prompt_summary TEXT,
      embedding vector(768),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function embedText(ai, text) {
  const res = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: text,
    config: { outputDimensionality: 768 },
  });
  const emb = res.embeddings?.[0]?.values;
  return Array.isArray(emb) ? emb : null;
}

async function findSimilarJd(embedding) {
  if (!embedding || embedding.length !== 768) return null;
  const list = await pool.query(
    `SELECT id, title, content, 1 - (embedding <=> $1::vector) AS similarity
     FROM jd_cache WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 1`,
    [`[${embedding.join(',')}]`]
  );
  const row = list.rows[0];
  if (row && parseFloat(row.similarity) >= SIMILARITY_THRESHOLD) return row;
  return null;
}

async function saveJdToCache(title, content, promptSummary, embedding) {
  const vec = embedding ? `[${embedding.join(',')}]` : null;
  await pool.query(
    `INSERT INTO jd_cache (title, content, prompt_summary, embedding) VALUES ($1, $2, $3, $4::vector)`,
    [title || null, content, promptSummary || null, vec]
  );
}

function parseGeminiJson(text) {
  const stripped = (text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (_) {
    return { jd: text || '', questions: [] };
  }
}

async function getAddonSuggestions(ai, title, jdText) {
  if (!jdText || jdText.length < 50) return [];
  const prompt = `Given this job description (title: ${title || 'N/A'}), suggest 3 or 4 short optional add-ons the company might want to include. Examples: "Add certification requirements", "Add team size or reporting structure", "Add benefits and perks section", "Add preferred tech stack details", "Add diversity & inclusion statement". Return valid JSON only: { "addonSuggestions": ["suggestion 1", "suggestion 2", ...] }. Keep each suggestion under 10 words.`;
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const text = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseGeminiJson(text);
    const list = parsed.addonSuggestions;
    return Array.isArray(list) ? list.slice(0, 4).filter((s) => typeof s === 'string' && s.length > 0) : [];
  } catch (_) {
    return [];
  }
}

async function generateCompetencyFromJd(ai, title, jdText) {
  const prompt = `Job title: ${title || 'N/A'}\n\nJob description:\n${(jdText || '').slice(0, 12000)}\n\nExtract competency matrix (categories, skills, weight, importance) and 2-4 short suggestions. Output JSON only.`;
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { systemInstruction: COMPETENCY_SYSTEM, responseMimeType: 'application/json' },
    });
    const text = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseGeminiJson(text);
    const competencies = Array.isArray(parsed.competencies)
      ? parsed.competencies.map((c, i) => ({
          id: i + 1,
          category: c.category || 'Category',
          skills: Array.isArray(c.skills) ? c.skills : [],
          weight: typeof c.weight === 'number' ? Math.min(50, Math.max(5, c.weight)) : 20,
          importance: ['Critical', 'High', 'Medium'].includes(c.importance) ? c.importance : 'High',
        }))
      : [];
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s) => typeof s === 'string') : [];
    return { competencies, suggestions };
  } catch (_) {
    return { competencies: [], suggestions: [] };
  }
}

const STUDENT_COMPETENCY_SYSTEM = `You are an HR analyst. Given a student/learner profile and the job's competency matrix (categories and skills), estimate the student's competency level for each skill.
Output valid JSON only with this exact structure:
{
  "skillGroups": [
    { "category": "same as job category", "skills": [ { "skill": "skill name", "level": 1-5 } ], "weight": same as job weight },
    ...
  ]
}
- level: 1 = None/Beginner, 2 = Basic, 3 = Intermediate, 4 = Advanced, 5 = Expert. Use only integers 1-5.
- Include every category and skill from the job matrix. Infer student level from their education, branch, specialisation, career aspiration, and interests.`;

function studentProfileText(student) {
  const o = student || {};
  const parts = [];
  if (o.name) parts.push(`Name: ${o.name}`);
  if (o.education_level) parts.push(`Education: ${o.education_level}`);
  if (o.specialisation) parts.push(`Specialisation: ${o.specialisation}`);
  const college = o.master_college?.name || o.university?.name;
  if (college) parts.push(`College/University: ${college}`);
  const branch = o.branch?.name;
  if (branch) parts.push(`Branch: ${branch}`);
  const aspiration = o.career_aspiration?.title;
  if (aspiration) parts.push(`Career aspiration: ${aspiration}`);
  const interests = o.career_interests?.interests;
  if (Array.isArray(interests)) {
    const list = interests.map((i) => i?.career_interest).filter(Boolean).join(', ');
    if (list) parts.push(`Career interests: ${list}`);
  }
  return parts.join('\n') || 'No profile details';
}

/**
 * Generate a competency matrix for a student matching the job's skill groups.
 * Returns skillGroups with same structure as job but each skill has { skill, level: 1-5 }.
 */
async function generateStudentCompetencyFromProfile(ai, student, jobSkillGroups) {
  if (!Array.isArray(jobSkillGroups) || jobSkillGroups.length === 0) {
    return { skillGroups: [] };
  }
  const profileText = studentProfileText(student);
  const jobMatrixStr = JSON.stringify(
    jobSkillGroups.map((g) => ({
      category: g.category,
      skills: g.skills,
      weight: g.weight,
    })),
    null,
    2
  );
  const prompt = `Student profile:\n${profileText}\n\nJob competency matrix (categories and skills to assess):\n${jobMatrixStr}\n\nEstimate this student's level (1-5) for each skill. Output JSON only with "skillGroups" array.`;
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { systemInstruction: STUDENT_COMPETENCY_SYSTEM, responseMimeType: 'application/json' },
    });
    const text = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseGeminiJson(text);
    const skillGroups = Array.isArray(parsed.skillGroups)
      ? parsed.skillGroups.map((g) => ({
          category: g.category || 'Category',
          weight: typeof g.weight === 'number' ? g.weight : 20,
          skills: Array.isArray(g.skills)
            ? g.skills.map((s) => ({
                skill: typeof s === 'string' ? s : (s && s.skill) || 'Skill',
                level: typeof s === 'object' && s !== null && typeof s.level === 'number' ? Math.min(5, Math.max(1, s.level)) : 3,
              }))
            : [],
        }))
      : [];
    return { skillGroups };
  } catch (_) {
    return { skillGroups: [] };
  }
}

/**
 * Compute match score 0-100 between job skill groups and student skill groups.
 * Job has skills per category with weight; student has skills with level 1-5.
 * Score = weighted average of (student_level/5) over job skills.
 * When AI returns empty skill groups, use default level 3 (60%) so we show a baseline score.
 */
function computeMatchScore(jobSkillGroups, studentSkillGroups) {
  if (!Array.isArray(jobSkillGroups) || jobSkillGroups.length === 0) return 0;
  const hasStudentData = Array.isArray(studentSkillGroups) && studentSkillGroups.length > 0;
  const defaultLevel = hasStudentData ? 0 : 3; // 0 = no match when we have AI data; 3 = baseline when AI returned empty
  let totalWeight = 0;
  let weightedSum = 0;
  for (const jg of jobSkillGroups) {
    const jobSkills = Array.isArray(jg.skills) ? jg.skills : [];
    const weight = typeof jg.weight === 'number' ? jg.weight : 20;
    const studentGroup = hasStudentData
      ? studentSkillGroups.find((sg) => (sg.category || '').toLowerCase() === (jg.category || '').toLowerCase())
      : null;
    const studentSkills = studentGroup && Array.isArray(studentGroup.skills) ? studentGroup.skills : [];
    for (const sk of jobSkills) {
      const skillName = (typeof sk === 'string' ? sk : (sk && sk.skill) || '').trim().toLowerCase();
      if (!skillName) continue;
      totalWeight += weight;
      const studentSk = studentSkills.find((ss) => {
        const s = (typeof ss.skill === 'string' ? ss.skill : (ss && ss.skill) || '').trim().toLowerCase();
        return s === skillName;
      });
      const level = studentSk && typeof studentSk.level === 'number' ? studentSk.level : defaultLevel;
      weightedSum += weight * (level / 5);
    }
  }
  if (totalWeight <= 0) return 0;
  return Math.round((weightedSum / totalWeight) * 100);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  JD_SUGGESTIONS,
  CACHE_SYSTEM_INSTRUCTION,
  GEMINI_MODEL,
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
};
