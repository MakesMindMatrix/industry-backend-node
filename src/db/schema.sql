-- Industry portal schema (PostgreSQL)
-- Run once: psql $DATABASE_URL -f src/db/schema.sql  OR  node scripts/init-db.js

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Industry users (replaces Strapi users-permissions for this app)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  confirmed BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Company profile (one per user)
CREATE TABLE IF NOT EXISTS industry_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name VARCHAR(255) NOT NULL,
  official_email VARCHAR(255) NOT NULL,
  industry_type VARCHAR(50) NOT NULL,
  company_size VARCHAR(50) DEFAULT 'size_1_10',
  headquarters VARCHAR(255) DEFAULT '',
  brief_description VARCHAR(300) DEFAULT '',
  hiring_intent VARCHAR(50) DEFAULT 'Both',
  internship_availability BOOLEAN DEFAULT true,
  preferred_roles JSONB DEFAULT '[]',
  preferred_skill_domains JSONB DEFAULT '[]',
  mentorship_interest BOOLEAN DEFAULT false,
  guest_lecture_interest BOOLEAN DEFAULT false,
  hackathon_participation BOOLEAN DEFAULT false,
  train_for_us_model BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_industry_profiles_user_id ON industry_profiles(user_id);

-- Job descriptions (drafts and published)
CREATE TABLE IF NOT EXISTS job_descriptions (
  id SERIAL PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  jd TEXT,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_descriptions_created_by ON job_descriptions(created_by);

-- Competency matrix (one per JD, stores skill groups from AI)
CREATE TABLE IF NOT EXISTS competency_matrices (
  id SERIAL PRIMARY KEY,
  job_description_id INTEGER NOT NULL REFERENCES job_descriptions(id) ON DELETE CASCADE,
  skill_groups JSONB DEFAULT '[]',
  approved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_competency_matrices_jd ON competency_matrices(job_description_id);

-- JD cache for AI RAG (vector similarity)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jd_cache (
  id SERIAL PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  prompt_summary TEXT,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin users (separate from industry users)
CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Content (for admin-managed display on frontend)
CREATE TABLE IF NOT EXISTS content (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(255) NOT NULL UNIQUE,
  title VARCHAR(500),
  body TEXT,
  published BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_slug ON content(slug);
CREATE INDEX IF NOT EXISTS idx_content_published ON content(published) WHERE published = true;

-- Ecosystem programs (admin-created; shown to all industry users)
CREATE TABLE IF NOT EXISTS ecosystem_programs (
  id SERIAL PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  summary VARCHAR(1000) DEFAULT '',
  body TEXT DEFAULT '',
  status VARCHAR(50) DEFAULT 'Active',
  program_type VARCHAR(100) DEFAULT '',
  students_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ecosystem contributions (admin-created; industry users can "show interest")
CREATE TABLE IF NOT EXISTS ecosystem_contributions (
  id SERIAL PRIMARY KEY,
  icon VARCHAR(50) DEFAULT 'Globe',
  title VARCHAR(500) NOT NULL,
  description TEXT DEFAULT '',
  cta_text VARCHAR(200) DEFAULT 'Learn more',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Industry user interest in a contribution
CREATE TABLE IF NOT EXISTS contribution_interests (
  id SERIAL PRIMARY KEY,
  contribution_id INTEGER NOT NULL REFERENCES ecosystem_contributions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contribution_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_contribution_interests_contribution ON contribution_interests(contribution_id);
CREATE INDEX IF NOT EXISTS idx_contribution_interests_user ON contribution_interests(user_id);

-- Future hiring / "Train for Us" requirements (one per user submission)
CREATE TABLE IF NOT EXISTS future_hiring_requirements (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_title VARCHAR(500) NOT NULL,
  candidates_count INTEGER NOT NULL DEFAULT 1,
  timeline VARCHAR(50) NOT NULL DEFAULT '3 months',
  job_description_id INTEGER REFERENCES job_descriptions(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'Planned',
  progress INTEGER DEFAULT 0,
  ready_date DATE,
  skills JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_future_hiring_user ON future_hiring_requirements(user_id);

-- Match results: USER -> JD -> competency_matrices -> competency_matrix_student_results (students)
CREATE TABLE IF NOT EXISTS competency_matrix_student_results (
  id SERIAL PRIMARY KEY,
  competency_matrix_id INTEGER NOT NULL REFERENCES competency_matrices(id) ON DELETE CASCADE,
  student_document_id VARCHAR(100) NOT NULL,
  match_score INTEGER DEFAULT 0,
  student_competency_json JSONB DEFAULT '[]',
  learner_snapshot JSONB DEFAULT '{}',
  shortlisted BOOLEAN DEFAULT false,
  shortlisted_at TIMESTAMPTZ,
  schedule_requested BOOLEAN DEFAULT false,
  schedule_requested_at TIMESTAMPTZ,
  interview_date DATE,
  interview_time VARCHAR(50),
  interview_location VARCHAR(500),
  interview_type VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(competency_matrix_id, student_document_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_student_results_matrix ON competency_matrix_student_results(competency_matrix_id);
CREATE INDEX IF NOT EXISTS idx_cm_student_results_document_id ON competency_matrix_student_results(student_document_id);

-- Student IDs (from CSV / admin upload); used for match-learners when present
CREATE TABLE IF NOT EXISTS student_ids (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  external_id INTEGER,
  document_id VARCHAR(100),
  source VARCHAR(50) DEFAULT 'csv',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_ids_email ON student_ids(email);
CREATE INDEX IF NOT EXISTS idx_student_ids_document_id ON student_ids(document_id);
