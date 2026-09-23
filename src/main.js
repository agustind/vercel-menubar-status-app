// Vercel deployment status light for the macOS menu bar.
//
// The backend owns everything: the token (Keychain), polling the Vercel API,
// and the tray icon/menu. The window (src/frontend) is only the login /
// settings screen and talks to us through `api` below.

import { ICONS } from './icons.js';

const API = 'https://api.vercel.com';
const TOKEN_KEY = 'vercel-token';
const POLL_IDLE = 60_000;   // nothing in flight
const POLL_BUSY = 10_000;   // something is building — check more often

const BUILDING = new Set(['BUILDING', 'QUEUED', 'INITIALIZING']);

let app;
let token = null;
let user = null;          // { username, name, email, defaultTeamId }
let teams = [];           // [{ id, name, slug }]
// watch: null = the light follows every project, else only these project names.
let settings = { teamId: null, productionOnly: false, watch: null };
let projects = [];        // latest deployment per project, newest first
let light = 'gray';
let lastError = null;
let lastChecked = null;
let timer = null;
let iconPaths = {};
let seenStates = null;    // uid -> state, for "finished" notifications

// --- Vercel API ------------------------------------------------------------

async function vercel(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ''),
  ).toString();
  const res = await fetch(API + path + (qs ? '?' + qs : ''), {
    headers: { authorization: 'Bearer ' + token },
  });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.error?.message ?? 'Vercel API ' + res.status);
  // Only a dead token signs us out; a 403 for one team's scope shouldn't.
  err.auth = res.status === 401 || body.error?.invalidToken === true;
  throw err;
}

async function loadAccount() {
  const [{ user: u }, { teams: t = [] }] = await Promise.all([
    vercel('/v2/user'),
    vercel('/v2/teams', { limit: 100 }),
  ]);
  user = { username: u.username, name: u.name, email: u.email, defaultTeamId: u.defaultTeamId ?? null };
  teams = t.map((x) => ({ id: x.id, name: x.name, slug: x.slug }));
  // Newer Vercel accounts have no personal scope — start on the default team.
  if (settings.teamId == null && user.defaultTeamId) settings.teamId = user.defaultTeamId;
  if (settings.teamId && !teams.some((x) => x.id === settings.teamId)) settings.teamId = null;
}

async function fetchDeployments() {
  const { deployments = [] } = await vercel('/v6/deployments', {
    limit: 100,
    teamId: settings.teamId,
    target: settings.productionOnly ? 'production' : null,
  });
  // The API returns newest first; keep the first live one we see per project.
  const byProject = new Map();
  for (const d of deployments) {
    const state = d.state ?? d.readyState;
    if (state === 'CANCELED' || byProject.has(d.name)) continue;
    byProject.set(d.name, {
      uid: d.uid,
      project: d.name,
      state,
      target: d.target ?? 'preview',
      created: d.created ?? d.createdAt,
      url: d.inspectorUrl || (d.url ? 'https://' + d.url : null),
      message: d.meta?.githubCommitMessage?.split('\n')[0] ?? null,
    });
  }
  return [...byProject.values()];
}

const isWatched = (name) => settings.watch == null || settings.watch.includes(name);

function lightFor(list) {
  if (list.some((p) => p.state === 'ERROR')) return 'red';
  if (list.some((p) => BUILDING.has(p.state))) return 'yellow';
  return list.length ? 'green' : 'gray';
}

// --- polling ---------------------------------------------------------------

async function refresh() {
  clearTimeout(timer);
  timer = null;
  if (!token) return render();
  try {
    if (!user) await loadAccount();
    const next = await fetchDeployments();
    notifyFinished(next);
    projects = next;
    light = lightFor(projects.filter((p) => isWatched(p.project)));
    lastError = null;
  } catch (e) {
    lastError = e.message;
    light = 'gray';
    if (e.auth) {
      await logout();
      app.window('main').show();
      return;
    }
  }
  lastChecked = Date.now();
  render();
  clearTimeout(timer);   // an overlapping refresh may have scheduled one
  timer = setTimeout(refresh, light === 'yellow' ? POLL_BUSY : POLL_IDLE);
}

