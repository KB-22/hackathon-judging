'use strict';
/**
 * Builds sql/000_setup_all.sql: the schema and the current event data joined
 * into ONE file, so the Supabase SQL Editor only has to be used once.
 *
 *   npm run db:bundle
 *
 * Re-run it whenever the local event data changes.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const schemaFile = path.join(root, 'sql', '001_schema.sql');
const dataFile = path.join(root, 'sql', '002_data.sql');
const outFile = path.join(root, 'sql', '000_setup_all.sql');

// Regenerate the data half from the local database first.
execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(root, 'scripts', 'db-dump.js')],
  { stdio: 'inherit', cwd: root });

const schema = fs.readFileSync(schemaFile, 'utf8');
const data = fs.readFileSync(dataFile, 'utf8');

// The schema ends with a listing query that would split the editor's output;
// drop it so the single file finishes with the verification query instead.
const schemaBody = schema.replace(/-- Sanity check[\s\S]*$/m, '').trimEnd();

const header = `-- ===========================================================================
--  HACK DAYS SOLAN 2026 - COMPLETE SUPABASE SETUP
--  Generated ${new Date().toISOString()}
--
--  RUN THIS ONCE. Supabase Dashboard -> SQL Editor -> New query ->
--  paste everything -> Run.
--
--  It is safe to run again: it recreates missing tables and replaces the
--  judging data with the contents of this file.
--
--  Part 1: tables, the totals view, and the Row Level Security lockdown.
--  Part 2: the event data - teams, judges, panels, assignments.
--  Part 3: a verification query, whose result you should check.
-- ===========================================================================

`;

const footer = `
-- ===========================================================================
--  PART 3 - VERIFY. Expect: teams 60, judges 6, panels 3, assignments 120.
-- ===========================================================================
select 'teams' as item, count(*) as count from public.teams
union all select 'judges',      count(*) from public.users where role = 'judge'
union all select 'admins',      count(*) from public.users where role = 'admin'
union all select 'panels',      count(*) from public.panels
union all select 'assignments', count(*) from public.assignments
union all select 'criteria',    count(*) from public.criteria
union all select 'scores',      count(*) from public.scores
order by item;
`;

const body = [
  header,
  '-- ===========================================================================',
  '--  PART 1 - SCHEMA',
  '-- ===========================================================================',
  schemaBody,
  '',
  '-- ===========================================================================',
  '--  PART 2 - EVENT DATA',
  '-- ===========================================================================',
  data.replace(/^-- =+[\s\S]*?-- =+\n/, ''),   // strip the data file's own header
  footer,
].join('\n');

fs.writeFileSync(outFile, body, 'utf8');
const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`\nBundled schema + data -> ${path.relative(root, outFile)} (${kb} KB)`);
console.log('Paste that single file into the Supabase SQL Editor and run it.');
