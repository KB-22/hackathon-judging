/* Shared API client + tiny UI toolkit (no framework, no build step). */
(function () {
  'use strict';

  const API = {
    async req(method, url, body) {
      const opts = { method, headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' }, credentials: 'same-origin' };
      if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const res = await fetch(url, opts);
      if (res.status === 401 && !url.startsWith('/api/auth/')) { location.href = '/'; throw new Error('Session expired'); }
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) data = await res.json(); else data = { error: await res.text() };
      if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
      return data;
    },
    get: url => API.req('GET', url),
    post: (url, body) => API.req('POST', url, body ?? {}),
    put: (url, body) => API.req('PUT', url, body ?? {}),
    del: url => API.req('DELETE', url),
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d).replace(/\.?0+$/, m => (m.startsWith('.') ? '' : m)));
  const fmtDate = iso => {
    if (!iso) return '—';
    const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const fmtDateFull = iso => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

  function toast(msg, type = 'ok', ms = 3500) {
    const host = document.getElementById('toastHost'); if (!host) return alert(msg);
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg; host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }

  /** Modal: body is an HTML string (form fields with name= attributes). onSubmit(values, modal) may return a Promise; throw to keep open. */
  function modal({ title, body, submitLabel = 'Save', cancelLabel = 'Cancel', onSubmit, danger = false, wide = false, hideSubmit = false }) {
    const host = document.getElementById('modalHost');
    const wrap = document.createElement('div'); wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
      <form class="modal-body" novalidate>${body}<div class="form-error" data-error hidden></div></form>
      <div class="modal-foot">
        <button class="btn ghost" data-close type="button">${esc(cancelLabel)}</button>
        ${hideSubmit ? '' : `<button class="btn ${danger ? 'danger' : 'primary'}" data-submit type="button">${esc(submitLabel)}</button>`}
      </div></div>`;
    host.appendChild(wrap);
    const form = wrap.querySelector('form');
    const errEl = wrap.querySelector('[data-error]');
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    const submit = async () => {
      errEl.hidden = true;
      const btn = wrap.querySelector('[data-submit]'); if (btn) { btn.disabled = true; }
      try { if (onSubmit) await onSubmit(formValues(form), { close, form, wrap }); else close(); }
      catch (e) { errEl.textContent = e.message; errEl.hidden = false; if (btn) btn.disabled = false; }
    };
    wrap.querySelector('[data-submit]')?.addEventListener('click', submit);
    form.addEventListener('submit', e => { e.preventDefault(); submit(); });
    const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea'); if (first) setTimeout(() => first.focus(), 30);
    return { close, form, wrap };
  }

  function confirmDialog(message, { title = 'Please confirm', danger = false, submitLabel = 'Confirm' } = {}) {
    return new Promise(resolve => {
      const m = modal({ title, body: `<p>${esc(message)}</p>`, submitLabel, danger, onSubmit: () => { resolve(true); m.close(); } });
      m.wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => resolve(false)));
      m.wrap.addEventListener('click', e => { if (e.target === m.wrap) resolve(false); });
    });
  }

  function formValues(container) {
    const out = {};
    container.querySelectorAll('input[name], select[name], textarea[name]').forEach(el => {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    });
    return out;
  }

  const options = (list, selected, blank = '— none —', labelOf = x => x.name, valueOf = x => x.id) =>
    (blank === null ? '' : `<option value="">${esc(blank)}</option>`) +
    list.map(x => `<option value="${esc(valueOf(x))}" ${String(valueOf(x)) === String(selected ?? '') ? 'selected' : ''}>${esc(labelOf(x))}</option>`).join('');

  /**
   * Sortable data table. columns: [{key,label,fmt(row)->html,num:boolean,sortKey, cls}]
   * Renders into container; clicking a header sorts.
   */
  function dataTable(container, { columns, rows, sortKey = null, sortDir = 'asc', empty = 'No data', rowAttrs = () => '', footer = null, compact = false }) {
    let state = { sortKey, sortDir };
    const render = () => {
      let data = rows.slice();
      if (state.sortKey) {
        const col = columns.find(c => (c.sortKey || c.key) === state.sortKey);
        const key = state.sortKey;
        data.sort((a, b) => {
          let va = a[key], vb = b[key];
          const na = va === null || va === undefined || va === '', nb = vb === null || vb === undefined || vb === '';
          if (na && nb) return 0; if (na) return 1; if (nb) return -1;
          if (col && col.num) { va = Number(va); vb = Number(vb); return state.sortDir === 'asc' ? va - vb : vb - va; }
          const r = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
          return state.sortDir === 'asc' ? r : -r;
        });
      }
      const head = columns.map(c => {
        const k = c.sortKey || c.key; const active = state.sortKey === k;
        return `<th class="${c.num ? 'num' : ''} ${c.cls || ''} ${active ? 'sorted' : ''}" data-sort="${esc(k)}">${esc(c.label)}${active ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
      }).join('');
      const body = data.length ? data.map(r => `<tr ${rowAttrs(r)}>${columns.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${columns.length}" class="empty">${esc(empty)}</td></tr>`;
      container.innerHTML = `<div class="table-wrap"><table class="table ${compact ? 'compact' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${footer ? `<tfoot>${footer}</tfoot>` : ''}</table></div>`;
      container.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; else { state.sortKey = k; state.sortDir = 'asc'; }
        render();
      }));
    };
    render();
    return { render };
  }

  const badge = (text, type = '') => `<span class="badge ${type}">${esc(text)}</span>`;
  const statusBadge = s => s === 'submitted' ? badge('Submitted', 'ok') : s === 'draft' ? badge('Draft', 'warn') : badge('Pending', 'muted');

  /**
   * Swaps the text brand mark for public/img/logo.png when that file exists.
   * Pages pass the `logo` flag from /api/auth/me, so no request is made for a
   * logo that was never added.
   */
  function applyBranding(hasLogo) {
    if (!hasLogo) return;
    document.querySelectorAll('.brand-mark').forEach(m => {
      if (m.classList.contains('has-logo')) return;
      const img = new Image();
      img.src = '/img/logo.png';
      img.alt = '';
      m.textContent = '';
      m.classList.add('has-logo');
      m.appendChild(img);
    });
  }

  window.API = API;
  window.UI = { esc, fmt, fmtDate, fmtDateFull, toast, modal, confirm: confirmDialog, formValues, options, dataTable, badge, statusBadge, applyBranding };
})();