// A notification when a deployment we saw building lands (or fails).
function notifyFinished(next) {
  const prev = seenStates;
  seenStates = new Map(next.map((p) => [p.uid, p.state]));
  if (!prev) return;   // first poll after launch/login — don't spam history
  for (const p of next) {
    const before = prev.get(p.uid);
    if (!before || !BUILDING.has(before) || BUILDING.has(p.state)) continue;
    if (p.state === 'ERROR') app.notify({ title: `❌ ${p.project} failed`, body: p.message ?? 'Deployment errored' });
    if (p.state === 'READY') app.notify({ title: `✅ ${p.project} deployed`, body: p.message ?? `${p.target} is live` });
  }
}

// --- tray ------------------------------------------------------------------

const DOT = { READY: '🟢', ERROR: '🔴', BUILDING: '🟡', QUEUED: '🟡', INITIALIZING: '🟡' };
const SUMMARY = {
  green: 'All deployments ready',
  yellow: 'Deployment in progress…',
  red: 'A deployment failed',
  gray: 'No deployments',
};
const SINGLE = { green: 'ready', yellow: 'building…', red: 'failed', gray: 'no deployments' };

// "saturn-app: ready" when the light follows one project, else the roll-up.
function summary() {
  if (settings.watch?.length === 1) return settings.watch[0] + ': ' + SINGLE[light];
  return SUMMARY[light];
}

function followsLabel() {
  if (settings.watch == null) return 'All projects';
  return settings.watch.length === 1 ? settings.watch[0] : settings.watch.length + ' projects';
}

// Picking a project while following all narrows to just it; after that,
// clicks toggle. Unticking the last one goes back to all.
function toggleWatch(name) {
  if (name == null || settings.watch == null) settings.watch = name == null ? null : [name];
  else if (settings.watch.includes(name)) settings.watch = settings.watch.filter((n) => n !== name);
  else settings.watch = [...settings.watch, name];
  if (settings.watch?.length === 0) settings.watch = null;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function render() {
  const menu = [];
  if (!token) {
    menu.push({ id: 'status', label: 'Not signed in', enabled: false });
    menu.push({ id: 'settings', label: 'Sign in to Vercel…' });
  } else {
    const scope = teams.find((t) => t.id === settings.teamId)?.name ?? user?.username ?? '';
    menu.push({ id: 'status', label: lastError ? '⚠️ ' + lastError.slice(0, 60) : summary(), enabled: false });
    if (scope) menu.push({ id: 'scope', label: 'Scope: ' + scope, enabled: false });
    menu.push({ separator: true });
    projects.slice(0, 15).forEach((p, i) => {
      menu.push({ id: 'p:' + i, label: `${DOT[p.state] ?? '⚪️'}  ${p.project} — ${ago(p.created)}` });
    });
    if (projects.length) {
      menu.push({ separator: true });
      menu.push({
        id: 'follows',
        label: 'Light follows: ' + followsLabel(),
        submenu: [
          { id: 'w:all', label: 'All projects', checked: settings.watch == null },
          { separator: true },
          ...projects.slice(0, 30).map((p, i) => ({
            id: 'w:' + i, label: p.project, checked: settings.watch?.includes(p.project) ?? false,
          })),
        ],
      });
      menu.push({ separator: true });
    }
    menu.push({ id: 'refresh', label: 'Refresh Now', key: 'r' });
    menu.push({ id: 'dashboard', label: 'Open Vercel Dashboard' });
    menu.push({ id: 'settings', label: 'Settings…', key: ',' });
  }
  menu.push({ separator: true });
  menu.push({ id: 'about', label: 'About Vercel Menubar Status' });
  menu.push({ id: 'quit', label: 'Quit', key: 'q' });

  app.tray.set({
    icon: iconPaths[light],
    template: false,   // keep the red/yellow/green instead of a mono silhouette
    tooltip: 'Vercel: ' + (token ? summary() : 'not signed in'),
    menu,
  });
  app.push('state', publicState());
}

function publicState() {
  return {
    version: app.info.version,
    signedIn: !!token,
    user,
    teams,
    settings,
    light,
    follows: followsLabel(),
    lastError,
    lastChecked,
    projects: projects.map((p) => ({ ...p, ago: ago(p.created), watched: isWatched(p.project) })),
  };
}

async function writeIcons() {
  const dir = app.paths.cache + '/tray';
  await tjs.makeDir(dir, { recursive: true });
  for (const [name, b64] of Object.entries(ICONS)) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const path = `${dir}/${name}.png`;
    await tjs.writeFile(path, bytes);
    iconPaths[name] = path;
  }
}

