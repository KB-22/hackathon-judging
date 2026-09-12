'use strict';
/** Excel / CSV exports of the admin analytics. Admin only. */
const express = require('express');
const analytics = require('../analytics');
const { requireRole, ah } = require('../auth');

const router = express.Router();
router.use(requireRole('admin'));

function filtersFrom(q) {
  const out = {};
  for (const k of ['faculty_id', 'panel_id', 'judge_id', 'team_id']) if (q[k] !== undefined && q[k] !== '') out[k] = Number(q[k]);
  return out;
}

/** Turns the analytics object into flat tables: { key: { title, columns:[{key,label}], rows:[{}] } } */
function buildTables(a) {
  const crit = a.criteria;
  const critCols = crit.map(c => ({ key: `c${c.id}`, label: `${c.name} (${c.max_marks})` }));
  const critVals = (obj) => Object.fromEntries(crit.map(c => [`c${c.id}`, obj?.[c.id] ?? null]));
  const judgeByid = new Map(a.judges.map(j => [j.id, j]));

  const rankings = {
    title: 'Rankings',
    columns: [
      { key: 'rank_norm', label: 'Rank (Normalized)' }, { key: 'rank_raw', label: 'Rank (Raw)' },
      { key: 'code', label: 'Team Code' }, { key: 'name', label: 'Team' }, { key: 'project_title', label: 'Project' },
      { key: 'faculty_name', label: 'Faculty' }, { key: 'panel_name', label: 'Panel' },
      { key: 'assigned_count', label: 'Judges Assigned' }, { key: 'submitted_count', label: 'Judges Submitted' },
      { key: 'raw_avg', label: 'Raw Avg /100' }, { key: 'norm_avg', label: 'Normalized Avg' },
      { key: 'raw_min', label: 'Raw Min' }, { key: 'raw_max', label: 'Raw Max' }, { key: 'raw_sd', label: 'Raw SD' },
      ...critCols.map(c => ({ key: c.key, label: `Avg ${c.label}` })),
    ],
    rows: a.teams.map(t => ({ ...t, ...critVals(t.criterion_avg) })),
  };

  const scores = {
    title: 'Raw Scores (Judge x Team)',
    columns: [
      { key: 'judge_name', label: 'Judge' }, { key: 'judge_username', label: 'Judge Username' }, { key: 'judge_panel', label: 'Judge Panel' },
      { key: 'team_code', label: 'Team Code' }, { key: 'team_name', label: 'Team' }, { key: 'faculty_name', label: 'Team Faculty' }, { key: 'panel_name', label: 'Team Panel' },
      ...critCols, { key: 'total', label: 'Raw Total /100' }, { key: 'normalized', label: 'Normalized' },
      { key: 'status', label: 'Status' }, { key: 'submitted_at', label: 'Submitted At' }, { key: 'updated_at', label: 'Last Updated' }, { key: 'comments', label: 'Comments' },
    ],
    rows: a.scores.slice().sort((x, y) => x.judge_name.localeCompare(y.judge_name) || x.team_name.localeCompare(y.team_name)).map(s => ({
      ...s, judge_username: judgeByid.get(s.judge_id)?.username ?? null, judge_panel: judgeByid.get(s.judge_id)?.panel_name ?? null,
      faculty_name: a.faculties.find(f => f.id === s.faculty_id)?.name ?? null, panel_name: a.panels.find(p => p.id === s.panel_id)?.name ?? null,
      ...critVals(s.items),
    })),
  };

  const judges = {
    title: 'Judge Records',
    columns: [
      { key: 'name', label: 'Judge' }, { key: 'username', label: 'Username' }, { key: 'panel_name', label: 'Panel' }, { key: 'faculty_name', label: 'Faculty' },
      { key: 'assigned_count', label: 'Assigned' }, { key: 'submitted_count', label: 'Submitted' }, { key: 'draft_count', label: 'Drafts' }, { key: 'pending_count', label: 'Pending' },
      { key: 'completion_pct', label: 'Completion %' }, { key: 'raw_mean', label: 'Raw Mean' }, { key: 'raw_sd', label: 'Raw SD' }, { key: 'raw_min', label: 'Raw Min' }, { key: 'raw_max', label: 'Raw Max' },
      { key: 'norm_mean', label: 'Normalized Mean' }, { key: 'last_login_at', label: 'Last Login' },
      ...critCols.map(c => ({ key: c.key, label: `Mean ${c.label}` })),
    ],
    rows: a.judges.map(j => ({ ...j, ...critVals(j.criterion_mean) })),
  };

  const groupCols = [
    { key: 'name', label: 'Name' }, { key: 'team_count', label: 'Teams' }, { key: 'teams_scored', label: 'Teams Scored' }, { key: 'teams_complete', label: 'Teams Fully Judged' },
    { key: 'judge_count', label: 'Judges' }, { key: 'scores_submitted', label: 'Scores Submitted' }, { key: 'scores_expected', label: 'Scores Expected' },
    { key: 'raw_avg', label: 'Raw Avg' }, { key: 'raw_sd', label: 'Raw SD' }, { key: 'norm_avg', label: 'Normalized Avg' }, { key: 'norm_sd', label: 'Normalized SD' },
    { key: 'best_rank', label: 'Best Rank' }, { key: 'top_team_name', label: 'Top Team' }, { key: 'top_team_norm', label: 'Top Team Normalized' },
    ...critCols.map(c => ({ key: c.key, label: `Avg ${c.label}` })),
  ];
  const groupRows = list => list.map(g => ({ ...g, top_team_name: g.top_team?.name ?? null, top_team_norm: g.top_team?.norm_avg ?? null, ...critVals(g.criterion_avg) }));
  const faculties = { title: 'Faculty Summary', columns: [{ key: 'code', label: 'Code' }, ...groupCols], rows: groupRows(a.faculty_stats) };
  const panels = { title: 'Panel Summary', columns: groupCols, rows: groupRows(a.panel_stats) };

  const completion = {
    title: 'Completion Status',
    columns: [
      { key: 'judge_name', label: 'Judge' }, { key: 'team_code', label: 'Team Code' }, { key: 'team_name', label: 'Team' },
      { key: 'status', label: 'Status' }, { key: 'total', label: 'Raw Total' }, { key: 'normalized', label: 'Normalized' }, { key: 'submitted_at', label: 'Submitted At' }, { key: 'updated_at', label: 'Last Updated' },
    ],
    rows: a.completion.slice().sort((x, y) => (x.judge_name || '').localeCompare(y.judge_name || '') || (x.team_name || '').localeCompare(y.team_name || '')),
  };

  // Wide matrices: teams x judges
  const jCols = a.judges.map(j => ({ key: `j${j.id}`, label: j.name }));
  const matrixRows = (field) => a.teams.map(t => {
    const row = { rank_norm: t.rank_norm, code: t.code, name: t.name, faculty_name: t.faculty_name, panel_name: t.panel_name, raw_avg: t.raw_avg, norm_avg: t.norm_avg };
    for (const j of a.judges) row[`j${j.id}`] = t.judge_scores.find(s => s.judge_id === j.id)?.[field] ?? null;
    return row;
  });
  const matrixCols = [{ key: 'rank_norm', label: 'Rank' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Team' }, { key: 'faculty_name', label: 'Faculty' }, { key: 'panel_name', label: 'Panel' }, ...jCols, { key: 'raw_avg', label: 'Raw Avg' }, { key: 'norm_avg', label: 'Normalized Avg' }];
  const matrixRaw = { title: 'Matrix Raw (Team x Judge)', columns: matrixCols, rows: matrixRows('total') };
  const matrixNorm = { title: 'Matrix Normalized (Team x Judge)', columns: matrixCols, rows: matrixRows('normalized') };

  const criteria = {
    title: 'Criteria Statistics',
    columns: [{ key: 'name', label: 'Criterion' }, { key: 'max_marks', label: 'Max' }, { key: 'mean', label: 'Mean' }, { key: 'sd', label: 'SD' }, { key: 'pct_of_max', label: '% of Max' }, { key: 'count', label: 'Scores' }],
    rows: a.criteria_stats,
  };

  const summary = {
    title: 'Summary',
    columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }],
    rows: [
      ['Event', a.settings.event_name], ['Generated At', a.generated_at], ['Normalization Method', a.method],
      ['Teams', a.overall.teams], ['Judges', a.overall.judges], ['Faculties', a.overall.faculties], ['Panels', a.overall.panels],
      ['Assignments (expected scores)', a.overall.assignments], ['Scores Submitted', a.overall.submitted], ['Drafts', a.overall.drafts], ['Pending', a.overall.pending],
      ['Completion %', a.overall.completion_pct], ['Teams Fully Judged', a.overall.teams_fully_judged], ['Teams Unscored', a.overall.teams_unscored],
      ['Raw Mean', a.overall.raw_mean], ['Raw SD', a.overall.raw_sd], ['Raw Min', a.overall.raw_min], ['Raw Max', a.overall.raw_max],
      ['Normalized Mean', a.overall.norm_mean], ['Normalized SD', a.overall.norm_sd],
      ['Filters', Object.keys(a.filters || {}).length ? JSON.stringify(a.filters) : 'none'],
    ].map(([metric, value]) => ({ metric, value })),
  };

  return { summary, rankings, matrixRaw, matrixNorm, scores, judges, faculties, panels, completion, criteria };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(table) {
  const lines = [table.columns.map(c => csvEscape(c.label)).join(',')];
  for (const r of table.rows) lines.push(table.columns.map(c => csvEscape(r[c.key])).join(','));
  return '﻿' + lines.join('\r\n');
}
function fileStamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

router.get('/csv', ah(async (req, res) => {
  const a = await analytics.dashboard(filtersFrom(req.query));
  const tables = buildTables(a);
  const key = tables[req.query.dataset] ? req.query.dataset : 'rankings';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${key}-${fileStamp()}.csv"`);
  res.send(toCsv(tables[key]));
}));

router.get('/xlsx', ah(async (req, res) => {
  // Loaded on demand: ExcelJS is the heaviest dependency and only the workbook
  // export needs it, so it stays out of every serverless cold start.
  const ExcelJS = require('exceljs');
  const a = await analytics.dashboard(filtersFrom(req.query));
  const tables = buildTables(a);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hackathon Judging System';
  wb.created = new Date();
  for (const t of Object.values(tables)) {
    const ws = wb.addWorksheet(t.title.slice(0, 31));
    ws.columns = t.columns.map(c => ({ header: c.label, key: c.key, width: Math.min(Math.max(c.label.length + 2, 10), 40) }));
    for (const r of t.rows) ws.addRow(Object.fromEntries(t.columns.map(c => [c.key, r[c.key] ?? null])));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.columns.length } };
  }
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="hackathon-judging-${fileStamp()}.xlsx"`);
  res.send(Buffer.from(buf));
}));

module.exports = router;
module.exports.buildTables = buildTables;
