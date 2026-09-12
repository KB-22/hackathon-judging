# Hackathon Judging Management System

A self-contained web app for running live hackathon judging with two roles:

- **Admin** – manages faculties, panels, judges, teams, criteria and assignments; sees the full dashboard (raw + normalized marks, judge/team/faculty/panel views, rankings, completion, statistics, audit log) and exports to Excel/CSV.
- **Judge** – secure individual login; sees **only** the teams assigned to them, scores them on the 9-criterion rubric, and never sees other judges' scores, other panels, or rankings.

Node.js + Express, storing data in **SQLite or Supabase/PostgreSQL** (switch with one environment variable). SQLite uses Node's built-in `node:sqlite`, so there is nothing to compile. No frontend build step and no CDN dependencies, so it works on flaky event Wi-Fi.

## Quick start

```bash
npm install
cp .env.example .env         # then edit SESSION_SECRET / ADMIN_PASSWORD
npm start                    # http://localhost:3000
```

On first start an admin account is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` (defaults `admin` / `admin12345`) and you are prompted to change the password at first login.

Load a realistic demo dataset (3 faculties, 2 panels, 6 judges, 12 teams, ~75 % of scores submitted):

```bash
npm run seed:demo            # judge1 … judge6 / Judge@123
```

Run the test suite (scoring engine, both drivers, and the Supabase schema against a real Postgres):

```bash
npm test
```

## Database: SQLite or Supabase

One codebase, two drivers, selected with `DB_DRIVER` in `.env`:

| `DB_DRIVER` | Storage | Use it when |
|---|---|---|
| `sqlite` (default) | one local file, `data/judging.db` | running on a laptop at the venue. No network, nothing to set up, fastest. |
| `postgres` | Supabase / any PostgreSQL | the app is deployed, or several people need the same data, or you want cloud backups. |

Switching drivers changes nothing else: the same SQL runs on both, and `npm test` covers the shared subset.

### Setting up Supabase

**The quickest path — one paste, no tools.** Generate a single file containing
the schema and your current event data, then run it once:

```bash
npm run db:bundle
```

Open the Supabase Dashboard → **SQL Editor** → New query → paste the whole of
`sql/000_setup_all.sql` → Run. It creates the tables, loads teams/judges/panels/
assignments, and finishes with a verification query. Running it again is safe.

**Then point the app at Supabase.** In `.env`:

```
DB_DRIVER=postgres
SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres
```

That is the **Direct connection** ("basic") string from Dashboard → Connect.
The username is plain `postgres`. If the password contains `@ : / ? #` or `%`,
percent-encode it — `@` becomes `%40` — or the URL parser reads it as the host
separator.

The direct host is IPv6-only on the free plan. On a network without IPv6, use
the **Session pooler** instead, which is IPv4 and otherwise identical:

