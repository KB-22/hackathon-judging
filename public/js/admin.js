/* Admin console: analytics dashboards + management. Hash-routed single page, no framework. */
(function () {
  'use strict';
  const { esc, fmt, fmtDate, fmtDateFull, toast, modal, confirm, options, dataTable, badge, statusBadge } = UI;
  const $ = id => document.getElementById(id);
  const view = $('view');

  const ANALYTICS = new Set(['dashboard', 'rankings', 'team-scores', 'judge-records', 'faculty-stats', 'panel-stats', 'completion', 'export']);
  const METHOD_INFO = {
    zscore: 'Per-judge z-score (recommended): every judge\'s marks are re-centred to the global mean and re-scaled to the global spread. Since a team is scored only by its own panel, this also cancels panel leniency - a lenient or strict panel cannot advantage or disadvantage its teams.',
    panel_zscore: 'Per-panel z-score: both judges of a panel are pooled and the panel\'s marks are re-centred/re-scaled to the global distribution. Cancels panel leniency but keeps differences between the two judges of a panel.',
    meanshift: 'Mean shift: each judge\'s scores are shifted so their average equals the global average. Removes leniency bias only, spread is untouched.',
    minmax: 'Min-max: each judge\'s scores are stretched to 0-100 between their lowest and highest score.',
    none: 'None: normalized scores equal the raw scores.',
  };
  const state = { me: null, meta: null, dash: null, filters: {}, route: null, loading: false };

  // ---------------- bootstrap ----------------
  async function init() {
    const me = await API.get('/api/auth/me');
    state.me = me.user;
    $('whoami').textContent = me.user.name;
    UI.applyBranding(me.logo);
    await loadMeta();
    bindFilterBar();
    window.addEventListener('hashchange', navigate);
    $('navToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    $('sidebar').addEventListener('click', e => { if (e.target.tagName === 'A') $('sidebar').classList.remove('open'); });
    $('logoutBtn').addEventListener('click', async () => { await API.post('/api/auth/logout'); location.href = '/'; });
    $('refreshBtn').addEventListener('click', () => refresh(true));
    setInterval(() => { if ($('autoRefresh').checked && ANALYTICS.has(state.route) && !document.querySelector('.modal-backdrop')) refresh(false); }, 30000);
    await navigate();
    if (me.user.must_change_password) { toast('Please change the default admin password.', 'warn', 6000); changePasswordModal(); }
  }

  async function loadMeta() {
    state.meta = await API.get('/api/admin/meta');
    $('eventName').textContent = state.meta.settings.event_name;
    $('lockBadge').hidden = !state.meta.settings.judging_locked;
    const m = state.meta, f = state.filters;
    $('fFaculty').innerHTML = options(m.faculties, f.faculty_id, 'All faculties');
    $('fPanel').innerHTML = options(m.panels, f.panel_id, 'All panels');
    $('fJudge').innerHTML = options(m.judges, f.judge_id, 'All judges');
    $('fTeam').innerHTML = options(m.teams, f.team_id, 'All teams', t => `${t.code ? t.code + ' · ' : ''}${t.name}`);
  }
  function bindFilterBar() {
    const map = { fFaculty: 'faculty_id', fPanel: 'panel_id', fJudge: 'judge_id', fTeam: 'team_id' };
    for (const [id, key] of Object.entries(map)) $(id).addEventListener('change', e => { if (e.target.value) state.filters[key] = e.target.value; else delete state.filters[key]; refresh(true); });
    $('fClear').addEventListener('click', () => { state.filters = {}; for (const id of Object.keys(map)) $(id).value = ''; refresh(true); });
  }
  const qs = () => { const p = new URLSearchParams(state.filters); const s = p.toString(); return s ? `?${s}` : ''; };
  async function loadDash() {
    state.dash = await API.get(`/api/admin/dashboard${qs()}`);
    $('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    $('lockBadge').hidden = !state.dash.settings.judging_locked;
  }
  async function refresh(showToast) {
    try { await loadMeta(); if (ANALYTICS.has(state.route)) await loadDash(); await render(); if (showToast) toast('Refreshed', 'ok', 1200); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function navigate() {
    const r = (location.hash || '#dashboard').slice(1);
    state.route = renderers[r] ? r : 'dashboard';
    document.querySelectorAll('.sidebar a').forEach(a => a.classList.toggle('active', a.dataset.route === state.route));
    $('filterBar').hidden = !ANALYTICS.has(state.route);
    view.innerHTML = '<div class="empty">Loading…</div>';
    try { if (ANALYTICS.has(state.route)) await loadDash(); await render(); }
    catch (e) { view.innerHTML = `<div class="card"><div class="form-error">${esc(e.message)}</div></div>`; }
  }
  async function render() { await renderers[state.route](); }

  // ---------------- shared bits ----------------
  const filterSummary = () => {
    const m = state.meta, f = state.filters, parts = [];
    if (f.faculty_id) parts.push('Faculty: ' + (m.faculties.find(x => x.id == f.faculty_id)?.name || f.faculty_id));
    if (f.panel_id) parts.push('Panel: ' + (m.panels.find(x => x.id == f.panel_id)?.name || f.panel_id));
    if (f.judge_id) parts.push('Judge: ' + (m.judges.find(x => x.id == f.judge_id)?.name || f.judge_id));
    if (f.team_id) parts.push('Team: ' + (m.teams.find(x => x.id == f.team_id)?.name || f.team_id));
    return parts.length ? `<span class="badge primary">Filtered · ${esc(parts.join(' · '))}</span>` : '';
  };
  const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h1>${esc(title)}</h1><p class="muted">${sub} ${filterSummary()}</p></div><div class="toolbar" style="margin:0">${actions}</div></div>`;
  const stat = (label, value, sub = '') => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const rankCell = r => r == null ? '<span class="muted">—</span>' : `<span class="rank rank-${r}">#${r}</span>`;
  const progressCell = (done, total) => { const pct = total ? Math.round(done / total * 100) : 0; return `<div class="progress-wrap" style="min-width:140px"><div class="progress"><div class="progress-bar ${pct === 100 ? 'ok' : ''}" style="width:${pct}%"></div></div><span class="small muted">${done}/${total}</span></div>`; };
  const critCols = (getter, prefix = '') => state.dash.criteria.map(c => ({ key: `c${c.id}`, label: `${prefix}${shortName(c.name)} /${fmt(c.max_marks)}`, num: true, fmt: r => fmt(getter(r)?.[c.id]) }));
  const shortName = n => n.length > 22 ? n.replace(/ & /g, ' & ').split(' ').map(w => w.length > 4 && !/^&$/.test(w) ? w.slice(0, 4) + '.' : w).join(' ') : n;
  const methodBadge = () => `<span class="badge">Normalization: ${esc(state.dash.method)}</span>`;
  const searchBox = (id, ph = 'Search…') => `<input type="search" id="${id}" placeholder="${esc(ph)}">`;
  const bindSearch = (id, fn) => { const el = $(id); if (el) el.addEventListener('input', () => fn(el.value.trim().toLowerCase())); };

  // ---------------- renderers ----------------
  const renderers = {};

  renderers.dashboard = () => {
    const d = state.dash, o = d.overall;
    view.innerHTML = `
      ${pageHead(d.settings.event_name, `Live judging overview · ${methodBadge()}`, `<a class="btn sm" href="#export">Export</a>`)}
      <div class="stats">
        ${stat('Teams', o.teams, `${o.teams_fully_judged} fully judged · ${o.teams_unscored} unscored`)}
        ${stat('Judges', o.judges, `${o.judges_complete} finished`)}
        ${stat('Panels / Faculties', `${o.panels} / ${o.faculties}`)}
        ${stat('Scores submitted', `${o.submitted} <small class="muted" style="font-size:14px">/ ${o.assignments}</small>`, `${o.drafts} drafts · ${o.pending} pending`)}
        ${stat('Completion', `${fmt(o.completion_pct, 1)}%`, `<div class="progress" style="margin-top:6px"><div class="progress-bar ${o.completion_pct === 100 ? 'ok' : ''}" style="width:${o.completion_pct}%"></div></div>`)}
        ${stat('Raw mean ± SD', `${fmt(o.raw_mean)} <small class="muted" style="font-size:14px">± ${fmt(o.raw_sd)}</small>`, `range ${fmt(o.raw_min)} – ${fmt(o.raw_max)}`)}
        ${stat('Normalized mean ± SD', `${fmt(o.norm_mean)} <small class="muted" style="font-size:14px">± ${fmt(o.norm_sd)}</small>`, 'view-level, after per-judge normalization')}
        ${stat('Unassigned teams', o.teams_unassigned, o.teams_unassigned ? '<a href="#assignments">Fix in assignments →</a>' : 'all teams have judges')}
      </div>
      <div class="notice info" style="margin-bottom:16px"><strong>Fairness:</strong> ${esc(METHOD_INFO[d.method] || '')} Global raw mean <strong>${fmt(o.global_raw_mean)}</strong>, SD <strong>${fmt(o.global_raw_sd)}</strong> across ${o.global_submitted} submitted scores. Rankings use the normalized average; raw marks are kept untouched.</div>
      ${d.panel_stats.some(p => p.raw_bias != null) ? `<div class="card"><div class="card-head"><h3>Panel leniency check</h3><span class="small muted">raw bias = panel raw mean − global raw mean; after normalization every panel sits at the global mean</span></div>
        <div class="table-wrap"><table class="table compact"><thead><tr><th>Panel</th><th>Judges</th><th class="num">Scores</th><th class="num">Raw mean</th><th class="num">Raw bias</th><th class="num">Normalized mean</th><th>Reading</th></tr></thead><tbody>
        ${d.panel_stats.map(p => `<tr><td><strong>${esc(p.name)}</strong></td><td class="small">${esc(d.judges.filter(j => j.panel_id === p.id).map(j => `${j.name} (${j.bias == null ? '—' : (j.bias > 0 ? '+' : '') + fmt(j.bias)})`).join(', '))}</td><td class="num">${p.scores_submitted}/${p.scores_expected}</td><td class="num">${fmt(p.raw_avg)}</td><td class="num">${p.raw_bias == null ? '—' : `<strong style="color:${Math.abs(p.raw_bias) > 5 ? 'var(--warn)' : 'var(--ok)'}">${p.raw_bias > 0 ? '+' : ''}${fmt(p.raw_bias)}</strong>`}</td><td class="num">${fmt(p.norm_avg)}</td><td class="small muted">${p.raw_bias == null ? 'no scores yet' : Math.abs(p.raw_bias) > 5 ? (p.raw_bias > 0 ? 'lenient panel - corrected downward' : 'strict panel - corrected upward') : 'in line with other panels'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <div class="grid-2">
        <div class="card"><div class="card-head"><h3>Leaderboard (top 10 · normalized)</h3><a class="small" href="#rankings">Full rankings →</a></div><div id="topTable"></div></div>
        <div class="card"><div class="card-head"><h3>Judge completion</h3><a class="small" href="#completion">Details →</a></div><div id="judgeTable"></div></div>
      </div>
      <div class="grid-2">
        <div class="card"><div class="card-head"><h3>Criteria averages</h3><span class="small muted">across ${o.submitted} submitted scores</span></div><div id="critTable"></div></div>
        <div class="card"><div class="card-head"><h3>Panel overview</h3><a class="small" href="#panel-stats">Panel-wise →</a></div><div id="panelTable"></div></div>
      </div>`;
    dataTable($('topTable'), {
      columns: [
        { key: 'rank_norm', label: 'Rank', num: true, fmt: r => rankCell(r.rank_norm) }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Team', fmt: r => teamLink(r) },
        { key: 'panel_name', label: 'Panel' }, { key: 'submitted_count', label: 'Judges', num: true, fmt: r => `${r.submitted_count}/${r.assigned_count}` },
        { key: 'raw_avg', label: 'Raw', num: true, fmt: r => fmt(r.raw_avg) }, { key: 'norm_avg', label: 'Normalized', num: true, fmt: r => `<strong>${fmt(r.norm_avg)}</strong>` },
      ], rows: d.teams.filter(t => t.norm_avg != null).slice(0, 10), compact: true, empty: 'No submitted scores yet',
    });
    dataTable($('judgeTable'), {
      columns: [
        { key: 'name', label: 'Judge' }, { key: 'panel_name', label: 'Panel' },
        { key: 'completion_pct', label: 'Progress', num: true, fmt: r => progressCell(r.submitted_count, r.assigned_count) },
        { key: 'raw_mean', label: 'Mean', num: true, fmt: r => fmt(r.raw_mean) },
      ], rows: d.judges, compact: true, sortKey: 'name',
    });
    dataTable($('critTable'), {
      columns: [
        { key: 'name', label: 'Criterion', cls: 'wrap' }, { key: 'max_marks', label: 'Max', num: true },
        { key: 'mean', label: 'Mean', num: true, fmt: r => fmt(r.mean) },
        { key: 'pct_of_max', label: '% of max', num: true, fmt: r => r.pct_of_max == null ? '—' : `<span class="mini-bar" style="width:${Math.round(r.pct_of_max * 0.8)}px"></span>${fmt(r.pct_of_max, 1)}%` },
      ], rows: d.criteria_stats, compact: true,
    });
    dataTable($('panelTable'), {
      columns: [
        { key: 'name', label: 'Panel' }, { key: 'team_count', label: 'Teams', num: true }, { key: 'judge_count', label: 'Judges', num: true },
        { key: 'scores_submitted', label: 'Scores', num: true, fmt: r => progressCell(r.scores_submitted, r.scores_expected) },
        { key: 'raw_avg', label: 'Raw avg', num: true, fmt: r => fmt(r.raw_avg) }, { key: 'norm_avg', label: 'Norm avg', num: true, fmt: r => fmt(r.norm_avg) },
      ], rows: d.panel_stats, compact: true, empty: 'No panels yet',
    });
    bindTeamLinks();
  };

  const teamLink = t => `<a href="#" data-team="${t.id}" class="team-link"><strong>${esc(t.name)}</strong></a>`;
  function bindTeamLinks() { view.querySelectorAll('.team-link').forEach(a => a.addEventListener('click', e => { e.preventDefault(); teamDetailModal(Number(a.dataset.team)); })); }

  renderers.rankings = () => {
    const d = state.dash;
    view.innerHTML = `${pageHead('Overall rankings', `Ranked by normalized average; raw rank shown for comparison. ${methodBadge()}`,
      `${searchBox('rankSearch', 'Search team / code')}<label class="inline"><input type="checkbox" id="showCrit"> Criterion averages</label><a class="btn sm" href="/api/admin/export/csv?dataset=rankings&${new URLSearchParams(state.filters)}">CSV</a>`)}
      <div id="rankTable"></div>`;
    const base = [
      { key: 'rank_norm', label: 'Rank', num: true, fmt: r => rankCell(r.rank_norm) }, { key: 'rank_raw', label: 'Raw rank', num: true, fmt: r => r.rank_raw == null ? '—' : `#${r.rank_raw}` },
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Team', fmt: r => teamLink(r) }, { key: 'project_title', label: 'Project', cls: 'wrap' },
      { key: 'faculty_name', label: 'Faculty' }, { key: 'panel_name', label: 'Panel' },
      { key: 'submitted_count', label: 'Judges', num: true, fmt: r => `${r.submitted_count}/${r.assigned_count} ${r.is_complete ? badge('✓', 'ok') : r.submitted_count ? badge('partial', 'warn') : ''}` },
      { key: 'raw_avg', label: 'Raw avg', num: true, fmt: r => fmt(r.raw_avg) }, { key: 'norm_avg', label: 'Normalized', num: true, fmt: r => `<strong>${fmt(r.norm_avg)}</strong>` },
      { key: 'raw_min', label: 'Min', num: true, fmt: r => fmt(r.raw_min) }, { key: 'raw_max', label: 'Max', num: true, fmt: r => fmt(r.raw_max) }, { key: 'raw_sd', label: 'SD', num: true, fmt: r => fmt(r.raw_sd) },
    ];
    let q = '';
    const draw = () => {
      const cols = $('showCrit').checked ? base.concat(critCols(r => r.criterion_avg)) : base;
      const rows = d.teams.filter(t => !q || `${t.name} ${t.code || ''} ${t.project_title || ''}`.toLowerCase().includes(q));
      dataTable($('rankTable'), { columns: cols, rows, sortKey: 'rank_norm', empty: 'No teams' });
      bindTeamLinks();
    };
    $('showCrit').addEventListener('change', draw);
    bindSearch('rankSearch', v => { q = v; draw(); });
    draw();
  };

  renderers['team-scores'] = () => {
    const d = state.dash;
    view.innerHTML = `${pageHead('Team-wise scores', `Every judge's criterion-wise raw marks per team, with the raw total and the normalized value. ${methodBadge()}`,
      `${searchBox('teamSearch', 'Search team')}<button class="btn sm" id="expandAll">Expand all</button><button class="btn sm" id="collapseAll">Collapse</button>`)}
      <div id="teamGroups"></div>`;
    const draw = (q = '') => {
      const teams = d.teams.filter(t => !q || `${t.name} ${t.code || ''}`.toLowerCase().includes(q));
      $('teamGroups').innerHTML = teams.length ? teams.map(t => `
        <details class="group" data-team="${t.id}" ${state.filters.team_id || teams.length === 1 ? 'open' : ''}>
          <summary>${rankCell(t.rank_norm)} <span class="mono muted">${esc(t.code || '')}</span> <span>${esc(t.name)}</span>
            <span class="small muted">${esc([t.faculty_name, t.panel_name].filter(Boolean).join(' · '))}</span>
            <span class="spacer"></span>
            <span class="badge">${t.submitted_count}/${t.assigned_count} judges</span>
            <span class="badge">Raw ${fmt(t.raw_avg)}</span><span class="badge primary">Norm ${fmt(t.norm_avg)}</span>
            <button class="btn xs" data-detail="${t.id}">Details</button>
          </summary>
          <div class="team-body"></div>
        </details>`).join('') : '<div class="empty">No teams</div>';
      $('teamGroups').querySelectorAll('details').forEach(det => {
        const fill = () => { if (!det.dataset.filled) { renderTeamScoreTable(det.querySelector('.team-body'), Number(det.dataset.team)); det.dataset.filled = '1'; } };
        det.addEventListener('toggle', () => det.open && fill());
        if (det.open) fill();
      });
      $('teamGroups').querySelectorAll('[data-detail]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); teamDetailModal(Number(b.dataset.detail)); }));
    };
    $('expandAll').addEventListener('click', () => $('teamGroups').querySelectorAll('details').forEach(x => x.open = true));
    $('collapseAll').addEventListener('click', () => $('teamGroups').querySelectorAll('details').forEach(x => x.open = false));
    bindSearch('teamSearch', draw);
    draw();
  };

  function renderTeamScoreTable(container, teamId, { withActions = true } = {}) {
    const d = state.dash;
    const team = d.teams.find(t => t.id === teamId);
    const scores = d.scores.filter(s => s.team_id === teamId);
    const pending = d.completion.filter(c => c.team_id === teamId && c.status !== 'submitted');
    const rows = scores.map(s => ({ ...s, _status: 'submitted' })).concat(pending.map(p => ({ judge_id: p.judge_id, judge_name: p.judge_name, items: {}, total: null, normalized: null, _status: p.status, updated_at: p.updated_at })));
    const cols = [
      { key: 'judge_name', label: 'Judge', fmt: r => `${esc(r.judge_name)} ${r._status !== 'submitted' ? statusBadge(r._status) : ''}` },
      ...critCols(r => r.items),
      { key: 'total', label: 'Raw total', num: true, fmt: r => `<strong>${fmt(r.total)}</strong>` },
      { key: 'normalized', label: 'Normalized', num: true, fmt: r => fmt(r.normalized) },
      { key: 'submitted_at', label: 'Submitted', fmt: r => fmtDate(r.submitted_at) },
      { key: 'comments', label: 'Comments', cls: 'wrap', fmt: r => esc(r.comments || '') },
    ];
    if (withActions) cols.push({ key: '_a', label: '', fmt: r => r._status === 'pending' ? '' : `<button class="btn xs" data-hist="${r.judge_id}">History</button> <button class="btn xs" data-del="${r.judge_id}">Delete</button>` });
    const footer = team && scores.length ? `<tr><td>Average (${scores.length})</td>${d.criteria.map(c => `<td class="num">${fmt(team.criterion_avg[c.id])}</td>`).join('')}<td class="num">${fmt(team.raw_avg)}</td><td class="num">${fmt(team.norm_avg)}</td><td colspan="${withActions ? 3 : 2}"></td></tr>` : null;
    dataTable(container, { columns: cols, rows, compact: true, footer, empty: 'No judges assigned to this team' });
    container.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => historyModal(Number(b.dataset.hist), teamId)));
    container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const r = rows.find(x => x.judge_id === Number(b.dataset.del));
      if (!(await confirm(`Delete ${r.judge_name}'s score for ${team.name}? The judge can score again; the previous values stay in the history log.`, { danger: true, submitLabel: 'Delete score' }))) return;
      try { await API.del(`/api/admin/scores/${r.judge_id}/${teamId}`); toast('Score deleted', 'ok'); await refresh(false); } catch (e) { toast(e.message, 'error'); }
    }));
  }

  function teamDetailModal(teamId) {
    const t = state.dash.teams.find(x => x.id === teamId); if (!t) return;
    const m = modal({
      title: `${t.code ? t.code + ' · ' : ''}${t.name}`, wide: true, hideSubmit: true, cancelLabel: 'Close',
      body: `<div class="row" style="margin-bottom:12px">
          ${stat('Rank (normalized)', rankCell(t.rank_norm))}${stat('Rank (raw)', t.rank_raw ? '#' + t.rank_raw : '—')}
          ${stat('Raw average', fmt(t.raw_avg), `min ${fmt(t.raw_min)} · max ${fmt(t.raw_max)} · sd ${fmt(t.raw_sd)}`)}${stat('Normalized average', fmt(t.norm_avg))}
          ${stat('Judges', `${t.submitted_count}/${t.assigned_count}`, `${t.draft_count} draft`)}
        </div>
        <dl class="kv" style="margin-bottom:12px"><dt>Project</dt><dd>${esc(t.project_title || '—')}</dd><dt>Faculty</dt><dd>${esc(t.faculty_name || '—')}</dd><dt>Panel</dt><dd>${esc(t.panel_name || '—')}</dd><dt>Members</dt><dd>${esc(t.members || '—')}</dd></dl>
        <div id="tdTable"></div>`,
    });
    renderTeamScoreTable(m.wrap.querySelector('#tdTable'), teamId);
  }

  async function historyModal(judgeId, teamId) {
    const data = await API.get(`/api/admin/scores/${judgeId}/${teamId}`);
    const crit = state.dash.criteria;
    const judge = state.meta.judges.find(j => j.id === judgeId), team = state.meta.teams.find(t => t.id === teamId);
    modal({
      title: `Score history · ${judge?.name || judgeId} → ${team?.name || teamId}`, wide: true, hideSubmit: true, cancelLabel: 'Close',
      body: `<p class="muted small">Every saved version, newest first. Original judging data is never overwritten.</p><div class="table-wrap"><table class="table compact"><thead><tr><th>When</th><th>Status</th>${crit.map(c => `<th class="num">${esc(shortName(c.name))}</th>`).join('')}<th class="num">Total</th><th>By</th><th>Comments</th></tr></thead>
        <tbody>${data.history.length ? data.history.map(h => `<tr><td>${fmtDateFull(h.changed_at)}</td><td>${statusBadge(h.status === 'deleted' ? 'pending' : h.status)}${h.status === 'deleted' ? ' ' + badge('deleted', 'danger') : ''}</td>${crit.map(c => `<td class="num">${fmt(h.items[c.id])}</td>`).join('')}<td class="num"><strong>${fmt(h.total)}</strong></td><td>${esc(h.changed_by_name || '')}</td><td class="wrap">${esc(h.comments || '')}</td></tr>`).join('') : '<tr><td colspan="20" class="empty">No history</td></tr>'}</tbody></table></div>`,
    });
  }

  renderers['judge-records'] = () => {
    const d = state.dash;
    view.innerHTML = `${pageHead('Judge-wise records', `Per-judge statistics and every score they submitted, criterion-wise. Overall mean/SD are the basis for that judge's normalization. ${methodBadge()}`,
      `<a class="btn sm" href="/api/admin/export/csv?dataset=judges&${new URLSearchParams(state.filters)}">CSV (judges)</a><a class="btn sm" href="/api/admin/export/csv?dataset=scores&${new URLSearchParams(state.filters)}">CSV (all scores)</a>`)}
      <div class="card"><div class="card-head"><h3>Judge statistics</h3></div><div id="jStats"></div></div>
      <div class="card"><div class="card-head"><h3>Score records</h3><label class="inline"><input type="checkbox" id="showCritJ" checked> Criterion marks</label></div><div id="jScores"></div></div>`;
    dataTable($('jStats'), {
      columns: [
        { key: 'name', label: 'Judge', fmt: r => `${esc(r.name)} <span class="muted small">${esc(r.username)}</span>` }, { key: 'panel_name', label: 'Panel' }, { key: 'faculty_name', label: 'Faculty' },
        { key: 'completion_pct', label: 'Progress', num: true, fmt: r => progressCell(r.submitted_count, r.assigned_count) },
        { key: 'draft_count', label: 'Drafts', num: true }, { key: 'pending_count', label: 'Pending', num: true },
        { key: 'raw_mean', label: 'Raw mean', num: true, fmt: r => fmt(r.raw_mean) }, { key: 'raw_sd', label: 'Raw SD', num: true, fmt: r => fmt(r.raw_sd) },
        { key: 'raw_min', label: 'Min', num: true, fmt: r => fmt(r.raw_min) }, { key: 'raw_max', label: 'Max', num: true, fmt: r => fmt(r.raw_max) },
        { key: 'norm_mean', label: 'Norm mean', num: true, fmt: r => fmt(r.norm_mean) },
        { key: 'overall_mean', label: 'Overall mean/SD', num: true, fmt: r => `${fmt(r.overall_mean)} / ${fmt(r.overall_sd)} <span class="muted small">(${r.overall_count})</span>` },
        { key: 'bias', label: 'Bias', num: true, fmt: r => r.bias == null ? '—' : `<span style="color:${Math.abs(r.bias) > 5 ? 'var(--warn)' : 'var(--ok)'}" title="Judge raw mean minus global raw mean. Positive = lenient, negative = strict. Removed by normalization.">${r.bias > 0 ? '+' : ''}${fmt(r.bias)}</span>` },
        { key: 'last_login_at', label: 'Last login', fmt: r => fmtDate(r.last_login_at) },
      ], rows: d.judges, sortKey: 'name', empty: 'No judges',
    });
    const draw = () => {
      const cols = [
        { key: 'judge_name', label: 'Judge' }, { key: 'team_code', label: 'Code' }, { key: 'team_name', label: 'Team', fmt: r => teamLink({ id: r.team_id, name: r.team_name }) },
        ...($('showCritJ').checked ? critCols(r => r.items) : []),
        { key: 'total', label: 'Raw total', num: true, fmt: r => `<strong>${fmt(r.total)}</strong>` }, { key: 'normalized', label: 'Normalized', num: true, fmt: r => fmt(r.normalized) },
        { key: 'submitted_at', label: 'Submitted', fmt: r => fmtDate(r.submitted_at) }, { key: 'comments', label: 'Comments', cls: 'wrap', fmt: r => esc(r.comments || '') },
        { key: '_a', label: '', fmt: r => `<button class="btn xs" data-h="${r.judge_id}:${r.team_id}">History</button>` },
      ];
      dataTable($('jScores'), { columns: cols, rows: d.scores, sortKey: 'judge_name', compact: true, empty: 'No submitted scores in this view' });
      bindTeamLinks();
      $('jScores').querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => { const [j, t] = b.dataset.h.split(':').map(Number); historyModal(j, t); }));
    };
    $('showCritJ').addEventListener('change', draw); draw();
  };

  function renderGroupStats(title, sub, list, kind) {
    const d = state.dash;
    view.innerHTML = `${pageHead(title, `${sub} ${methodBadge()}`, `<a class="btn sm" href="/api/admin/export/csv?dataset=${kind}&${new URLSearchParams(state.filters)}">CSV</a>`)}
      <div class="card"><div class="card-head"><h3>Summary</h3></div><div id="gTable"></div></div>
      <div class="card"><div class="card-head"><h3>Criterion averages by ${kind === 'faculties' ? 'faculty' : 'panel'}</h3></div><div id="gCrit"></div></div>
      <h3 style="margin:18px 0 10px">Teams by ${kind === 'faculties' ? 'faculty' : 'panel'} (normalized rank order)</h3><div id="gGroups"></div>`;
    dataTable($('gTable'), {
      columns: [
        { key: 'name', label: 'Name' }, ...(kind === 'faculties' ? [{ key: 'code', label: 'Code' }] : []),
        { key: 'team_count', label: 'Teams', num: true }, { key: 'teams_scored', label: 'Scored', num: true }, { key: 'teams_complete', label: 'Complete', num: true }, { key: 'judge_count', label: 'Judges', num: true },
        { key: 'scores_submitted', label: 'Scores', num: true, fmt: r => progressCell(r.scores_submitted, r.scores_expected) },
        { key: 'raw_avg', label: 'Raw avg', num: true, fmt: r => fmt(r.raw_avg) }, { key: 'raw_sd', label: 'Raw SD', num: true, fmt: r => fmt(r.raw_sd) },
        { key: 'raw_bias', label: 'Raw bias', num: true, fmt: r => r.raw_bias == null ? '—' : `<span style="color:${Math.abs(r.raw_bias) > 5 ? 'var(--warn)' : 'var(--ok)'}" title="Raw mean minus global raw mean (leniency). Cancelled by normalization.">${r.raw_bias > 0 ? '+' : ''}${fmt(r.raw_bias)}</span>` },
        { key: 'norm_avg', label: 'Norm avg', num: true, fmt: r => `<strong>${fmt(r.norm_avg)}</strong>` }, { key: 'norm_sd', label: 'Norm SD', num: true, fmt: r => fmt(r.norm_sd) },
        { key: 'best_rank', label: 'Best rank', num: true, fmt: r => rankCell(r.best_rank) },
        { key: 'top_team', label: 'Top team', fmt: r => r.top_team ? `${teamLink(r.top_team)} <span class="muted small">${fmt(r.top_team.norm_avg)}</span>` : '—' },
      ], rows: list, sortKey: 'norm_avg', sortDir: 'desc', empty: `No ${kind} defined yet`,
    });
    dataTable($('gCrit'), { columns: [{ key: 'name', label: 'Name' }, ...critCols(r => r.criterion_avg)], rows: list, compact: true, empty: 'No data' });
    $('gGroups').innerHTML = list.map(g => `<details class="group" ${list.length <= 3 ? 'open' : ''}><summary>${esc(g.name)} <span class="badge">${g.teams_scored}/${g.team_count} teams scored</span><span class="badge primary">Norm ${fmt(g.norm_avg)}</span><span class="badge">Raw ${fmt(g.raw_avg)}</span></summary><div class="table-wrap"><table class="table compact"><thead><tr><th>Overall rank</th><th>Code</th><th>Team</th><th class="num">Judges</th><th class="num">Raw avg</th><th class="num">Normalized</th></tr></thead><tbody>
      ${g.teams.length ? g.teams.map(t => `<tr><td>${rankCell(t.rank_norm)}</td><td class="mono">${esc(t.code || '')}</td><td>${teamLink(t)}</td><td class="num">${t.submitted_count}/${t.assigned_count}</td><td class="num">${fmt(t.raw_avg)}</td><td class="num"><strong>${fmt(t.norm_avg)}</strong></td></tr>`).join('') : '<tr><td colspan="6" class="empty">No scored teams</td></tr>'}</tbody></table></div></details>`).join('') || '<div class="empty">Nothing to show</div>';
    bindTeamLinks();
  }
  renderers['faculty-stats'] = () => renderGroupStats('Faculty-wise records', 'Normalized and raw aggregates per faculty (teams grouped by their faculty).', state.dash.faculty_stats, 'faculties');
  renderers['panel-stats'] = () => renderGroupStats('Panel-wise records', 'Normalized and raw aggregates per panel (teams grouped by their panel).', state.dash.panel_stats, 'panels');

  renderers.completion = () => {
    const d = state.dash, o = d.overall;
    const judges = d.judges.slice().sort((a, b) => a.name.localeCompare(b.name));
    const teams = d.teams.slice().sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name), undefined, { numeric: true }));
    const cell = new Map(d.completion.map(c => [`${c.judge_id}:${c.team_id}`, c]));
    view.innerHTML = `${pageHead('Judge completion status', 'Who has scored what. Cells show the raw total for submitted scores.', `<a class="btn sm" href="/api/admin/export/csv?dataset=completion&${new URLSearchParams(state.filters)}">CSV</a>`)}
      <div class="stats">${stat('Completion', `${fmt(o.completion_pct, 1)}%`, `<div class="progress" style="margin-top:6px"><div class="progress-bar ${o.completion_pct === 100 ? 'ok' : ''}" style="width:${o.completion_pct}%"></div></div>`)}
        ${stat('Submitted', o.submitted, `of ${o.assignments} expected`)}${stat('Drafts in progress', o.drafts)}${stat('Not started', o.pending - o.drafts)}${stat('Judges finished', `${o.judges_complete}/${o.judges}`)}</div>
      <div class="card"><div class="card-head"><h3>By judge</h3></div><div id="cJudges"></div></div>
      <div class="card"><div class="card-head"><h3>Matrix · teams × judges</h3><span class="small muted">✓ submitted · ◐ draft · ○ pending · blank = not assigned</span></div>
        <div class="table-wrap"><table class="table compact matrix"><thead><tr><th>Code</th><th>Team</th><th>Panel</th>${judges.map(j => `<th class="rot" title="${esc(j.name)}">${esc(j.name)}</th>`).join('')}<th class="num">Done</th></tr></thead><tbody>
        ${teams.map(t => `<tr><td class="mono">${esc(t.code || '')}</td><td>${teamLink(t)}</td><td class="muted">${esc(t.panel_name || '')}</td>${judges.map(j => { const c = cell.get(`${j.id}:${t.id}`); if (!c) return '<td class="cell-na">·</td>'; if (c.status === 'submitted') return `<td class="cell-ok" title="Submitted ${fmtDateFull(c.submitted_at)}">✓ ${fmt(c.total)}</td>`; if (c.status === 'draft') return `<td class="cell-warn" title="Draft saved ${fmtDateFull(c.updated_at)}">◐</td>`; return '<td class="cell-pending">○</td>'; }).join('')}<td class="num">${t.submitted_count}/${t.assigned_count}</td></tr>`).join('') || `<tr><td colspan="${judges.length + 4}" class="empty">No teams</td></tr>`}</tbody></table></div></div>`;
    dataTable($('cJudges'), {
      columns: [
        { key: 'name', label: 'Judge' }, { key: 'panel_name', label: 'Panel' }, { key: 'completion_pct', label: 'Progress', num: true, fmt: r => progressCell(r.submitted_count, r.assigned_count) },
        { key: 'draft_count', label: 'Drafts', num: true }, { key: 'pending_count', label: 'Pending', num: true },
        { key: 'is_active', label: 'Status', fmt: r => r.pending_count === 0 && r.assigned_count ? badge('Finished', 'ok') : r.submitted_count ? badge('In progress', 'warn') : r.assigned_count ? badge('Not started', 'muted') : badge('No teams', 'danger') },
        { key: 'last_login_at', label: 'Last login', fmt: r => fmtDate(r.last_login_at) },
      ], rows: judges, compact: true,
    });
    bindTeamLinks();
  };

  renderers.export = () => {
    const q = new URLSearchParams(state.filters).toString();
    const datasets = [['rankings', 'Rankings (team-wise averages, ranks, criterion averages)'], ['scores', 'Raw scores - every judge × team with criterion marks, raw total and normalized'], ['matrixRaw', 'Matrix: teams × judges (raw totals)'], ['matrixNorm', 'Matrix: teams × judges (normalized)'],
      ['judges', 'Judge records and statistics'], ['faculties', 'Faculty-wise summary'], ['panels', 'Panel-wise summary'], ['completion', 'Completion status'], ['criteria', 'Criteria statistics'], ['summary', 'Overall summary']];
    view.innerHTML = `${pageHead('Export', 'Downloads respect the active filters. Raw and normalized values are always exported side by side; raw data is never altered.')}
      <div class="grid-2">
        <div class="card"><h3>Excel workbook</h3><p class="muted">One .xlsx with all sheets: summary, rankings, matrices, raw scores, judge records, faculty & panel summaries, completion, criteria.</p>
          <a class="btn primary" href="/api/admin/export/xlsx${q ? '?' + q : ''}">Download Excel (.xlsx)</a></div>
        <div class="card"><h3>CSV files</h3><p class="muted">Individual datasets as UTF-8 CSV (opens directly in Excel / Google Sheets).</p>
          <div class="table-wrap"><table class="table compact"><tbody>${datasets.map(([k, l]) => `<tr><td class="wrap">${esc(l)}</td><td class="right"><a class="btn xs" href="/api/admin/export/csv?dataset=${k}${q ? '&' + q : ''}">CSV</a></td></tr>`).join('')}</tbody></table></div></div>
      </div>`;
  };

  // ---------------- management: teams ----------------
  renderers.teams = async () => {
    const teams = await API.get('/api/admin/teams');
    const m = state.meta;
    view.innerHTML = `${pageHead('Teams', `${teams.length} teams. Assign judges under Assignments.`, `${searchBox('tSearch', 'Search')}<button class="btn sm" id="importBtn">Import CSV</button><button class="btn primary sm" id="addTeam">+ Add team</button>`)}<div id="tTable"></div>`;
    const draw = (q = '') => {
      dataTable($('tTable'), {
        columns: [
          { key: 'code', label: 'Code', fmt: r => `<span class="mono">${esc(r.code || '')}</span>` }, { key: 'name', label: 'Team', fmt: r => `<strong>${esc(r.name)}</strong>` }, { key: 'project_title', label: 'Project', cls: 'wrap' },
          { key: 'faculty_name', label: 'Faculty' }, { key: 'panel_name', label: 'Panel' }, { key: 'members', label: 'Members', cls: 'wrap', fmt: r => `<span class="small">${esc(r.members || '')}</span>` },
          { key: 'assigned_count', label: 'Judges', num: true, fmt: r => r.assigned_count ? `${r.submitted_count}/${r.assigned_count}` : badge('none', 'danger') },
          { key: '_a', label: '', fmt: r => `<button class="btn xs" data-edit="${r.id}">Edit</button> <button class="btn xs" data-del="${r.id}">Delete</button>` },
        ], rows: teams.filter(t => !q || `${t.name} ${t.code || ''} ${t.project_title || ''} ${t.members || ''}`.toLowerCase().includes(q)), sortKey: 'code', empty: 'No teams yet - add one or import a CSV',
      });
      $('tTable').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => teamModal(teams.find(t => t.id === Number(b.dataset.edit)))));
      $('tTable').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteWithForce(`/api/admin/teams/${b.dataset.del}`, `Delete team "${teams.find(t => t.id === Number(b.dataset.del)).name}"?`)));
    };
    bindSearch('tSearch', draw); draw();
    $('addTeam').addEventListener('click', () => teamModal(null));
    $('importBtn').addEventListener('click', importTeamsModal);
    function teamModal(t) {
      modal({
        title: t ? 'Edit team' : 'Add team',
        body: `<div class="row"><label class="field"><span>Team code</span><input name="code" value="${esc(t?.code || '')}" placeholder="T01"></label><label class="field" style="flex:2"><span>Team name *</span><input name="name" value="${esc(t?.name || '')}" required></label></div>
          <label class="field"><span>Project title</span><input name="project_title" value="${esc(t?.project_title || '')}"></label>
          <label class="field"><span>Members</span><input name="members" value="${esc(t?.members || '')}" placeholder="Comma-separated names"></label>
          <div class="row"><label class="field"><span>Faculty</span><select name="faculty_id">${options(m.faculties, t?.faculty_id)}</select></label><label class="field"><span>Panel</span><select name="panel_id">${options(m.panels, t?.panel_id)}</select></label></div>
          <label class="field"><span>Project description (shown to judges)</span><textarea name="description" rows="5">${esc(t?.description || '')}</textarea></label>
          <label class="field"><span>Note from organisers to judges (optional)</span><textarea name="notes">${esc(t?.notes || '')}</textarea></label>`,
        onSubmit: async (v, mm) => { if (t) await API.put(`/api/admin/teams/${t.id}`, v); else await API.post('/api/admin/teams', v); toast('Team saved', 'ok'); mm.close(); await loadMeta(); render(); },
      });
    }
  };

  function importTeamsModal() {
    modal({
      title: 'Import teams from CSV', wide: true, submitLabel: 'Import',
      body: `<p class="muted small">Header row required. Recognised columns: <code>code, name, project_title (or project), members, faculty, panel</code>. Faculties/panels are matched by name and created if missing. Rows whose code already exists are updated.</p>
        <label class="field"><span>Choose file</span><input type="file" id="csvFile" accept=".csv,text/csv"></label>
        <label class="field"><span>…or paste CSV</span><textarea name="csv" rows="8" placeholder="code,name,project_title,members,faculty,panel&#10;T01,Team Alpha,MediScan,Asha; Ravi,Faculty of Engineering,Panel A"></textarea></label>`,
      onSubmit: async (v, mm) => {
        const rows = parseCSV(v.csv || '');
        if (rows.length < 2) throw new Error('Need a header row and at least one data row');
        const head = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
        const idx = k => head.findIndex(h => h === k || (k === 'project_title' && (h === 'project' || h === 'title')) || (k === 'name' && h === 'team' ) || (k === 'name' && h === 'team_name'));
        const ci = { code: idx('code'), name: idx('name'), project_title: idx('project_title'), members: idx('members'), description: idx('description'), faculty: idx('faculty'), panel: idx('panel') };
        if (ci.name < 0) throw new Error('A "name" column is required');
        const data = rows.slice(1).map(r => Object.fromEntries(Object.entries(ci).map(([k, i]) => [k, i >= 0 ? (r[i] || '').trim() : ''])));
        const res = await API.post('/api/admin/teams/import', { rows: data });
        toast(`Imported: ${res.created} created, ${res.updated} updated, ${res.skipped} skipped`, res.errors.length ? 'warn' : 'ok', 5000);
        mm.close(); await loadMeta(); render();
      },
    });
    const fileInput = document.getElementById('csvFile');
    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { fileInput.closest('form').querySelector('textarea[name=csv]').value = rd.result; }; rd.readAsText(f); });
  }
  function parseCSV(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim()));
  }

  async function deleteWithForce(url, message) {
    if (!(await confirm(message, { danger: true, submitLabel: 'Delete' }))) return;
    try { await API.del(url); toast('Deleted', 'ok'); await loadMeta(); render(); }
    catch (e) {
      if (e.status === 409) {
        if (await confirm(`${e.message}\n\nDelete anyway? Scores will be removed (history is preserved).`, { danger: true, submitLabel: 'Force delete', title: 'Scores exist' })) {
          try { await API.del(`${url}?force=1`); toast('Deleted', 'ok'); await loadMeta(); render(); } catch (e2) { toast(e2.message, 'error'); }
        }
      } else toast(e.message, 'error');
    }
  }

  // ---------------- management: judges ----------------
  renderers.judges = async () => {
    const judges = await API.get('/api/admin/users?role=judge');
    const m = state.meta;
    view.innerHTML = `${pageHead('Judges', `${judges.length} judge accounts. Each judge sees only their assigned teams and their own scores.`, `${searchBox('jSearch', 'Search')}<button class="btn primary sm" id="addJudge">+ Add judge</button>`)}<div id="jTable"></div>`;
    const draw = (q = '') => {
      dataTable($('jTable'), {
        columns: [
          { key: 'name', label: 'Name', fmt: r => `<strong>${esc(r.name)}</strong>${r.is_active ? '' : ' ' + badge('inactive', 'danger')}${r.must_change_password ? ' ' + badge('temp password', 'warn') : ''}` },
          { key: 'username', label: 'Username', fmt: r => `<span class="mono">${esc(r.username)}</span>` }, { key: 'email', label: 'Email' },
          { key: 'panel_name', label: 'Panel' }, { key: 'faculty_name', label: 'Faculty' },
          { key: 'assigned_count', label: 'Assigned', num: true }, { key: 'submitted_count', label: 'Submitted', num: true }, { key: 'draft_count', label: 'Drafts', num: true },
          { key: 'last_login_at', label: 'Last login', fmt: r => fmtDate(r.last_login_at) },
          { key: '_a', label: '', fmt: r => `<button class="btn xs" data-edit="${r.id}">Edit</button> <button class="btn xs" data-pw="${r.id}">Reset password</button> <button class="btn xs" data-tog="${r.id}">${r.is_active ? 'Deactivate' : 'Activate'}</button> <button class="btn xs" data-del="${r.id}">Delete</button>` },
        ], rows: judges.filter(j => !q || `${j.name} ${j.username} ${j.email || ''} ${j.panel_name || ''}`.toLowerCase().includes(q)), sortKey: 'name', empty: 'No judges yet',
      });
      const find = id => judges.find(j => j.id === Number(id));
      $('jTable').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => userModal(find(b.dataset.edit), 'judge')));
      $('jTable').querySelectorAll('[data-pw]').forEach(b => b.addEventListener('click', () => resetPasswordModal(find(b.dataset.pw))));
      $('jTable').querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', async () => { const j = find(b.dataset.tog); try { await API.put(`/api/admin/users/${j.id}`, { is_active: !j.is_active }); toast(j.is_active ? 'Judge deactivated (signed out everywhere)' : 'Judge activated', 'ok'); await loadMeta(); render(); } catch (e) { toast(e.message, 'error'); } }));
      $('jTable').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteWithForce(`/api/admin/users/${b.dataset.del}`, `Delete judge "${find(b.dataset.del).name}"? Prefer "Deactivate" if they have already scored.`)));
    };
    bindSearch('jSearch', draw); draw();
    $('addJudge').addEventListener('click', () => userModal(null, 'judge'));
  };

  function userModal(u, role) {
    const m = state.meta;
    modal({
      title: u ? `Edit ${role}` : `Add ${role}`,
      body: `<div class="row"><label class="field"><span>Full name *</span><input name="name" value="${esc(u?.name || '')}" required></label><label class="field"><span>Username *</span><input name="username" value="${esc(u?.username || '')}" required autocomplete="off" placeholder="judge1"></label></div>
        <label class="field"><span>Email</span><input name="email" type="email" value="${esc(u?.email || '')}"></label>
        ${role === 'judge' ? `<div class="row"><label class="field"><span>Panel</span><select name="panel_id">${options(m.panels, u?.panel_id)}</select></label><label class="field"><span>Faculty</span><select name="faculty_id">${options(m.faculties, u?.faculty_id)}</select></label></div>` : ''}
        ${u ? '' : `<label class="field"><span>Password</span><input name="password" type="text" autocomplete="new-password" placeholder="Leave blank to auto-generate a secure password"></label>
        <label class="inline"><input type="checkbox" name="must_change_password"> Require password change at first login</label>`}`,
      onSubmit: async (v, mm) => {
        if (u) { await API.put(`/api/admin/users/${u.id}`, v); toast('Saved', 'ok'); mm.close(); await loadMeta(); render(); }
        else {
          const res = await API.post('/api/admin/users', { ...v, role });
          mm.close(); await loadMeta(); render();
          credentialsModal(res.user, res.password, 'Account created');
        }
      },
    });
  }
  function credentialsModal(user, password, title) {
    const m = modal({
      title, hideSubmit: true, cancelLabel: 'Done',
      body: `<p>Share these credentials with <strong>${esc(user.name)}</strong>. The password is shown <strong>only once</strong>.</p>
        <dl class="kv"><dt>Login URL</dt><dd class="mono">${esc(location.origin)}/</dd><dt>Username</dt><dd class="mono">${esc(user.username)}</dd></dl>
        <div class="password-box" style="margin-top:10px"><span class="mono" id="pwText">${esc(password)}</span><span class="spacer"></span><button type="button" class="btn xs" id="copyPw">Copy</button></div>`,
    });
    m.wrap.querySelector('#copyPw').addEventListener('click', async () => { try { await navigator.clipboard.writeText(`${location.origin}/\nUsername: ${user.username}\nPassword: ${password}`); toast('Copied', 'ok'); } catch (_) { toast('Copy failed - select the text manually', 'warn'); } });
  }
  function resetPasswordModal(u) {
    modal({
      title: `Reset password · ${u.name}`, submitLabel: 'Reset password', danger: true,
      body: `<p class="muted small">The user is signed out of all devices. Leave blank to auto-generate.</p><label class="field"><span>New password</span><input name="password" type="text" autocomplete="off" placeholder="Auto-generate"></label><label class="inline"><input type="checkbox" name="must_change_password"> Require change at next login</label>`,
      onSubmit: async (v, mm) => { const r = await API.post(`/api/admin/users/${u.id}/reset-password`, v); mm.close(); credentialsModal(u, r.password, 'Password reset'); render(); },
    });
  }

  // ---------------- management: assignments ----------------
  renderers.assignments = async () => {
    const [assign, teams, judges] = await Promise.all([API.get('/api/admin/assignments'), API.get('/api/admin/teams'), API.get('/api/admin/users?role=judge')]);
    const m = state.meta;
    const set = new Set(assign.map(a => `${a.judge_id}:${a.team_id}`));
    view.innerHTML = `${pageHead('Assignments', `Tick a cell to assign a team to a judge. ${assign.length} assignments in total.`,
      `<select id="autoPanel" style="width:auto">${options(m.panels, '', 'Choose panel…')}</select><button class="btn sm" id="autoAssign" title="Assign every team in the panel to every judge in the panel">Auto-assign panel</button><button class="btn primary sm" id="bulkBtn">Bulk assign / remove</button>`)}
      <div class="toolbar"><label class="inline small">Judges of panel <select id="mJPanel" style="width:auto">${options(m.panels, '', 'All')}</select></label><label class="inline small">Teams of panel <select id="mTPanel" style="width:auto">${options(m.panels, '', 'All')}</select></label>${searchBox('aSearch', 'Search team')}</div>
      <div id="matrix"></div>`;
    const draw = () => {
      const jp = $('mJPanel').value, tp = $('mTPanel').value, q = $('aSearch').value.trim().toLowerCase();
      const js = judges.filter(j => j.is_active && (!jp || String(j.panel_id) === jp));
      const ts = teams.filter(t => (!tp || String(t.panel_id) === tp) && (!q || `${t.name} ${t.code || ''}`.toLowerCase().includes(q)));
      $('matrix').innerHTML = `<div class="table-wrap"><table class="table compact matrix"><thead><tr><th>Code</th><th>Team</th><th>Panel</th>${js.map(j => `<th class="rot" title="${esc(j.name)} · ${esc(j.panel_name || 'no panel')}">${esc(j.name)}</th>`).join('')}<th class="num">Judges</th></tr></thead>
        <tbody>${ts.map(t => `<tr><td class="mono">${esc(t.code || '')}</td><td><strong>${esc(t.name)}</strong></td><td class="muted">${esc(t.panel_name || '')}</td>${js.map(j => `<td class="chk"><input type="checkbox" data-j="${j.id}" data-t="${t.id}" ${set.has(`${j.id}:${t.id}`) ? 'checked' : ''} title="${esc(j.name)} → ${esc(t.name)}"></td>`).join('')}<td class="num" data-count="${t.id}">${[...set].filter(k => k.endsWith(`:${t.id}`)).length}</td></tr>`).join('') || `<tr><td colspan="${js.length + 4}" class="empty">No teams</td></tr>`}</tbody>
        <tfoot><tr><td colspan="3">Teams per judge</td>${js.map(j => `<td class="num" data-jcount="${j.id}">${[...set].filter(k => k.startsWith(`${j.id}:`)).length}</td>`).join('')}<td></td></tr></tfoot></table></div>`;
      $('matrix').querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', async () => {
        const j = Number(cb.dataset.j), t = Number(cb.dataset.t), key = `${j}:${t}`;
        cb.disabled = true;
        try {
          try { await API.post('/api/admin/assignments/toggle', { judge_id: j, team_id: t, assigned: cb.checked }); }
          catch (e) {
            if (e.status === 409 && !cb.checked) {
              if (await confirm(`${e.message}`, { danger: true, submitLabel: 'Remove and delete score', title: 'Score exists' })) await API.post('/api/admin/assignments/toggle', { judge_id: j, team_id: t, assigned: false, force: true });
              else { cb.checked = true; return; }
            } else throw e;
          }
          if (cb.checked) set.add(key); else set.delete(key);
          $('matrix').querySelector(`[data-count="${t}"]`).textContent = [...set].filter(k => k.endsWith(`:${t}`)).length;
          $('matrix').querySelector(`[data-jcount="${j}"]`).textContent = [...set].filter(k => k.startsWith(`${j}:`)).length;
        } catch (e) { cb.checked = !cb.checked; toast(e.message, 'error'); }
        finally { cb.disabled = false; }
      }));
    };
    ['mJPanel', 'mTPanel'].forEach(id => $(id).addEventListener('change', draw)); bindSearch('aSearch', draw); draw();
    $('autoAssign').addEventListener('click', async () => {
      const pid = $('autoPanel').value; if (!pid) return toast('Choose a panel first', 'warn');
      const p = m.panels.find(x => String(x.id) === pid);
      if (!(await confirm(`Assign every team in "${p.name}" to every active judge in "${p.name}"? Existing assignments are kept.`, { submitLabel: 'Assign' }))) return;
      try { const r = await API.post(`/api/admin/assignments/panel/${pid}`); toast(`${r.changed} new assignments (${r.judges} judges × ${r.teams} teams)`, 'ok'); render(); } catch (e) { toast(e.message, 'error'); }
    });
    $('bulkBtn').addEventListener('click', () => modal({
      title: 'Bulk assign / remove', wide: true, submitLabel: 'Apply',
      body: `<div class="row"><label class="field"><span>Mode</span><select name="mode"><option value="add">Assign selected teams to selected judges</option><option value="remove">Remove selected assignments (scored ones are skipped)</option></select></label></div>
        <div class="row"><div><div class="field"><span>Judges</span></div><div class="check-grid">${judges.filter(j => j.is_active).map(j => `<label class="inline"><input type="checkbox" name="j_${j.id}"> ${esc(j.name)} <span class="muted small">${esc(j.panel_name || '')}</span></label>`).join('')}</div></div>
        <div><div class="field"><span>Teams</span></div><div class="check-grid">${teams.map(t => `<label class="inline"><input type="checkbox" name="t_${t.id}"> ${esc(t.code ? t.code + ' · ' : '')}${esc(t.name)}</label>`).join('')}</div></div></div>`,
      onSubmit: async (v, mm) => {
        const judge_ids = Object.keys(v).filter(k => k.startsWith('j_') && v[k]).map(k => Number(k.slice(2)));
        const team_ids = Object.keys(v).filter(k => k.startsWith('t_') && v[k]).map(k => Number(k.slice(2)));
        const r = await API.post('/api/admin/assignments/bulk', { judge_ids, team_ids, mode: v.mode });
        toast(`${r.changed} assignment(s) ${v.mode === 'add' ? 'added' : 'removed'}${r.blocked ? `, ${r.blocked} skipped (scored)` : ''}`, 'ok', 5000); mm.close(); render();
      },
    }));
  };

  // ---------------- management: panels & faculties ----------------
  function simpleCrud(kind, title, sub, fields) {
    return async () => {
      const rows = await API.get(`/api/admin/${kind}`);
      view.innerHTML = `${pageHead(title, sub, `<button class="btn primary sm" id="addBtn">+ Add</button>`)}<div id="sTable"></div>`;
      dataTable($('sTable'), {
        columns: [...fields.map(f => ({ key: f.key, label: f.label, cls: f.wrap ? 'wrap' : '' })), { key: 'team_count', label: 'Teams', num: true }, { key: 'judge_count', label: 'Judges', num: true }, { key: 'created_at', label: 'Created', fmt: r => fmtDate(r.created_at) },
          { key: '_a', label: '', fmt: r => `<button class="btn xs" data-edit="${r.id}">Edit</button> <button class="btn xs" data-del="${r.id}">Delete</button>` }],
        rows, sortKey: 'name', empty: `No ${kind} yet`,
      });
      const open = r => modal({
        title: r ? `Edit` : `Add`,
        body: fields.map(f => `<label class="field"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${f.textarea ? `<textarea name="${f.key}">${esc(r?.[f.key] || '')}</textarea>` : `<input name="${f.key}" value="${esc(r?.[f.key] || '')}" ${f.required ? 'required' : ''}>`}</label>`).join(''),
        onSubmit: async (v, mm) => { if (r) await API.put(`/api/admin/${kind}/${r.id}`, v); else await API.post(`/api/admin/${kind}`, v); toast('Saved', 'ok'); mm.close(); await loadMeta(); render(); },
      });
      $('addBtn').addEventListener('click', () => open(null));
      $('sTable').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => open(rows.find(r => r.id === Number(b.dataset.edit)))));
      $('sTable').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteWithForce(`/api/admin/${kind}/${b.dataset.del}`, `Delete "${rows.find(r => r.id === Number(b.dataset.del)).name}"? Teams and judges linked to it are kept but unlinked.`)));
    };
  }
  renderers.panels = simpleCrud('panels', 'Panels', 'A panel is a group of judges evaluating a group of teams (e.g. a room or track).', [{ key: 'name', label: 'Panel name', required: true }, { key: 'description', label: 'Description', wrap: true, textarea: true }]);
  renderers.faculties = simpleCrud('faculties', 'Faculties', 'Faculties / departments that teams (and optionally judges) belong to.', [{ key: 'name', label: 'Faculty name', required: true }, { key: 'code', label: 'Code' }]);

  // ---------------- criteria ----------------
  renderers.criteria = async () => {
    const data = await API.get('/api/admin/criteria');
    const locked = data.scores_exist;
    view.innerHTML = `${pageHead('Judging criteria', `Max marks must total <strong>${data.total_marks}</strong>. ${locked ? 'Scores exist, so only names/descriptions/order can change.' : 'No scores yet - the rubric is fully editable.'}`)}
      ${locked ? '<div class="notice warn">Scores have been recorded. Adding/removing criteria or changing max marks is disabled to protect existing data. Clear all scores in Settings → Danger zone if the rubric must change.</div>' : ''}
      <div class="card"><div class="table-wrap"><table class="table" id="critTable"><thead><tr><th>#</th><th>Criterion</th><th>Description</th><th class="num">Max marks</th><th></th></tr></thead><tbody></tbody>
        <tfoot><tr><td colspan="3" class="right">Total</td><td class="num" id="critSum"></td><td></td></tr></tfoot></table></div>
        <div class="toolbar" style="margin-top:12px">${locked ? '' : '<button class="btn sm" id="addCrit">+ Add criterion</button>'}<span class="spacer"></span><button class="btn primary" id="saveCrit">Save criteria</button></div></div>`;
    let list = data.criteria.map(c => ({ ...c }));
    const tbody = view.querySelector('tbody');
    const draw = () => {
      tbody.innerHTML = list.map((c, i) => `<tr data-i="${i}"><td class="muted">${i + 1}<br><button class="btn xs" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button> <button class="btn xs" data-down="${i}" ${i === list.length - 1 ? 'disabled' : ''}>↓</button></td>
        <td><input data-f="name" value="${esc(c.name)}" style="min-width:220px"></td><td><input data-f="description" value="${esc(c.description || '')}" style="min-width:260px"></td>
        <td class="num"><input data-f="max_marks" type="number" min="0.5" step="0.5" value="${c.max_marks}" style="width:90px;text-align:right" ${locked ? 'disabled' : ''}></td>
        <td>${locked ? '' : `<button class="btn xs" data-rm="${i}">Remove</button>`}</td></tr>`).join('');
      sum();
      tbody.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { const i = Number(inp.closest('tr').dataset.i); list[i][inp.dataset.f] = inp.dataset.f === 'max_marks' ? Number(inp.value) : inp.value; sum(); }));
      tbody.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.up); [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); }));
      tbody.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.down); [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); }));
      tbody.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { list.splice(Number(b.dataset.rm), 1); draw(); }));
    };
    const sum = () => { const s = list.reduce((a, c) => a + (Number(c.max_marks) || 0), 0); const el = $('critSum'); el.innerHTML = `<strong style="color:${Math.abs(s - data.total_marks) < 1e-9 ? 'var(--ok)' : 'var(--danger)'}">${fmt(s)}</strong> / ${data.total_marks}`; };
    draw();
    $('addCrit')?.addEventListener('click', () => { list.push({ name: '', description: '', max_marks: 0 }); draw(); tbody.querySelector('tr:last-child input').focus(); });
    $('saveCrit').addEventListener('click', async () => {
      try { await API.put('/api/admin/criteria', { criteria: list }); toast('Criteria saved', 'ok'); await loadMeta(); render(); } catch (e) { toast(e.message, 'error', 6000); }
    });
  };

  // ---------------- settings ----------------
  renderers.settings = async () => {
    const s = state.meta.settings;
    const admins = await API.get('/api/admin/users?role=admin');
    view.innerHTML = `${pageHead('Settings', 'Event configuration, scoring method and account security.')}
      <div class="grid-2">
        <div class="card"><h3>Event & scoring</h3>
          <form id="setForm">
            <label class="field"><span>Event name</span><input name="event_name" value="${esc(s.event_name)}" required></label>
            <label class="field"><span>Normalization method</span><select name="normalization_method">${state.meta.methods.map(mth => `<option value="${mth}" ${mth === s.normalization_method ? 'selected' : ''}>${mth}</option>`).join('')}</select></label>
            <div class="form-hint" id="methodInfo" style="margin:-6px 0 12px">${esc(METHOD_INFO[s.normalization_method])}</div>
            <label class="inline" style="margin-bottom:8px"><input type="checkbox" name="judging_locked" ${s.judging_locked ? 'checked' : ''}> <strong>Lock judging</strong> <span class="muted">— judges can view but not save or submit</span></label><br>
            <label class="inline" style="margin-bottom:14px"><input type="checkbox" name="allow_edit_after_submit" ${s.allow_edit_after_submit ? 'checked' : ''}> Allow judges to revise a submitted score while judging is open</label>
            <div><button class="btn primary" type="submit">Save settings</button></div>
          </form>
          <p class="muted small" style="margin-top:12px">Raw scores are stored exactly as entered; the normalization method only changes how they are combined for rankings and can be switched at any time.</p>
        </div>
        <div class="card"><h3>My account</h3><p class="muted">Signed in as <strong>${esc(state.me.name)}</strong> (${esc(state.me.username)}).</p><button class="btn" id="pwBtn">Change my password</button>
          <h3 style="margin-top:22px">Admin accounts</h3><div id="adminTable"></div><div style="margin-top:10px"><button class="btn sm" id="addAdmin">+ Add admin</button></div></div>
      </div>
      <div class="card" style="border-color:#fecaca"><h3 style="color:var(--danger)">Danger zone</h3><p class="muted">Remove every score (drafts and submissions). Score history and the audit log are preserved, teams/judges/assignments are untouched.</p><button class="btn danger" id="clearScores">Clear all scores…</button></div>`;
    const form = $('setForm');
    form.normalization_method.addEventListener('change', () => { $('methodInfo').textContent = METHOD_INFO[form.normalization_method.value]; });
    form.addEventListener('submit', async e => { e.preventDefault(); try { await API.put('/api/admin/settings', UI.formValues(form)); toast('Settings saved', 'ok'); await loadMeta(); render(); } catch (ex) { toast(ex.message, 'error'); } });
    $('pwBtn').addEventListener('click', changePasswordModal);
    dataTable($('adminTable'), {
      columns: [{ key: 'name', label: 'Name', fmt: r => `${esc(r.name)}${r.is_active ? '' : ' ' + badge('inactive', 'danger')}` }, { key: 'username', label: 'Username' }, { key: 'last_login_at', label: 'Last login', fmt: r => fmtDate(r.last_login_at) },
        { key: '_a', label: '', fmt: r => r.id === state.me.id ? '<span class="muted small">you</span>' : `<button class="btn xs" data-pw="${r.id}">Reset password</button> <button class="btn xs" data-tog="${r.id}">${r.is_active ? 'Deactivate' : 'Activate'}</button>` }],
      rows: admins, compact: true,
    });
    $('adminTable').querySelectorAll('[data-pw]').forEach(b => b.addEventListener('click', () => resetPasswordModal(admins.find(a => a.id === Number(b.dataset.pw)))));
    $('adminTable').querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', async () => { const a = admins.find(x => x.id === Number(b.dataset.tog)); try { await API.put(`/api/admin/users/${a.id}`, { is_active: !a.is_active }); render(); } catch (e) { toast(e.message, 'error'); } }));
    $('addAdmin').addEventListener('click', () => userModal(null, 'admin'));
    $('clearScores').addEventListener('click', () => modal({
      title: 'Clear ALL scores', danger: true, submitLabel: 'Clear all scores',
      body: `<p>This removes every draft and submitted score. Type <strong>CLEAR SCORES</strong> to confirm.</p><label class="field"><input name="confirm" autocomplete="off"></label>`,
      onSubmit: async (v, mm) => { const r = await API.post('/api/admin/danger/clear-scores', { confirm: v.confirm }); toast(`${r.removed} score(s) removed`, 'ok'); mm.close(); await loadMeta(); render(); },
    }));
  };

  function changePasswordModal() {
    modal({
      title: 'Change password', submitLabel: 'Update password',
      body: `<label class="field"><span>Current password</span><input type="password" name="current_password" autocomplete="current-password" required></label>
        <label class="field"><span>New password</span><input type="password" name="new_password" autocomplete="new-password" minlength="8" required></label>
        <label class="field"><span>Confirm new password</span><input type="password" name="confirm" autocomplete="new-password" required></label><div class="form-hint">Minimum 8 characters.</div>`,
      onSubmit: async (v, m) => { if (v.new_password !== v.confirm) throw new Error('Passwords do not match'); await API.post('/api/auth/change-password', { current_password: v.current_password, new_password: v.new_password }); toast('Password updated', 'ok'); m.close(); },
    });
  }

  // ---------------- audit ----------------
  renderers.audit = async () => {
    const draw = async (action = '') => {
      const data = await API.get(`/api/admin/audit?limit=300${action ? '&action=' + encodeURIComponent(action) : ''}`);
      if (!$('auditTable')) {
        view.innerHTML = `${pageHead('Audit log', `${data.total} events. Every login, score save, and administrative change is recorded with a timestamp.`, `<select id="auditAction" style="width:auto"><option value="">All actions</option>${data.actions.map(a => `<option value="${esc(a)}" ${a === action ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>`)}<div id="auditTable"></div>`;
        $('auditAction').addEventListener('change', e => draw(e.target.value));
      }
      dataTable($('auditTable'), {
        columns: [
          { key: 'created_at', label: 'Time', fmt: r => fmtDateFull(r.created_at) }, { key: 'username', label: 'User', fmt: r => r.username ? `${esc(r.username)} <span class="muted small">${esc(r.role || '')}</span>` : '<span class="muted">system</span>' },
          { key: 'action', label: 'Action', fmt: r => badge(r.action, /fail|delet|clear/.test(r.action) ? 'danger' : /submit|login$/.test(r.action) ? 'ok' : '') },
          { key: 'entity_type', label: 'Entity', fmt: r => r.entity_type ? `${esc(r.entity_type)}${r.entity_id ? ' #' + r.entity_id : ''}` : '' },
          { key: 'details', label: 'Details', cls: 'wrap', fmt: r => `<span class="small mono">${esc(r.details ? JSON.stringify(r.details) : '')}</span>` }, { key: 'ip', label: 'IP' },
        ], rows: data.rows, compact: true, empty: 'No events',
      });
    };
    await draw();
  };

  init().catch(e => { view.innerHTML = `<div class="card"><div class="form-error">${esc(e.message)}</div></div>`; });
})();
