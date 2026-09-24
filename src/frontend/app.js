const $ = (id) => document.getElementById(id);
// Escape anything that goes into innerHTML — project names and commit
// messages come from the network.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATE_CLASS = { READY: 'green', ERROR: 'red', BUILDING: 'yellow', QUEUED: 'yellow', INITIALIZING: 'yellow' };

function render(s) {
  $('version').textContent = 'v' + s.version;
  $('aboutVersion').textContent = 'Version ' + s.version;
  $('light').className = 'light ' + s.light;
  $('login').hidden = s.signedIn;
  $('main').hidden = !s.signedIn;
  if (!s.signedIn) return;

  $('userName').textContent = s.user?.name || s.user?.username || '';
  $('userEmail').textContent = s.user?.email || '';

  const scopes = [];
  // Accounts with a default team have no personal scope to list.
  if (!s.user?.defaultTeamId) scopes.push({ id: '', name: (s.user?.username ?? 'Personal') + ' (personal)' });
  scopes.push(...s.teams);
  $('scope').innerHTML = scopes
    .map((t) => `<option value="${esc(t.id)}"${(s.settings.teamId ?? '') === t.id ? ' selected' : ''}>${esc(t.name)}</option>`)
    .join('');
  $('prodOnly').checked = s.settings.productionOnly;

  $('mainErr').textContent = s.lastError ?? '';
  // With "all" followed every box is ticked; ticking narrows from there.
  $('follows').textContent = s.settings.watch == null ? 'all projects' : s.follows;
  $('followAll').hidden = s.settings.watch == null;
  $('projects').innerHTML = s.projects.length
    ? s.projects.map((p) => `
      <li data-url="${esc(p.url)}" class="${p.watched ? '' : 'unwatched'}">
        <input type="checkbox" class="watch" data-project="${esc(p.project)}"
          title="Include in the menu bar light"${p.watched && s.settings.watch != null ? ' checked' : ''}>
        <span class="dot ${STATE_CLASS[p.state] ?? 'gray'}"></span>
        <div class="proj">
          <div><b>${esc(p.project)}</b> <span class="tag">${esc(p.target)}</span></div>
          <div class="muted small">${esc(p.message ?? p.state.toLowerCase())}</div>
        </div>
        <span class="muted small">${esc(p.ago)}</span>
      </li>`).join('')
    : '<li class="muted">No deployments in this scope yet.</li>';
  $('checked').textContent = s.lastChecked
    ? 'Checked ' + new Date(s.lastChecked).toLocaleTimeString()
    : '';
}

tiny.api.on('state', render);

const showAbout = (show) => { $('about').hidden = !show; };
tiny.api.on('about', () => showAbout(true));
$('aboutBtn').addEventListener('click', () => showAbout(true));
$('aboutClose').addEventListener('click', () => showAbout(false));
$('about').addEventListener('click', (e) => { if (e.target === $('about')) showAbout(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') showAbout(false); });
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.ext');
  if (!a) return;
  e.preventDefault();
  tiny.api.call('openUrl', { url: a.dataset.url });
});

$('createToken').addEventListener('click', (e) => {
  e.preventDefault();
  tiny.api.call('openUrl', { url: 'https://vercel.com/account/tokens' });
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  $('loginBtn').disabled = true;
  try {
    render(await tiny.api.call('login', { token: $('token').value }));
    $('token').value = '';
  } catch (err) {
    $('loginErr').textContent = err.message ?? String(err);
  } finally {
    $('loginBtn').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  if (await tiny.dialog.confirm('Sign out of Vercel?', { detail: 'The token is removed from your Keychain.' }))
    render(await tiny.api.call('logout'));
});

$('scope').addEventListener('change', async () =>
  render(await tiny.api.call('setSettings', { teamId: $('scope').value })));
$('prodOnly').addEventListener('change', async () =>
  render(await tiny.api.call('setSettings', { productionOnly: $('prodOnly').checked })));
$('refresh').addEventListener('click', async () => render(await tiny.api.call('refresh')));

$('followAll').addEventListener('click', async () =>
  render(await tiny.api.call('toggleWatch', { project: null })));

$('projects').addEventListener('click', async (e) => {
  if (e.target.classList.contains('watch')) {
    render(await tiny.api.call('toggleWatch', { project: e.target.dataset.project }));
    return;
  }
  const url = e.target.closest('li')?.dataset.url;
  if (url) tiny.api.call('openUrl', { url });
});

// Start at login. 'unsupported' under `tinyjs dev`, so the row stays hidden there.
function renderLoginItem(status) {
  $('loginItemRow').hidden = status === 'unsupported';
  $('loginItem').checked = status === 'enabled' || status === 'requires-approval';
  $('loginItemNote').textContent = status === 'requires-approval'
    ? 'Allow it in System Settings → General → Login Items' : '';
}
$('loginItem').addEventListener('change', async () => {
  try {
    renderLoginItem(await tiny.app.launchAtLogin.set($('loginItem').checked));
  } catch {
    renderLoginItem(await tiny.app.launchAtLogin.get());
  }
});
tiny.app.launchAtLogin.get().then(renderLoginItem, () => renderLoginItem('unsupported'));

tiny.api.call('getState').then(render);
