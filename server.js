require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./src/routes/auth');
const industryProfileRoutes = require('./src/routes/industry-profiles');
const jobDescriptionRoutes = require('./src/routes/job-descriptions');
const competencyMatrixRoutes = require('./src/routes/competency-matrices');
const jdRoutes = require('./src/routes/jd');
const learnersRoutes = require('./src/routes/learners');
const industryRoutes = require('./src/routes/industry');
const adminRoutes = require('./src/routes/admin');
const contentRoutes = require('./src/routes/content');

const app = express();
const PORT = parseInt(process.env.PORT || '1337', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors({
  origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'industry-backend-node' });
});

// API routes (same paths as Strapi so frontend works unchanged)
app.use('/api/auth', authRoutes);
app.use('/api/industry-profiles', industryProfileRoutes);
app.use('/api/job-descriptions', jobDescriptionRoutes);
app.use('/api/competency-matrices', competencyMatrixRoutes);
app.use('/api/jd', jdRoutes);
app.use('/api/learners', learnersRoutes);
app.use('/api/industry', industryRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/content', contentRoutes);

const { loadStudentCsvOnStartup } = require('./src/scripts/loadStudentCsvOnStartup');

app.listen(PORT, HOST, () => {
  console.log(`Industry backend (Node) running at http://${HOST}:${PORT}`);
  loadStudentCsvOnStartup().catch((err) => console.warn('Student CSV sync on startup:', err?.message));
});
