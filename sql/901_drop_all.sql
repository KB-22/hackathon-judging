-- DESTRUCTIVE: drops every judging table so 001_schema.sql can be re-applied
-- from scratch. Everything - teams, judges, scores, history, audit - is lost.
-- Only run this before the event, never during it.
begin;
drop view  if exists public.v_score_totals;
drop table if exists public.score_items   cascade;
drop table if exists public.score_history cascade;
drop table if exists public.scores        cascade;
drop table if exists public.assignments   cascade;
drop table if exists public.teams         cascade;
drop table if exists public.criteria      cascade;
drop table if exists public.users         cascade;
drop table if exists public.panels        cascade;
drop table if exists public.faculties     cascade;
drop table if exists public.audit_log     cascade;
drop table if exists public.settings      cascade;
drop table if exists public.sessions      cascade;
drop function if exists public.judging_now();
commit;
