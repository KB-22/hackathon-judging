-- ===========================================================================
--  Supabase health check for the judging system.
--  Paste this whole file into the Supabase SQL Editor and Run.
--  It changes nothing. It reports what is actually in the database.
-- ===========================================================================

-- 1. Row counts per table. After sql/002_data.sql you should see:
--    faculties 2, panels 3, users 7, teams 60, criteria 9, assignments 120.
--    If every count is 0, the schema ran but the DATA file did not.
select 'faculties'     as table_name, count(*) as rows from public.faculties
union all select 'panels',        count(*) from public.panels
union all select 'users',         count(*) from public.users
union all select 'teams',         count(*) from public.teams
union all select 'criteria',      count(*) from public.criteria
union all select 'assignments',   count(*) from public.assignments
union all select 'scores',        count(*) from public.scores
union all select 'score_items',   count(*) from public.score_items
union all select 'score_history', count(*) from public.score_history
union all select 'audit_log',     count(*) from public.audit_log
union all select 'settings',      count(*) from public.settings
order by table_name;

-- 2. Event settings. event_name should read "Hack Days Solan 2026".
select key, value from public.settings order by key;

-- 3. Panels: each should have 20 teams and 2 judges.
select p.name as panel,
       (select count(*) from public.teams t where t.panel_id = p.id) as teams,
       (select count(*) from public.users u where u.panel_id = p.id and u.role = 'judge') as judges
from public.panels p
order by p.name;

-- 4. Judges and how many teams each is assigned.
select u.username, u.name, p.name as panel,
       (select count(*) from public.assignments a where a.judge_id = u.id) as assigned_teams
from public.users u
left join public.panels p on p.id = u.panel_id
where u.role = 'judge'
order by p.name, u.username;

-- 5. First five teams, to confirm the import carried members and descriptions.
select code, name, left(coalesce(project_title,''), 40) as project,
       length(coalesce(description,'')) as description_chars,
       left(coalesce(members,''), 45) as members
from public.teams
order by code
limit 5;

-- 6. The 9-criterion rubric. max_marks must total 100.
select name, max_marks from public.criteria where is_active = 1 order by sort_order;
select sum(max_marks) as rubric_total from public.criteria where is_active = 1;

-- 7. Security posture. Every table must show rls_enabled = true and
--    policies = 0, which is what keeps the public anon key locked out.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies pp
         where pp.schemaname = 'public' and pp.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- 8. Columns actually present on teams (confirms `description` exists).
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'teams'
order by ordinal_position;
