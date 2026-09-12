(function () {
  'use strict';
  const form = document.getElementById('loginForm'), err = document.getElementById('loginError'), btn = document.getElementById('loginBtn');
  (async () => {
    try {
      const me = await API.get('/api/auth/me');
      if (me.event_name) document.getElementById('eventName').textContent = me.event_name;
      UI.applyBranding(me.logo);
      if (me.user) location.href = me.user.role === 'admin' ? '/admin' : '/judge';
    } catch (_) { /* not signed in */ }
  })();
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await API.post('/api/auth/login', { username: form.username.value.trim(), password: form.password.value });
      location.href = r.user.role === 'admin' ? '/admin' : '/judge';
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in'; }
  });
})();
