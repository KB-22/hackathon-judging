# Deploying to Vercel

The app is already configured for Vercel: `api/index.js` is the serverless entry
point, `vercel.json` routes every request to it, and the deployment refuses to
start with insecure defaults. Follow these steps in order.

---

## The one thing that will break everything

**SQLite does not work on Vercel.** Serverless containers have a read-only disk
and are thrown away between requests, so a SQLite database would lose every
score the moment a container recycled. The app now refuses to start with
`DB_DRIVER=sqlite` on a serverless host rather than silently losing data.

**The deployed app must use Supabase.** That means the Supabase database has to
contain your teams, judges and panels *before* the deploy is useful.

---

## Step 1 — Put the data in Supabase

If you have not already done this, open the Supabase Dashboard → **SQL Editor**
and run these two files in order:

1. `sql/001_schema.sql` — creates the 12 tables, the totals view, and the Row
   Level Security lockdown.
2. `sql/002_data.sql` — loads your 60 teams, 6 judges, 3 panels and 120
   assignments. Regenerate it any time with `npm run db:dump`.

Then run `sql/003_diagnose.sql` and confirm you see teams 60, users 7, panels 3,
assignments 120. If the counts are zero the deploy will come up empty.

The bcrypt password hashes migrate with the data, so **the judge logins you have
already handed out keep working**. You do not need to reissue credentials.

---

## Step 2 — Use the transaction pooler, not the session pooler

Serverless scales by starting many short-lived instances, each wanting a
database connection. Supabase has a pooler built for exactly that, on **port
6543**. The session pooler on port 5432 holds one connection per client and will
exhaust under Vercel's scaling.

**On Vercel you must use a pooler host, not the Direct connection.** The direct
host `db.<ref>.supabase.co` resolves over IPv6 only on the free plan, and
Vercel functions cannot be relied on to have IPv6 egress. The pooler hosts are
IPv4. Take the pooler string and change the port from `5432` to `6543`:

```
postgresql://postgres.lfikmecdfjnftvnzlnec:Rahulsingh123%40@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres
```

Two things to be careful about:

- The `@` inside the password **must** stay written as `%40`. Unencoded, the URL
  parser treats it as the separator before the host and the connection fails
  with a confusing error.
- Keep port 5432 in your local `.env` for `npm run db:push` and `db:check`;
  6543 is only for the deployed app.

The app already sets the connection pool to 1 per instance when it detects
Vercel, which is what the transaction pooler expects.

---

## Step 3 — Environment variables in Vercel

> **`NEXT_PUBLIC_*` variables do nothing here.** If you connected the Supabase
> integration to your Vercel project it will have added
> `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
> automatically. Those are for Next.js frontends that talk to Supabase over
> HTTP. This app is a plain Express server that connects straight to Postgres,
> so it ignores them completely. Leaving them set is harmless, but on their own
> they leave the app unconfigured and it will refuse to start.


Project → **Settings → Environment Variables**. Add all of these for the
**Production** environment (and Preview, if you want previews to work):

| Name | Value | Why |
|---|---|---|
| `DB_DRIVER` | `postgres` | SQLite cannot run on Vercel |
| `SUPABASE_DB_URL` | the port-6543 string from step 2 | the database connection |
| `SESSION_SECRET` | 64 random hex characters | signs session cookies |
| `ADMIN_USERNAME` | e.g. `admin` | only used if no admin exists yet |
| `ADMIN_PASSWORD` | a strong password, 10+ characters | only used if no admin exists yet |

Generate the session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**`SESSION_SECRET` is not optional.** Without it the app signs cookies with a
value that is public in this repository, which would let anyone forge an admin
session on your public URL. The app refuses to start if it is missing or shorter
than 32 characters.

You do **not** need `COOKIE_SECURE` or `TRUST_PROXY`; the app detects Vercel and
turns both on automatically.

---

## Step 4 — Deploy

Import the GitHub repository at [vercel.com/new](https://vercel.com/new). Leave
the framework preset as **Other**, and leave the build and output settings
empty — there is no build step.

Or from the CLI:

```bash
npx vercel --prod
```

---

## Step 5 — Verify before you trust it

Visit `https://<your-app>.vercel.app/healthz`. You want:

```json
{ "ok": true, "driver": "postgres", "serverless": true }
```

If startup failed you get a `503` with the exact reason and a hint, instead of a
blank page. Common causes, all of which the response names directly:

| Message contains | Fix |
|---|---|
| `sqlite cannot run on a serverless host` | set `DB_DRIVER=postgres` |
| `SESSION_SECRET must be set` | add the variable, then redeploy |
| `judging tables are missing` | run `sql/001_schema.sql` in Supabase |
| `ADMIN_PASSWORD is unset or shorter` | add a 10+ character password |

Then sign in as admin and check that **Admin → Teams** shows 60 teams and
**Admin → Assignments** shows 120. Have one judge log in and confirm they see
their 20 teams.

---

## Things to be careful about

**Do not run the local server and the Vercel deployment at the same time during
judging.** They are two separate databases. The local one uses SQLite, the
deployed one uses Supabase. Scores entered in one will never appear in the
other. Pick one before judging starts and use only that.

**Region.** `vercel.json` pins functions to `icn1` (Seoul) because your Supabase
project is in `ap-northeast-2` (Seoul). Keeping them together avoids roughly
200 ms of round-trip latency per query, and the dashboard makes several. If your
Vercel plan rejects the region, delete the `"regions"` line and set the region
in Project Settings → Functions instead.

**Function duration.** `vercel.json` sets `maxDuration: 30`. If your plan rejects
it, lower it to `10`. Normal requests take well under a second; the Excel export
is the slowest thing the app does.

**Cold starts.** The first request after idle takes about a second while the
container boots and connects. Judges may see a brief pause on their first page
load. This is normal and not a fault.

**Rate limiting is per-instance.** The 10-failed-logins lockout lives in memory,
so with several concurrent Vercel instances an attacker gets a few more attempts
than on a single server. For a six-judge event this is not a practical concern,
but do not treat the deployed app as hardened against a determined attacker.

**Rotate the database password.** It was shared in plain text during setup.
Supabase Dashboard → Settings → Database → Reset database password, then update
`SUPABASE_DB_URL` in both Vercel and your local `.env`.

**Change the admin password** after the first login, from Settings → My account.

**Do not add RLS policies** to silence the red warnings in the Supabase Table
Editor. Row Level Security is enabled with no policies on purpose: that is what
stops someone with the public anon key from reading every judge's scores
straight from Supabase's REST API, bypassing the app entirely. The backend
connects over the Postgres connection string, which is not subject to RLS.

**`.env` is never deployed.** It is in both `.gitignore` and `.vercelignore`.
Vercel gets its configuration from the environment variables you set in step 3.

---

## After the event

Export the results from **Admin → Export** (one Excel workbook with rankings,
raw scores, normalized scores, judge records and the completion matrix) and keep
a copy. That file is the durable record; it does not depend on Supabase or
Vercel staying up.