```
SUPABASE_DB_URL=postgresql://postgres.<ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Verify with `npm run db:check`, which prints row counts and panel sizes.

**If port 5432 is reachable you can skip the SQL Editor entirely:**

```bash
npm run db:setup            # create the tables
npm run db:push -- --force  # copy the local event up, preserving ids
```

### Latency: pick the right database for the day

A local SQLite write takes about a millisecond. The same write against Supabase
in another region takes seconds, because every statement is a network round
trip. Measured from India against a Seoul project:

| Action | SQLite | Supabase (direct) |
|---|---|---|
| Judge saves or submits a score | ~5 ms | ~2.9 s |
| Admin dashboard | ~20 ms | ~1.0 s |

Both are usable, but for a single-venue event on one laptop SQLite is markedly
snappier and has no network dependency at all. Use Supabase when the app is
deployed, when several people need the same data, or when you want the results
in the cloud. Switching is one line in `.env`.

The Postgres driver pre-opens its connection pool at startup and enables TCP
keepalives, because establishing a connection costs seconds while a query on an
open one costs milliseconds.

### If port 5432 is blocked

Campus, hostel and corporate networks very often allow only ports 80 and 443, which makes the database look unreachable even though the credentials are perfect. `npm run db:setup` detects this and says so explicitly rather than reporting a vague timeout.

Everything can still be loaded through the browser, which uses HTTPS:

```bash
npm run db:dump             # writes sql/002_data.sql from the local SQLite event
```

Open the Supabase Dashboard → **SQL Editor**, run [`sql/001_schema.sql`](sql/001_schema.sql), then run the generated `sql/002_data.sql`. That creates every table and loads the whole event, including the bcrypt password hashes, so judge logins that were already handed out keep working.

The running app still needs port 5432 to *use* Supabase. So on a blocked network either run the event on SQLite (recommended anyway — no network dependency), or deploy the app to a host, whose network will reach Supabase normally.

Useful commands:

```bash
npm run db:check           # connectivity + row counts + panel sizes, for either driver
npm run db:dump            # export the local event as paste-able PostgreSQL
npm run db:reset-scores    # wipe scores in Postgres, keep teams/judges/history
```

### Why the public Supabase key is safe to expose

`SUPABASE_URL` and the publishable/anon key are designed to be public, **but only because the schema locks them out.** `001_schema.sql` enables Row Level Security on every table and deliberately creates **no policies**, then revokes all grants from the `anon` and `authenticated` roles. With RLS on and no policy, those roles can read and write nothing.

This matters: without it, anyone holding the anon key could query the `scores` table through Supabase's REST API and read every judge's marks and the live rankings, completely bypassing this app's role checks. The backend connects as the table owner over the Postgres connection string, which bypasses RLS, so only the server can touch judging data.

Keep the database password and the `service_role` key secret. Rotate them in the dashboard if they are ever pasted into a chat, screenshot or repo.

## Hack Days Solan 2026 setup

Load the real event straight from the Google Form registrations workbook:

```bash
npm run import -- "C:\path\to\HACK DAYS SOLAN 2026 (Responses).xlsx" --force
```

This sets the event name, creates **3 panels of 2 judges** (one JUIT faculty member + one industry expert each), imports every registered team as `T01…Tnn` with members and project description, splits teams evenly across panels in registration order, assigns each team to both judges of its panel, and writes judge logins to `data/judge-credentials.txt` (hand them out, then delete the file). `--force` wipes previous teams/judges/panels/scores first. Adjust panels or team assignment afterwards under **Admin → Assignments**. To show the club logo in the header, drop it at `public/img/logo.png`.

## Rubric (100 marks)

| # | Criterion | Max |
|---|-----------|-----|
| 1 | Problem Understanding & Relevance | 10 |
| 2 | Innovation & Originality | 15 |
| 3 | Gemini API Integration | 15 |
| 4 | Technical Implementation | 15 |
| 5 | Solution Effectiveness & Accuracy | 10 |
| 6 | User Experience & Interface | 10 |
| 7 | GitHub Implementations | 10 |
| 8 | Scalability & Feasibility | 10 |
| 9 | Presentation & Demonstration | 5 |

Criteria live in the database (`criteria` table) and are editable from **Admin → Criteria**; the total must equal 100. Once any score exists, only names/descriptions/order can change, protecting recorded data.

## How scoring works

- Judges enter marks per criterion (steps of 0.5, bounded by each criterion's max). The **raw total** is computed in the database (`v_score_totals` view) from the criterion-wise items – it is never typed in by hand.
- Judges can **save a draft** and **submit**. Drafts count toward completion tracking only; **only submitted scores** enter averages, normalization and rankings.
- Every save is journaled in `score_history` (immutable), so the original judging data is never lost even if a score is revised or deleted by an admin.
- **Normalization** is computed on the fly from raw scores (raw is the only stored truth). Methods, switchable in Settings:
  - `zscore` (default): `(raw − judgeMean) / judgeSD × globalSD + globalMean` – removes both leniency bias and spread differences between judges. Because each team is scored only by its own panel, this also equalises panels: a lenient panel's marks are pulled down and a strict panel's marks pulled up before rankings are formed, so no team gains or loses from which panel it landed in.
  - `panel_zscore`: same formula with both judges of a panel pooled – cancels panel leniency while keeping the two judges' individual differences.
  - `meanshift`: `raw − judgeMean + globalMean` – removes leniency bias only.
  - `minmax`: rescales each judge to 0–100.
  - `none`: normalized = raw.
  - Safeguards: a judge/panel with a single score is left raw; with fewer than 3 scores only the mean shift is applied (the SD is too unstable to rescale by). The dashboard shows a **panel leniency check** and per-judge **bias** (raw mean − global mean) so the correction is transparent.
- **Team score** = mean of its judges' (raw / normalized) totals. Ranking uses competition ranking (1, 2, 2, 4) on the normalized average; the raw rank is shown alongside for transparency.
- Filters (faculty / panel / judge / team) narrow the *view*; normalization and ranks are always computed globally so a filtered page never changes a team's rank.

## Admin dashboard

Dashboard · Overall rankings · Team-wise scores (criterion-wise per judge, raw + normalized) · Judge-wise records (statistics + every score) · Faculty-wise · Panel-wise · Completion status (judge progress + team × judge matrix) · Export (XLSX with all sheets, or CSV per dataset) · Teams (with CSV import) · Judges (create with generated one-time password, reset, deactivate) · Assignments (matrix, bulk, auto-assign by panel) · Panels · Faculties · Criteria · Settings (event name, normalization method, lock judging, allow revising after submit, admin accounts, danger zone) · Audit log.

## Security

- Passwords hashed with bcrypt; sessions stored in SQLite (survive restarts), `httpOnly` + `SameSite=Lax` cookies, `COOKIE_SECURE=1` for HTTPS.
- Role-based access enforced server-side on every API route; judge routes are additionally scoped to the judge's own assignments and scores.
- CSRF guard (origin check + custom header), login rate limiting, strict Content-Security-Policy, no inline scripts.
- Deactivating a user or resetting a password invalidates their sessions immediately.
- Audit log of logins, score saves/submits and every administrative change, with timestamps and IP.

## Deployment notes

- Set a long random `SESSION_SECRET` and a strong `ADMIN_PASSWORD` in `.env`.
- Behind an HTTPS reverse proxy (nginx/Caddy) set `COOKIE_SECURE=1` and `TRUST_PROXY=1`.
- **Vercel: see [DEPLOY.md](DEPLOY.md)** for the full checklist. `api/index.js` and `vercel.json` are already set up; the only hard requirements are `DB_DRIVER=postgres`, `SUPABASE_DB_URL` on the port-6543 transaction pooler, and a real `SESSION_SECRET`.
- On any host (Vercel, Render, Railway, Fly, a VPS) use `DB_DRIVER=postgres` with `SUPABASE_DB_URL`, so the app is stateless and can restart or scale without losing data. `GET /healthz` is a readiness probe that checks the database.
- The app refuses to start on a serverless host with `DB_DRIVER=sqlite`, or with a missing/short `SESSION_SECRET`, rather than losing data or shipping a forgeable session cookie.
- **On SQLite**, the database is a single file (`DB_PATH`, default `data/judging.db`, WAL mode). Back it up by copying the file plus any `-wal`/`-shm` siblings, or export to Excel. Do not put it on a host with an ephemeral filesystem.
- Sessions live in the database, so judges stay logged in across restarts and deploys.
- Scales to any number of teams, faculties, panels and judges; nothing is hard-coded to six judges.

## Project layout

```
api/
  index.js               Vercel serverless entry point