async function logout() {
  token = null;
  user = null;
  teams = [];
  projects = [];
  seenStates = null;
  settings.teamId = null;
  light = 'gray';
  clearTimeout(timer);
  await app.secrets.delete(TOKEN_KEY);
  await app.store.set('settings', settings);
  render();
}

// --- page api --------------------------------------------------------------

export const api = {
  getState: async () => publicState(),

  async login({ token: t }) {
    t = String(t ?? '').trim();
    if (!t) throw new Error('Paste a Vercel access token first');
    const prev = token;
    token = t;
    user = null;
    settings.teamId = null;
    try {
      await loadAccount();
    } catch (e) {
      token = prev;
      throw e.auth ? new Error('That token was rejected by Vercel') : e;
    }
    await app.secrets.set(TOKEN_KEY, token);
    await app.store.set('settings', settings);
    seenStates = null;
    await refresh();
    return publicState();
  },

  logout: async () => (await logout(), publicState()),

  async setSettings(patch) {
    if ('teamId' in patch && (patch.teamId || null) !== settings.teamId) {
      settings.teamId = patch.teamId || null;
      settings.watch = null;   // project names don't carry across scopes
    }
    if ('productionOnly' in patch) settings.productionOnly = !!patch.productionOnly;
    await app.store.set('settings', settings);
    seenStates = null;
    await refresh();
    return publicState();
  },

  // Only the light changes — no need to hit the API again.
  async toggleWatch({ project }) {
    toggleWatch(project ?? null);
    await app.store.set('settings', settings);
    light = lastError ? 'gray' : lightFor(projects.filter((p) => isWatched(p.project)));
    render();
    return publicState();
  },

  refresh: async () => (await refresh(), publicState()),

  openUrl: async ({ url }) => {
    if (!/^https:\/\//.test(url)) throw new Error('refusing non-https url');
    return app.shell.open(url);
  },
};

// --- lifecycle -------------------------------------------------------------

export async function init(a) {
  app = a;
  app.setHideOnClose(true);
  await writeIcons();
  settings = { ...settings, ...((await app.store.get('settings')) ?? {}) };
  token = await app.secrets.get(TOKEN_KEY);
  render();
  if (token) refresh();
  else app.window('main').show();
  // Keep the "5m ago" labels honest between polls.
  setInterval(() => token && render(), 60_000);
}

export function onTray(id, a) {
  if (id === 'quit') return a.quit();
  if (id === 'refresh') return refresh();
  if (id === 'settings') return a.window('main').show();
  if (id === 'about') {
    a.window('main').show();
    return a.push('about', null);
  }
  if (id === 'dashboard') {
    const slug = teams.find((t) => t.id === settings.teamId)?.slug;
    return api.openUrl({ url: 'https://vercel.com/' + (slug ?? '') });
  }
  if (id === 'w:all') return api.toggleWatch({ project: null });
  if (id?.startsWith('w:')) return api.toggleWatch({ project: projects[Number(id.slice(2))]?.project });
  if (id?.startsWith('p:')) {
    const p = projects[Number(id.slice(2))];
    if (p?.url) api.openUrl({ url: p.url });
  }
}

export function onSystem(kind) {
  if (kind === 'wake') refresh();
  if (kind === 'sleep') clearTimeout(timer);
}
