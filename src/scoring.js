'use strict';
/**
 * Pure scoring & analytics engine. No database access - fully unit-testable.
 *
 * Normalisation methods (applied per judge, on the judge's raw totals out of 100):
 *  - zscore    : (raw - judgeMean) / judgeSD * globalSD + globalMean   (default; removes bias AND spread differences)
 *  - meanshift : raw - judgeMean + globalMean                            (removes lenient/strict bias only)
 *  - minmax    : (raw - judgeMin) / (judgeMax - judgeMin) * 100          (rescales each judge to 0..100)
 *  - none      : raw
 * A judge with fewer than 2 submitted scores cannot be normalised; raw is used as-is.
 * Only SUBMITTED scores participate in normalisation and aggregates. Drafts count toward completion only.
 */

const METHODS = ['zscore', 'panel_zscore', 'meanshift', 'minmax', 'none'];
/** Below this many scores a group's SD is too unstable to rescale by, so z-score methods fall back to a mean shift. */
const MIN_SCORES_FOR_SD = 3;

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function stddev(a, m) {
  if (a.length < 2) return 0;
  const mu = m == null ? mean(a) : m;
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length); // population SD
}
function round(x, d = 2) { return x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d; }

/** Per-group statistics of raw totals. keyOf(score) decides the group (judge by default). */
function groupStatistics(scores, keyOf = s => s.judge_id) {
  const by = new Map();
  for (const s of scores) {
    const k = keyOf(s);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s.total);
  }
  const out = new Map();
  for (const [k, totals] of by) {
    const m = mean(totals);
    out.set(k, { count: totals.length, mean: m, sd: stddev(totals, m), min: Math.min(...totals), max: Math.max(...totals) });
  }
  return out;
}
const judgeStatistics = scores => groupStatistics(scores);

/**
 * Adds `normalized` to each submitted score. Returns new array; input untouched.
 *  - zscore       : group = judge. Each judge's marks are re-centred to the global mean and re-scaled to the global SD.
 *                   Because a team is only ever scored by its own panel, this also equalises panels: a lenient
 *                   panel's judges are pulled down, a strict panel's judges pulled up, before rankings are formed.
 *  - panel_zscore : group = panel (both judges of a panel pooled). Corrects panel leniency but keeps
 *                   within-panel differences between the two judges.
 *  - meanshift    : group = judge, shift only (no rescaling of spread).
 *  - minmax       : group = judge, stretched to 0..100.
 *  - none         : raw.
 * Groups with fewer than MIN_SCORES_FOR_SD scores are only mean-shifted (SD unreliable); groups with 1 score stay raw.
 * `judges` (with panel_id) is only needed for panel_zscore.
 */
function normalizeScores(scores, method = 'zscore', judges = []) {
  if (!METHODS.includes(method)) method = 'zscore';
  const totals = scores.map(s => s.total);
  const gMean = mean(totals);
  const gSd = stddev(totals, gMean);
  const panelOf = new Map(judges.map(j => [j.id, j.panel_id == null ? `judge:${j.id}` : `panel:${j.panel_id}`]));
  const keyOf = method === 'panel_zscore' ? (s => panelOf.get(s.judge_id) ?? `judge:${s.judge_id}`) : (s => s.judge_id);
  const stats = groupStatistics(scores, keyOf);
  return scores.map(s => {
    const st = stats.get(keyOf(s));
    let n = s.total;
    if (st && st.count >= 2) {
      switch (method) {
        case 'meanshift': n = s.total - st.mean + gMean; break;
        case 'minmax': n = st.max === st.min ? 50 : (s.total - st.min) / (st.max - st.min) * 100; break;
        case 'none': n = s.total; break;
        default: // zscore / panel_zscore
          if (st.count < MIN_SCORES_FOR_SD || st.sd === 0 || gSd === 0) n = s.total - st.mean + gMean;
          else n = (s.total - st.mean) / st.sd * gSd + gMean;
      }
    }
    return { ...s, normalized: round(n, 3) };
  });
}

/** Standard competition ranking (1,2,2,4). items must have `id`; returns Map id -> rank. */
function rank(items, valueOf) {
  const sorted = items.filter(i => valueOf(i) != null).sort((a, b) => valueOf(b) - valueOf(a));
  const out = new Map();
  let prev = null, prevRank = 0;
  sorted.forEach((it, idx) => {
    const v = valueOf(it);
    const r = (prev !== null && v === prev) ? prevRank : idx + 1;
    out.set(it.id, r);
    prev = v; prevRank = r;
  });
  return out;
}

/**
 * Full analytics.
 * @param data { teams, judges, faculties, panels, criteria, assignments:[{judge_id,team_id}], scores:[{judge_id,team_id,status,total,items:{cid:marks},...}] }
 * @param method normalization method
 * @param filters { faculty_id, panel_id, judge_id, team_id } (optional; applied AFTER global normalisation & ranking)
 */