vercel.json              routing, region, function config
DEPLOY.md                step-by-step Vercel deployment checklist
src/
  server.js              Express app, security headers, page routing, admin bootstrap
  db.js                  Driver selection, settings, audit, transactions, error mapping
  drivers/sqlite.js      SQLite driver + schema
  drivers/postgres.js    Supabase/PostgreSQL driver (? -> $n rewriting, pooling, SSL)
  scoring.js             Pure normalization / ranking / analytics engine (unit-tested)
  analytics.js           Loads data and runs the engine
  auth.js                Sessions (DB-backed), role guards, CSRF, login limiter
  routes/auth.js         login / logout / me / change-password
  routes/judge.js        judge-scoped API (assigned teams, own scores)
  routes/admin.js        management + dashboard + audit API
  routes/export.js       XLSX / CSV exports
  seed.js                admin bootstrap + optional demo data
  import-registrations.js  builds the whole event from the Google Form workbook
scripts/
  db-setup.js      applies sql/*.sql to Supabase
  db-check.js      connectivity, row counts, panel sizes
  db-push.js       copies a local SQLite event into Supabase over port 5432
  db-dump.js       exports the event as paste-able SQL (works when 5432 is blocked)
  (sql/003_diagnose.sql reports what is actually in Supabase)
sql/
  001_schema.sql       PostgreSQL schema + RLS lockdown
  002_data.sql         generated by db:dump - your event as INSERT statements
  900_reset_scores.sql wipe scores, keep everything else
  901_drop_all.sql     destructive full reset
views/             login.html, admin.html, judge.html, 404.html
public/            css/app.css, js/api.js, js/login.js, js/admin.js, js/judge.js
                   img/logo.png (optional - replaces the text brand mark)
tests/             scoring, drivers, postgres (real Postgres via PGlite), vercel (serverless entry)
```
