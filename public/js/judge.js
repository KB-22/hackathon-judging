/* Judge portal: assigned teams + scoring form. The judge only ever receives their own data from the API. */
(function () {
  'use strict';
  const { esc, fmt, fmtDate, toast, modal, confirm, statusBadge } = UI;
  const $ = id => document.getElementById(id);

  const state = { data: null, teamId: null, dirty: false };

  async function load() {
    state.data = await API.get('/api/judge/overview');
    renderHeader();
    renderTeams();
    if (state.teamId) renderForm(); // refresh status/labels
  }

  function renderHeader() {
    const d = state.data;
    $('eventName').textContent = d.event_name || 'Hackathon Judging';
    $('judgeMeta').textContent = `${d.judge.name}${d.judge.panel_name ? ' · ' + d.judge.panel_name : ''}`;
    $('lockBadge').hidden = !d.judging_locked;
    const p = d.progress;
    $('progressBar').style.width = p.assigned ? `${Math.round(p.submitted / p.assigned * 100)}%` : '0%';
    $('progressBar').classList.toggle('ok', p.assigned > 0 && p.submitted === p.assigned);
    $('progressText').textContent = `${p.submitted}/${p.assigned} submitted`;
  }

  function renderTeams() {
    const list = $('teamList');
    const teams = state.data.teams;
    if (!teams.length) { list.innerHTML = '<div class="empty">No teams have been assigned to you yet.<br>Please contact the organisers.</div>'; return; }
    list.innerHTML = teams.map(t => `
      <div class="team-card ${t.id === state.teamId ? 'active' : ''}" data-id="${t.id}">
        <div class="tc-top"><span class="tc-code">${esc(t.code || '')}</span>${statusBadge(t.status)}</div>
        <div class="tc-name">${esc(t.name)}</div>
        <div class="tc-sub">${esc(t.project_title || '')}</div>
        <div class="tc-sub">${[t.faculty_name, t.status === 'submitted' ? `Score ${fmt(t.total)} / ${state.data.total_marks}` : t.status === 'draft' ? `Draft ${fmt(t.total)}` : null].filter(Boolean).map(esc).join(' · ')}</div>
      </div>`).join('');
    list.querySelectorAll('.team-card').forEach(c => c.addEventListener('click', () => selectTeam(Number(c.dataset.id))));
  }

  async function selectTeam(id) {
    if (state.dirty && state.teamId !== id && !(await confirm('You have unsaved changes on the current team. Discard them?', { danger: true, submitLabel: 'Discard' }))) return;
    state.teamId = id; state.dirty = false;
    document.body.classList.add('scoring');
    renderTeams();
    await renderForm();
  }

  function backToList() {
    document.body.classList.remove('scoring');
  }

  async function renderForm() {
    const host = $('scoreForm');
    $('emptyState').hidden = true; host.hidden = false;
    host.innerHTML = '<div class="empty">Loading…</div>';
    let payload;
    try { payload = await API.get(`/api/judge/scores/${state.teamId}`); }
    catch (e) { host.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
    const { team, criteria, score } = payload;
    const d = state.data;
    const readOnly = d.judging_locked || (score && score.status === 'submitted' && !d.allow_edit_after_submit);
    const items = score ? score.items : {};

    host.innerHTML = `
      <div class="score-head">
        <div>
          <button class="btn ghost sm back-btn" id="backBtn">← My teams</button>
          <div class="tc-code" style="margin-top:6px">${esc(team.code || '')}</div>
          <h2 style="margin:2px 0">${esc(team.name)}</h2>
          <div class="muted">${esc(team.project_title || '')}</div>
          <div class="small muted">${[team.faculty_name, team.panel_name, team.members ? 'Members: ' + team.members : null].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        <div class="right">
          ${score ? statusBadge(score.status) : statusBadge('pending')}
          <div class="small muted" style="margin-top:6px">${score?.submitted_at ? 'Submitted ' + fmtDate(score.submitted_at) : score?.updated_at ? 'Saved ' + fmtDate(score.updated_at) : 'Not started'}</div>
        </div>
      </div>
      ${d.judging_locked ? '<div class="notice warn">Judging has been locked by the organisers. Scores are read-only.</div>' : ''}
      ${!d.judging_locked && score?.status === 'submitted' && !d.allow_edit_after_submit ? '<div class="notice info">This score has been submitted and can no longer be edited.</div>' : ''}
      ${!d.judging_locked && score?.status === 'submitted' && d.allow_edit_after_submit ? '<div class="notice ok">Submitted. You may still revise and re-submit while judging is open.</div>' : ''}
      ${team.notes ? `<div class="notice info"><strong>Note from organisers:</strong> ${esc(team.notes)}</div>` : ''}
      ${team.description ? `<details class="group" style="margin-bottom:14px"><summary>Project description <span class="muted small" style="font-weight:400">(from the team's registration)</span></summary><div class="desc-body">${esc(team.description)}</div></details>` : ''}
      <div class="card">
        <form id="critForm" novalidate>
          ${criteria.map(c => `
            <div class="criterion" data-cid="${c.id}">
              <div>
                <div class="c-title">${esc(c.name)} <span class="muted small">/ ${fmt(c.max_marks)}</span></div>
                ${c.description ? `<div class="c-desc">${esc(c.description)}</div>` : ''}
              </div>
              <div class="c-num">
                <input type="number" name="c${c.id}" min="0" max="${c.max_marks}" step="0.5" inputmode="decimal" value="${items[c.id] ?? ''}" ${readOnly ? 'disabled' : ''} placeholder="0">
                <span class="max">/ ${fmt(c.max_marks)}</span>
              </div>
              <div class="c-range"><input type="range" min="0" max="${c.max_marks}" step="0.5" value="${items[c.id] ?? 0}" ${readOnly ? 'disabled' : ''} aria-label="${esc(c.name)}"></div>
            </div>`).join('')}
          <label class="field" style="margin-top:14px"><span>Comments for organisers (optional)</span>
            <textarea name="comments" maxlength="2000" ${readOnly ? 'disabled' : ''} placeholder="Strengths, weaknesses, anything the organisers should know">${esc(score?.comments || '')}</textarea></label>
          <div class="total-box">
            <div class="total"><span id="totalVal">0</span> <small>/ ${d.total_marks}</small></div>
            <div class="progress" style="max-width:220px"><div class="progress-bar" id="totalBar"></div></div>
            <span class="small muted" id="filledText"></span>
            ${readOnly ? '' : `<div class="actions">
              <button type="button" class="btn" id="draftBtn">Save draft</button>
              <button type="button" class="btn primary" id="submitBtn">${score?.status === 'submitted' ? 'Re-submit score' : 'Submit score'}</button>
            </div>`}
          </div>
        </form>
      </div>`;

    $('backBtn').addEventListener('click', backToList);
    const form = $('critForm');
    const rows = [...form.querySelectorAll('.criterion')];
    const recalc = () => {
      let total = 0, filled = 0;
      for (const r of rows) {
        const v = r.querySelector('input[type=number]').value;
        if (v !== '') { total += Number(v) || 0; filled++; }
      }
      $('totalVal').textContent = fmt(total);
      $('totalBar').style.width = `${Math.min(100, total / d.total_marks * 100)}%`;
      $('filledText').textContent = `${filled}/${rows.length} criteria scored`;
    };
    for (const r of rows) {
      const num = r.querySelector('input[type=number]'), range = r.querySelector('input[type=range]');
      const max = Number(num.max);
      num.addEventListener('input', () => {
        if (num.value !== '') { let v = Number(num.value); if (v > max) num.value = max; if (v < 0) num.value = 0; }
        range.value = num.value === '' ? 0 : num.value; state.dirty = true; recalc();
      });
      range.addEventListener('input', () => { num.value = range.value; state.dirty = true; recalc(); });
    }
    form.querySelector('textarea').addEventListener('input', () => { state.dirty = true; });
    recalc();

    const collect = () => {
      const items = {};
      for (const r of rows) { const v = r.querySelector('input[type=number]').value; if (v !== '') items[r.dataset.cid] = Number(v); }
      return { items, comments: form.querySelector('textarea').value };
    };
    const save = async (submit) => {
      const body = { ...collect(), submit };
      if (submit) {
        const missing = rows.filter(r => r.querySelector('input[type=number]').value === '');
        if (missing.length) { toast(`Please score all criteria before submitting (${missing.length} missing).`, 'warn'); missing[0].querySelector('input[type=number]').focus(); return; }
        const total = Object.values(body.items).reduce((s, x) => s + x, 0);
        if (!(await confirm(`Submit a total of ${fmt(total)} / ${d.total_marks} for ${team.name}?`, { title: 'Submit score', submitLabel: 'Submit' }))) return;
      }
      const btns = form.querySelectorAll('.actions button'); btns.forEach(b => b.disabled = true);
      try {
        await API.put(`/api/judge/scores/${state.teamId}`, body);
        state.dirty = false;
        toast(submit ? 'Score submitted. Thank you!' : 'Draft saved.', 'ok');
        await load();
      } catch (e) { toast(e.message, 'error'); }
      finally { btns.forEach(b => b.disabled = false); }
    };
    $('draftBtn')?.addEventListener('click', () => save(false));
    $('submitBtn')?.addEventListener('click', () => save(true));
  }

  function changePassword() {
    modal({
      title: 'Change password',
      body: `<label class="field"><span>Current password</span><input type="password" name="current_password" autocomplete="current-password" required></label>
             <label class="field"><span>New password</span><input type="password" name="new_password" autocomplete="new-password" minlength="8" required></label>
             <label class="field"><span>Confirm new password</span><input type="password" name="confirm" autocomplete="new-password" required></label>
             <div class="form-hint">Minimum 8 characters.</div>`,
      submitLabel: 'Update password',
      onSubmit: async (v, m) => {
        if (v.new_password !== v.confirm) throw new Error('Passwords do not match');
        await API.post('/api/auth/change-password', { current_password: v.current_password, new_password: v.new_password });
        toast('Password updated', 'ok'); m.close();
      },
    });
  }

  $('logoutBtn').addEventListener('click', async () => {
    if (state.dirty && !(await confirm('You have unsaved changes. Sign out anyway?', { danger: true, submitLabel: 'Sign out' }))) return;
    await API.post('/api/auth/logout'); location.href = '/';
  });
  $('pwBtn').addEventListener('click', changePassword);
  window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  load().then(async () => {
    const me = await API.get('/api/auth/me');
    UI.applyBranding(me.logo);
    if (me.user?.must_change_password) { toast('Please set a new password.', 'warn', 6000); changePassword(); }
  }).catch(e => { $('teamList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  // Light polling so lock/assignment changes appear without a reload
  setInterval(() => { if (!state.dirty) load().catch(() => {}); }, 60000);
})();