function computeAnalytics(data, method = 'zscore', filters = {}) {
  const { teams, judges, faculties, panels, criteria, assignments } = data;
  const fMap = new Map(faculties.map(f => [f.id, f]));
  const pMap = new Map(panels.map(p => [p.id, p]));
  const jMap = new Map(judges.map(j => [j.id, j]));
  const tMap = new Map(teams.map(t => [t.id, t]));

  const submitted = data.scores.filter(s => s.status === 'submitted');
  const drafts = data.scores.filter(s => s.status !== 'submitted');
  const globalRawMean = submitted.length ? mean(submitted.map(s => s.total)) : 0;
  const normalized = normalizeScores(submitted, method, judges).map(s => ({
    ...s,
    judge_name: jMap.get(s.judge_id)?.name ?? `Judge #${s.judge_id}`,
    judge_panel_id: jMap.get(s.judge_id)?.panel_id ?? null,
    team_name: tMap.get(s.team_id)?.name ?? `Team #${s.team_id}`,
    team_code: tMap.get(s.team_id)?.code ?? null,
    faculty_id: tMap.get(s.team_id)?.faculty_id ?? null,
    panel_id: tMap.get(s.team_id)?.panel_id ?? null,
  }));

  // ---- team aggregates (global) ----
  const assignByTeam = new Map(), assignByJudge = new Map();
  for (const a of assignments) {
    if (!assignByTeam.has(a.team_id)) assignByTeam.set(a.team_id, []);
    assignByTeam.get(a.team_id).push(a.judge_id);
    if (!assignByJudge.has(a.judge_id)) assignByJudge.set(a.judge_id, []);
    assignByJudge.get(a.judge_id).push(a.team_id);
  }
  const subByTeam = new Map(), draftByTeam = new Map();
  for (const s of normalized) { if (!subByTeam.has(s.team_id)) subByTeam.set(s.team_id, []); subByTeam.get(s.team_id).push(s); }
  for (const s of drafts) { if (!draftByTeam.has(s.team_id)) draftByTeam.set(s.team_id, []); draftByTeam.get(s.team_id).push(s); }

  let teamStats = teams.map(t => {
    const sc = subByTeam.get(t.id) || [];
    const assigned = assignByTeam.get(t.id) || [];
    const critAvg = {};
    for (const c of criteria) {
      const vals = sc.map(s => s.items?.[c.id]).filter(v => v != null);
      critAvg[c.id] = vals.length ? round(mean(vals), 2) : null;
    }
    const rawTotals = sc.map(s => s.total);
    const normTotals = sc.map(s => s.normalized);
    return {
      ...t,
      faculty_name: fMap.get(t.faculty_id)?.name ?? null,
      panel_name: pMap.get(t.panel_id)?.name ?? null,
      assigned_judge_ids: assigned,
      assigned_count: assigned.length,
      submitted_count: sc.length,
      draft_count: (draftByTeam.get(t.id) || []).length,
      pending_count: Math.max(0, assigned.length - sc.length),
      is_complete: assigned.length > 0 && sc.length >= assigned.length,
      raw_avg: rawTotals.length ? round(mean(rawTotals), 2) : null,
      raw_min: rawTotals.length ? Math.min(...rawTotals) : null,
      raw_max: rawTotals.length ? Math.max(...rawTotals) : null,
      raw_sd: rawTotals.length ? round(stddev(rawTotals), 2) : null,
      norm_avg: normTotals.length ? round(mean(normTotals), 2) : null,
      criterion_avg: critAvg,
      judge_scores: sc.map(s => ({ judge_id: s.judge_id, judge_name: s.judge_name, total: s.total, normalized: s.normalized, submitted_at: s.submitted_at })),
    };
  });
  const rankNorm = rank(teamStats, t => t.norm_avg);
  const rankRaw = rank(teamStats, t => t.raw_avg);
  teamStats = teamStats.map(t => ({ ...t, rank_norm: rankNorm.get(t.id) ?? null, rank_raw: rankRaw.get(t.id) ?? null }));

  // ---- apply filters (view-level only; normalisation & ranks stay global) ----
  const f = filters || {};
  const num = v => (v === undefined || v === null || v === '' ? null : Number(v));
  const fFac = num(f.faculty_id), fPan = num(f.panel_id), fJud = num(f.judge_id), fTeam = num(f.team_id);

  let vTeams = teamStats;
  if (fFac != null) vTeams = vTeams.filter(t => t.faculty_id === fFac);
  if (fPan != null) vTeams = vTeams.filter(t => t.panel_id === fPan);
  if (fTeam != null) vTeams = vTeams.filter(t => t.id === fTeam);
  if (fJud != null) vTeams = vTeams.filter(t => t.assigned_judge_ids.includes(fJud) || (subByTeam.get(t.id) || []).some(s => s.judge_id === fJud));
  const vTeamIds = new Set(vTeams.map(t => t.id));

  let vJudges = judges;
  if (fJud != null) vJudges = vJudges.filter(j => j.id === fJud);
  if (fPan != null) vJudges = vJudges.filter(j => j.panel_id === fPan || (assignByJudge.get(j.id) || []).some(tid => vTeamIds.has(tid)));
  if (fFac != null || fTeam != null) vJudges = vJudges.filter(j => (assignByJudge.get(j.id) || []).some(tid => vTeamIds.has(tid)));
  const vJudgeIds = new Set(vJudges.map(j => j.id));

  const vScores = normalized.filter(s => vTeamIds.has(s.team_id) && vJudgeIds.has(s.judge_id));
  const vDrafts = drafts.filter(s => vTeamIds.has(s.team_id) && vJudgeIds.has(s.judge_id));
  const vAssignments = assignments.filter(a => vTeamIds.has(a.team_id) && vJudgeIds.has(a.judge_id));

  // ---- judge stats (mean/sd basis from the judge's full submitted set; counts on the filtered view) ----
  const globalJS = judgeStatistics(submitted);
  const judgeStats = vJudges.map(j => {
    const mine = vScores.filter(s => s.judge_id === j.id);
    const myAssigned = vAssignments.filter(a => a.judge_id === j.id).length;
    const myDrafts = vDrafts.filter(s => s.judge_id === j.id).length;
    const gs = globalJS.get(j.id);
    const critMean = {};
    for (const c of criteria) {
      const vals = mine.map(s => s.items?.[c.id]).filter(v => v != null);
      critMean[c.id] = vals.length ? round(mean(vals), 2) : null;
    }
    return {
      id: j.id, name: j.name, username: j.username, email: j.email, is_active: j.is_active,
      panel_id: j.panel_id, panel_name: pMap.get(j.panel_id)?.name ?? null,
      faculty_id: j.faculty_id, faculty_name: fMap.get(j.faculty_id)?.name ?? null,
      last_login_at: j.last_login_at,
      assigned_count: myAssigned,
      submitted_count: mine.length,
      draft_count: myDrafts,
      pending_count: Math.max(0, myAssigned - mine.length),
      completion_pct: myAssigned ? round(mine.length / myAssigned * 100, 1) : null,
      raw_mean: mine.length ? round(mean(mine.map(s => s.total)), 2) : null,
      raw_sd: mine.length ? round(stddev(mine.map(s => s.total)), 2) : null,
      raw_min: mine.length ? Math.min(...mine.map(s => s.total)) : null,
      raw_max: mine.length ? Math.max(...mine.map(s => s.total)) : null,
      norm_mean: mine.length ? round(mean(mine.map(s => s.normalized)), 2) : null,
      overall_mean: gs ? round(gs.mean, 2) : null,   // across everything the judge submitted (basis for normalisation)
      overall_sd: gs ? round(gs.sd, 2) : null,
      overall_count: gs ? gs.count : 0,
      bias: gs ? round(gs.mean - globalRawMean, 2) : null, // +ve = lenient, -ve = strict (removed by normalisation)
      criterion_mean: critMean,
    };
  });

  // ---- group aggregates ----
  function groupStats(list, keyOf, groupTeams) {
    return list.map(g => {
      const gTeams = groupTeams(g);
      const scored = gTeams.filter(t => t.norm_avg != null);
      const gScores = vScores.filter(s => gTeams.some(t => t.id === s.team_id));
      const top = scored.slice().sort((a, b) => b.norm_avg - a.norm_avg)[0] || null;
      const critAvg = {};
      for (const c of criteria) {
        const vals = gScores.map(s => s.items?.[c.id]).filter(v => v != null);
        critAvg[c.id] = vals.length ? round(mean(vals), 2) : null;
      }
      return {
        ...g,
        team_count: gTeams.length,
        teams_scored: scored.length,
        teams_complete: gTeams.filter(t => t.is_complete).length,
        judge_count: vJudges.filter(j => keyOf(j) === g.id).length,
        scores_submitted: gScores.length,
        scores_expected: vAssignments.filter(a => gTeams.some(t => t.id === a.team_id)).length,
        raw_avg: gScores.length ? round(mean(gScores.map(s => s.total)), 2) : null,
        raw_sd: gScores.length ? round(stddev(gScores.map(s => s.total)), 2) : null,
        raw_bias: gScores.length ? round(mean(gScores.map(s => s.total)) - globalRawMean, 2) : null, // leniency vs global raw mean
        norm_avg: gScores.length ? round(mean(gScores.map(s => s.normalized)), 2) : null,
        norm_sd: gScores.length ? round(stddev(gScores.map(s => s.normalized)), 2) : null,
        best_rank: scored.length ? Math.min(...scored.map(t => t.rank_norm)) : null,
        top_team: top ? { id: top.id, name: top.name, code: top.code, norm_avg: top.norm_avg, raw_avg: top.raw_avg, rank_norm: top.rank_norm } : null,
        criterion_avg: critAvg,
        teams: scored.slice().sort((a, b) => (a.rank_norm ?? 1e9) - (b.rank_norm ?? 1e9))
          .map(t => ({ id: t.id, name: t.name, code: t.code, raw_avg: t.raw_avg, norm_avg: t.norm_avg, rank_norm: t.rank_norm, rank_raw: t.rank_raw, submitted_count: t.submitted_count, assigned_count: t.assigned_count })),
      };
    });
  }
  const facultyStats = groupStats(faculties, j => j.faculty_id, g => vTeams.filter(t => t.faculty_id === g.id));
  const panelStats = groupStats(panels, j => j.panel_id, g => vTeams.filter(t => t.panel_id === g.id));

  // ---- criteria stats ----
  const criteriaStats = criteria.map(c => {
    const vals = vScores.map(s => s.items?.[c.id]).filter(v => v != null);
    return { ...c, mean: vals.length ? round(mean(vals), 2) : null, sd: vals.length ? round(stddev(vals), 2) : null,
      pct_of_max: vals.length ? round(mean(vals) / c.max_marks * 100, 1) : null, count: vals.length };
  });

  const allRaw = vScores.map(s => s.total);
  const allNorm = vScores.map(s => s.normalized);
  const overall = {
    method,
    teams: vTeams.length,
    judges: vJudges.length,
    faculties: faculties.length,
    panels: panels.length,
    assignments: vAssignments.length,
    submitted: vScores.length,
    drafts: vDrafts.length,
    pending: Math.max(0, vAssignments.length - vScores.length),
    completion_pct: vAssignments.length ? round(vScores.length / vAssignments.length * 100, 1) : 0,
    teams_fully_judged: vTeams.filter(t => t.is_complete).length,
    teams_unscored: vTeams.filter(t => t.submitted_count === 0).length,
    teams_unassigned: vTeams.filter(t => t.assigned_count === 0).length,
    judges_complete: judgeStats.filter(j => j.assigned_count > 0 && j.pending_count === 0).length,
    raw_mean: allRaw.length ? round(mean(allRaw), 2) : null,
    raw_sd: allRaw.length ? round(stddev(allRaw), 2) : null,
    raw_min: allRaw.length ? Math.min(...allRaw) : null,
    raw_max: allRaw.length ? Math.max(...allRaw) : null,
    norm_mean: allNorm.length ? round(mean(allNorm), 2) : null,
    norm_sd: allNorm.length ? round(stddev(allNorm), 2) : null,
    global_raw_mean: submitted.length ? round(mean(submitted.map(s => s.total)), 2) : null,
    global_raw_sd: submitted.length ? round(stddev(submitted.map(s => s.total)), 2) : null,
    global_submitted: submitted.length,
  };

  // Completion matrix rows for the view
  const completion = vAssignments.map(a => {
    const sub = vScores.find(s => s.judge_id === a.judge_id && s.team_id === a.team_id);
    const dr = sub ? null : vDrafts.find(s => s.judge_id === a.judge_id && s.team_id === a.team_id);
    return {
      judge_id: a.judge_id, judge_name: jMap.get(a.judge_id)?.name ?? null,
      team_id: a.team_id, team_name: tMap.get(a.team_id)?.name ?? null, team_code: tMap.get(a.team_id)?.code ?? null,
      status: sub ? 'submitted' : dr ? 'draft' : 'pending',
      total: sub ? sub.total : null, normalized: sub ? sub.normalized : null,
      submitted_at: sub?.submitted_at ?? null, updated_at: sub?.updated_at ?? dr?.updated_at ?? null,
    };
  });

  return {
    method, criteria, faculties, panels,
    overall,
    teams: vTeams.slice().sort((a, b) => (a.rank_norm ?? 1e9) - (b.rank_norm ?? 1e9) || a.name.localeCompare(b.name)),
    judges: judgeStats,
    scores: vScores,
    drafts: vDrafts.map(s => ({ judge_id: s.judge_id, team_id: s.team_id, updated_at: s.updated_at, total: s.total })),
    faculty_stats: facultyStats,
    panel_stats: panelStats,
    criteria_stats: criteriaStats,
    completion,
  };
}

module.exports = { METHODS, MIN_SCORES_FOR_SD, mean, stddev, round, normalizeScores, judgeStatistics, groupStatistics, rank, computeAnalytics };
