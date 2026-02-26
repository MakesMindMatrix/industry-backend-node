# Industry Backend (Node.js)

Express + PostgreSQL backend that replaces Strapi. Same API surface so the frontend works unchanged. **This is its own Git repo** (separate from the frontend).

## Git (this repo only)

Push this folder as a **standalone repo**:

```bash
cd industry-backend-node
git init
git add .
git commit -m "Initial: Industry portal backend"
git remote add origin <backend-repo-url>
git push -u origin main
```

## Setup

1. **Create PostgreSQL database**
   ```bash
   createdb industry_app
   ```
   Or with a user:
   ```bash
   createuser -P industry_app_user
   createdb -O industry_app_user industry_app
   ```

2. **Install dependencies**
   ```bash
   cd industry-backend-node
   npm install
   ```

3. **Configure environment**
   - Copy `.env.example` to `.env` and set `DATABASE_URL` (or `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`).
   - Set `JWT_SECRET` and `ADMIN_JWT_SECRET` (use long random strings).
   - Set `GEMINI_API_KEY` for AI JD Builder and competency extraction.
   - Optional: `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the default admin created by init-db.

4. **Initialize database**
   ```bash
   npm run init-db
   ```
   This creates all tables and a default admin user (from `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

5. **Start the server**
   ```bash
   npm run dev
   ```
   Server runs at `http://0.0.0.0:1337` by default.

## API (aligned with frontend)

- **Auth:** `POST /api/auth/local`, `POST /api/auth/industry-register`
- **Industry profile:** `GET/PUT /api/industry-profiles/me` (auth)
- **Job descriptions:** `GET /api/job-descriptions/mine`, `POST/GET/PUT/DELETE /api/job-descriptions/:id` (auth)
- **Competency matrices:** `GET /api/competency-matrices/by-jd/:jdId`, `POST /api/competency-matrices`, `PUT /api/competency-matrices/:id` (auth)
- **JD AI:** `GET /api/jd/suggestions`, `POST /api/jd/generate`, `POST /api/jd/generate-stream`, `POST /api/jd/competency-from-jd`, `POST /api/jd/match-learners`
- **Learners:** `GET /api/learners` (proxy to external API)
- **Industry:** `GET /api/industry/home`, `/metrics`, `/competency`, `/future-hiring`, `/contribute`
- **Admin:** `POST /api/admin/login` → then `GET/POST/PUT/DELETE /api/admin/content` with Bearer token
- **Content (public):** `GET /api/content`, `GET /api/content/:slug`

## Switching from Strapi

1. Stop the Strapi backend.
2. Run this backend on the same port (1337) or set the frontend `VITE_API_URL` to the new URL.
3. Run `npm run init-db` once to create the new schema.
4. Existing Strapi data is not migrated automatically; you can re-register industry users and re-create JDs, or write a one-off migration script if needed.

## Admin & content

- **Admin login:** Open `/admin/login`, sign in with the admin created by init-db.
- **Content management:** After login, go to `/admin/content` to create/edit/delete content.
- **Content display:** Public content is listed at `/content` and each piece at `/content/:slug`.

## Deploy (GCE VM or App Engine)

**Option A – App Engine**

```bash
npm install
# Set env in App Engine Console: DATABASE_URL, JWT_SECRET, GEMINI_API_KEY, etc.
gcloud app deploy
```

**Option B – GCE VM**

On the VM: clone this repo, `npm install`, copy `.env.example` to `.env` and set production values, then `node server.js` (or use PM2/systemd). Put `temp/student.csv` on the VM if you use CSV-based student IDs; the server loads it on startup.
