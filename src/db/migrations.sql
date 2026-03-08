-- Additive migrations for existing databases
-- Run after schema.sql if DB was created before these columns existed.
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).

-- competency_matrix_student_results
ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS learner_snapshot JSONB DEFAULT '{}';
ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_date DATE;
ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_time VARCHAR(50);
ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_location VARCHAR(500);
ALTER TABLE competency_matrix_student_results ADD COLUMN IF NOT EXISTS interview_type VARCHAR(50);

-- competency_matrices
ALTER TABLE competency_matrices ADD COLUMN IF NOT EXISTS vacancies INTEGER DEFAULT 1;
