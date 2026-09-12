-- Wipe all judging scores but KEEP teams, judges, panels, faculties,
-- score_history and audit_log. Use between a dry run and the real event.
--   psql "$SUPABASE_DB_URL" -f sql/900_reset_scores.sql
begin;
delete from public.scores;          -- score_items cascade
select count(*) as scores_remaining from public.scores;
commit;
