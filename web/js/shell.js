import {
  api,
  applyBranding,
  applyTheme,
  appIcon,
  brandLockup,
  chime,
  debounce,
  esc,
  fileIcon,
  fmtDate,
  icon,
  initials,
  parseRoute,
  readTheme,
  state,
  timeAgo,
  toast,
  unlockAudio
} from './core.js';
import { renderLogin } from './apps/login.js';

const MODULES = {
  home: () => import('./apps/home.js'),
  search: () => import('./apps/search.js'),
  me: () => import('./apps/me.js'),
  admin: () => import('./apps/admin.js'),
  store: () => import('./apps/store.js'),
  viewer: () => import('./apps/viewer.js'),
  'cc:files': () => import('./apps/files.js'),
  'cc:calendar': () => import('./apps/calendar.js'),
  'cc:mail': () => import('./apps/mail.js'),
  'cc:contacts': () => import('./apps/contacts.js'),
  'cc:editor': () => import('./apps/editor.js'),
  'cc:tasks': () => import('./apps/tasks.js'),
  'cc:connect': () => import('./apps/connect.js'),
  'cc:media': () => import('./apps/media.js'),
  'cc:assistant': () => import('./apps/assistant.js')
};

const ROUTE_TITLES = {
  home: 'Home',
  search: 'Search',
  me: 'Me',
  admin: 'Admin',
  store: 'App Store',
  viewer: 'Preview'
};

/** Apps that own the whole content area instead of the padded page grid. */
const FULL_BLEED = new Set(['viewer', 'cc:connect']);
const POLL_MS = 20000;

let rootEl = null;
let activeCleanup = null;
let drawerEl = null;
let activityEl = null;
let paletteEl = null;
let pollTimer = null;
let lastUnread = 0;

const DEFAULT_PINS = ['cc:files', 'cc:calendar', 'cc:mail', 'cc:connect'];
let pinned = [];

function brandInner() {
  const branding = state.branding || {};
  return brandLockup({
    word: branding.logoWord,
    logo: branding.logo,
    title: state.server?.name || 'CoolCloud'
  });
}

const RECENT_KEY = 'cc:recentApps';

function recentApps() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberApp(id) {
  if (!id || id === 'home' || id === 'viewer') return;
  const next = [id, ...recentApps().filter((item) => item !== id)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** Split installed apps from widgets, which render on Home instead of in a tab. */
function applySessionApps(session) {
  const all = session.apps || [];
  state.allApps = all;
  state.apps = all.filter((app) => app.type !== 'widget');
  state.widgets = all.filter((app) => app.type === 'widget');
}

function loadPins() {
  const saved = state.user?.prefs?.pinnedApps;
  const ids = Array.isArray(saved) ? saved : DEFAULT_PINS;
  return ids.filter((id) => state.apps.some((app) => app.id === id));
}

function pinnedRows() {
  if (!pinned.length) {
    return `<p class="pinned-empty">Nothing pinned. <button data-drawer>Open all apps</button> and hit the pin.</p>`;
  }
  return pinned
    .map((id) => {
      const app = state.apps.find((item) => item.id === id);
      if (!app) return '';
      return `<div class="nav-item-wrap">
        <button class="nav-item" data-nav="${esc(app.id)}" title="${esc(app.name)}" aria-current="false">
          ${icon(app.icon)}<span class="nav-text">${esc(app.name)}</span>
        </button>
        <button class="nav-unpin" data-unpin="${esc(app.id)}" title="Unpin ${esc(app.name)}" aria-label="Unpin ${esc(
          app.name
        )}">${icon('fa-solid fa-xmark')}</button>
      </div>`;
    })
    .join('');
}

function renderPinned() {
  const nav = document.getElementById('pinned-nav');
  if (nav) nav.innerHTML = pinnedRows();
  document.querySelectorAll('[data-pin]').forEach((node) => {
    node.setAttribute('aria-pressed', String(pinned.includes(node.dataset.pin)));
  });
}

async function togglePin(id) {
  const next = new Set(pinned);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  pinned = [...next];
  renderPinned();
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { prefs: { pinnedApps: pinned } } });
    state.user = user;
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function shellMarkup() {
  const user = state.user;
  return `<div class="shell" id="shell">
    <aside class="sidebar" id="sidebar">
      <button class="brand" id="brand" type="button" title="Home">${brandInner()}</button>
      ${
        state.user?.prefs?.editionBadge === false
          ? ''
          : `<a class="edition-badge" id="edition-badge" href="${esc(state.server?.website || 'https://openhcat.github.io/cc-appregistry/')}" target="_blank" rel="noopener noreferrer" title="Get Enterprise for more apps">
              <i class="fa-solid fa-cloud"></i>
              <span>${state.server?.edition === 'enterprise' ? 'Enterprise' : 'Community'} <b>v${esc(state.server?.release || '2.0.0')}</b></span>
            </a>`
      }
      <div class="sidebar-scroll">
        <nav class="nav" aria-label="Main">
          <button class="nav-item" data-nav="search" title="Search" aria-current="false">${icon(
            'fa-solid fa-magnifying-glass'
          )}<span class="nav-text">Search</span><span class="kbd">Ctrl K</span></button>
          <button class="nav-item" data-nav="activity" title="Activity" aria-current="false">${icon(
            'fa-regular fa-bell'
          )}<span class="nav-text">Activity</span><span class="nav-badge hidden" id="bell-count">0</span></button>
          <button class="nav-item" data-nav="drawer" title="All apps" aria-current="false">${icon(
            'fa-solid fa-table-cells-large'
          )}<span class="nav-text">All apps</span><span class="kbd">A</span></button>
        </nav>

        <div class="nav-label-row">
          <span class="nav-label">Pinned</span>
          <button data-drawer title="Pin an app" aria-label="Pin an app">${icon('fa-solid fa-plus')}</button>
        </div>
        <nav class="nav" aria-label="Pinned apps" id="pinned-nav">${pinnedRows()}</nav>
      </div>

      <div class="sidebar-foot">
        <div class="side-links">
          <a class="side-link" href="${esc(state.server?.website || 'https://openhcat.github.io/cc-appregistry/')}" target="_blank" rel="noopener noreferrer" title="CoolCloud website" aria-label="CoolCloud website">${icon(
            'fa-solid fa-globe'
          )}</a>
          ${
            user.role === 'admin'
              ? `<button class="side-link" data-nav="admin" title="Admin">${icon('fa-solid fa-sliders')}</button>`
              : ''
          }
          <button class="side-link" data-theme-toggle title="Switch theme">${icon('fa-regular fa-moon')}</button>
          <button class="side-link" data-logout title="Sign out">${icon('fa-solid fa-arrow-right-from-bracket')}</button>
        </div>
        <button class="side-user" data-nav="me" title="${esc(user.name || user.username)}">
          <span class="avatar">${esc(initials(user.name || user.username))}</span>
          <span class="side-user-text grow" style="min-width:0">
            <span class="side-user-name truncate">${esc(user.name || user.username)}</span>
            <span class="side-user-meta truncate">${user.role === 'admin' ? 'Administrator' : 'Member'}</span>
          </span>
        </button>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" id="menu-btn" title="Menu" aria-label="Menu">${icon('fa-solid fa-bars')}</button>
        <button class="icon-btn collapse-btn" id="collapse" title="Collapse sidebar" aria-label="Collapse sidebar">${icon(
          'fa-solid fa-angles-left'
        )}</button>
        <div class="tabstrip">
          <button class="tab-home" id="tab-home" title="Home" aria-label="Home" aria-current="false">${icon(
            'fa-solid fa-house'
          )}</button>
          <span class="tab-sep" aria-hidden="true"></span>
          <div class="tabs" id="tabstrip" role="tablist" aria-label="Open tabs"></div>
        </div>
        <div class="topbar-actions">
          <button class="icon-btn" id="search-btn" title="Search (Ctrl K)" aria-label="Search">${icon(
            'fa-solid fa-magnifying-glass'
          )}</button>
          <button class="icon-btn" id="new-tab" title="All apps (A)" aria-label="All apps">${icon(
            'fa-solid fa-grip'
          )}</button>
        </div>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`;
}

export async function init() {
  applyTheme(readTheme());
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  rootEl = document.getElementById('root');
  window.addEventListener('cc:unauthorized', () => renderLogin(rootEl, afterLogin));
  window.addEventListener('hashchange', () => {
    const route = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    if (route) {
      const found = state.tabs.find((tab) => tab.route === route);
      if (found) activateTab(found.id, { silent: true });
      else openTab(route);
    }
  });
  try {
    const identity = await api('/api/branding');
    state.server = {
      name: identity.name,
      organization: identity.organization || {},
      website: identity.website,
      edition: identity.edition,
      release: identity.release || '',
      sso: identity.sso || {}
    };
    applyBranding(identity.branding, identity.name);
  } catch {
    /* an older server without /api/branding still works */
  }
  try {
    const session = await api('/api/auth/session');
    afterLogin(session);
  } catch {
    renderLogin(rootEl, afterLogin);
  }
}

function afterLogin(session) {
  state.user = session.user;
  applySessionApps(session);
  state.server = session.server || {};
  applyBranding(state.server.branding, state.server.name);
  pinned = loadPins();
  rootEl = document.getElementById('root');
  rootEl.innerHTML = shellMarkup();
  wireShell();
  applySidebarPrefs();
  refreshNotifications({ silent: true });
  startPolling();
  // Home is a permanent view behind the home icon, never a closable tab.
  openTab('home', { focus: false });
  const last = decodeURIComponent(location.hash.replace(/^#\/?/, '')) || sessionStorage.getItem('cc:lastRoute') || 'home';
  openTab(last === 'home' ? 'home' : last, { focus: true });
}

/* --------------------------------- chrome -------------------------------- */

export function applySidebarPrefs() {
  const prefs = state.user?.prefs || {};
  const badge = document.getElementById('edition-badge');
  if (badge) badge.style.display = prefs.editionBadge === false ? 'none' : '';
  let stored = null;
  try {
    stored = localStorage.getItem('cc:rail');
  } catch {
    stored = null;
  }
  const wantRail = prefs.railDefault === undefined ? stored === null || stored === '1' : Boolean(prefs.railDefault);
  setRail(wantRail, { persist: false });
}

function setRail(on, { persist = true } = {}) {
  const shell = document.getElementById('shell');
  if (!shell) return;
  shell.classList.toggle('rail', Boolean(on));
  const button = document.getElementById('collapse');
  if (button) {
    button.innerHTML = icon(on ? 'fa-solid fa-angles-right' : 'fa-solid fa-angles-left');
    button.title = on ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-label', button.title);
  }
  if (persist) {
    try {
      localStorage.setItem('cc:rail', on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
}

/** Re-paint the brand after Admin -> Personalization changes it. */
export function refreshBrand() {
  applyBranding(state.server?.branding, state.server?.name);
  const brand = document.getElementById('brand');
  if (brand) brand.innerHTML = brandInner();
  renderPinned();
  renderTabstrip();
}

function wireShell() {
  const shell = document.getElementById('shell');
  shell.addEventListener('click', (event) => {
    const unpin = event.target.closest('[data-unpin]');
    if (unpin) {
      event.preventDefault();
      return togglePin(unpin.dataset.unpin);
    }
    if (event.target.closest('[data-drawer]')) return openDrawer();
    if (event.target.closest('#brand')) return openTab('home');
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      const target = nav.dataset.nav;
      if (target === 'drawer') return openDrawer();
      if (target === 'activity') {
        closeNav();
        return openActivity();
      }
      openTab(target);
      closeNav();
      return;
    }
    if (event.target.closest('[data-theme-toggle]')) {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      const button = shell.querySelector('[data-theme-toggle]');
      button.innerHTML = icon(next === 'dark' ? 'fa-regular fa-sun' : 'fa-regular fa-moon');
      return;
    }
    if (event.target.closest('[data-logout]')) {
      api('/api/auth/logout', { method: 'POST' }).finally(() => {
        state.user = null;
        state.tabs = [];
        stopPolling();
        sessionStorage.removeItem('cc:lastRoute');
        renderLogin(document.getElementById('root'), afterLogin);
      });
    }
  });

  document.getElementById('collapse').addEventListener('click', () => {
    const shell = document.getElementById('shell');
    shell.dataset.railHover = '';
    setRail(!shell.classList.contains('rail'));
  });

  /* A minimized sidebar opens on hover so the edition badge and labels can be
     read without turning the rail off for good. */
  const sidebar = document.getElementById('sidebar');
  sidebar.addEventListener('mouseenter', () => {
    const shell = document.getElementById('shell');
    if (!shell.classList.contains('rail') || state.user?.prefs?.railHover === false) return;
    shell.dataset.railHover = '1';
    setRail(false, { persist: false });
  });
  sidebar.addEventListener('mouseleave', () => {
    const shell = document.getElementById('shell');
    if (shell.dataset.railHover !== '1') return;
    shell.dataset.railHover = '';
    setRail(true, { persist: false });
  });
  document.getElementById('search-btn').addEventListener('click', () => openPalette());
  document.getElementById('new-tab').addEventListener('click', openDrawer);
  document.getElementById('tab-home').addEventListener('click', () => openTab('home'));
  document.getElementById('menu-btn').addEventListener('click', () => {
    shell.classList.toggle('nav-open');
    if (shell.classList.contains('nav-open')) {
      const scrim = document.createElement('div');
      scrim.className = 'nav-scrim';
      scrim.addEventListener('click', closeNav);
      shell.appendChild(scrim);
    } else {
      shell.querySelector('.nav-scrim')?.remove();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePalette();
      closeDrawer();
      closeActivity();
      closeNav();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
      if (!state.active) return;
      // Home has no tab to close, but the browser window must not close either.
      event.preventDefault();
      const activeTab = state.tabs.find((tab) => tab.id === state.active);
      if (activeTab?.app !== 'home') closeTab(state.active);
    }
    if (event.key.toLowerCase() === 'a' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.getElementById('modal-root')?.children.length) return;
      event.preventDefault();
      openDrawer();
    }
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 940) closeNav();
  });
}

function closeNav() {
  const shell = document.getElementById('shell');
  shell?.classList.remove('nav-open');
  shell?.querySelector('.nav-scrim')?.remove();
}

/* --------------------------------- tabs ---------------------------------- */

function tabTitle(app, params, meta) {
  if (app === 'viewer') {
    const path = params.get('path') || '';
    return path.split('/').pop() || 'Preview';
  }
  if (app === 'cc:editor') {
    const file = params.get('file') || '';
    if (file) return file.split('/').pop();
  }
  if (app === 'cc:connect') {
    const room = params.get('room') || '';
    return room ? `#${room.replace(/^dm-/, '')}` : 'Connect';
  }
  if (meta) return meta.name;
  return ROUTE_TITLES[app] || app.replace(/^cc:/, '');
}

export function openTab(route, { focus = true, title = null } = {}) {
  const { app, params } = parseRoute(route);
  if (!app) return;
  rememberApp(app);
  const existing = state.tabs.find((tab) => tab.route === route);
  if (existing) {
    if (focus) activateTab(existing.id);
    return existing.id;
  }
  const meta = state.apps.find((item) => item.id === app || item.id === `cc:${app}`) || null;
  const tab = {
    id: `${app}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    route,
    app,
    params,
    title: title || tabTitle(app, params, meta),
    icon: meta?.icon || appIcon(app),
    cleanup: null
  };
  state.tabs.push(tab);
  renderTabstrip();
  if (focus) activateTab(tab.id);
  return tab.id;
}

export function setTabTitle(id, title) {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return;
  tab.title = title;
  renderTabstrip();
}

export function setTabDirty(id, dirty) {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return;
  tab.dirty = dirty;
  renderTabstrip();
}

export function closeTab(id) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  if (state.tabs[index].app === 'home') return;
  const [tab] = state.tabs.splice(index, 1);
  if (tab.cleanup) {
    try {
      tab.cleanup();
    } catch {
      /* ignore cleanup failures */
    }
  }
  if (state.active === id) {
    const next =
      state.tabs[index - 1] || state.tabs[index] || state.tabs.find((item) => item.app === 'home');
    if (next) activateTab(next.id);
    else openTab('home');
  } else {
    renderTabstrip();
  }
}

function renderTabstrip() {
  const strip = document.getElementById('tabstrip');
  if (!strip) return;
  const visible = state.tabs.filter((tab) => tab.app !== 'home');
  strip.innerHTML = visible.length
    ? visible
    .map(
      (tab) => `<button class="tab ${tab.id === state.active ? 'active' : ''} ${tab.dirty ? 'dirty' : ''}" role="tab" aria-selected="${
        tab.id === state.active
      }" data-tab="${tab.id}" title="${esc(tab.title)}">
        <i class="${esc(tab.icon)} tab-icon" aria-hidden="true"></i>
        <span class="tab-title">${esc(tab.title)}</span>
        <span class="tab-close" data-close="${tab.id}" role="button" aria-label="Close ${esc(tab.title)}">${icon(
          'fa-solid fa-xmark'
        )}</span>
      </button>`
    )
    .join('')
    : `<span class="tabstrip-empty">No tabs open — pick an app from All apps</span>`;

  strip.querySelectorAll('[data-tab]').forEach((node) => {
    node.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) return;
      activateTab(node.dataset.tab);
    });
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) closeTab(node.dataset.tab);
    });
  });
  strip.querySelectorAll('[data-close]').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(node.dataset.close);
    });
  });
  const activeNode = strip.querySelector('[data-tab][aria-selected="true"]');
  activeNode?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const home = document.getElementById('tab-home');
  const activeTab = state.tabs.find((tab) => tab.id === state.active);
  if (home) home.setAttribute('aria-current', activeTab?.app === 'home' ? 'true' : 'false');
}

async function activateTab(id, { silent = false } = {}) {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return;
  if (activeCleanup) {
    try {
      activeCleanup();
    } catch {
      /* ignore */
    }
    activeCleanup = null;
  }
  state.active = id;
  renderTabstrip();
  document.querySelectorAll('[data-nav]').forEach((node) => {
    node.setAttribute('aria-current', node.dataset.nav === tab.app ? 'true' : 'false');
  });
  if (!silent) history.replaceState(null, '', `#/${tab.route}`);
  sessionStorage.setItem('cc:lastRoute', tab.route);

  const view = document.getElementById('view');
  view.innerHTML = '';
  view.scrollTop = 0;

  const ctx = {
    user: state.user,
    server: state.server,
    apps: state.apps,
    params: tab.params,
    tabId: tab.id,
    openTab,
    closeTab,
    setTabTitle,
    setTabDirty,
    openDrawer,
    openActivity
  };

  const meta = state.apps.find((app) => app.id === tab.app);
  view.classList.toggle('flush', FULL_BLEED.has(tab.app) || Boolean(meta && meta.kind === 'external'));

  if (MODULES[tab.app]) {
    try {
      const module = await MODULES[tab.app]();
      if (state.active !== id) return;
      const cleanup = await module.default(view, ctx);
      tab.cleanup = typeof cleanup === 'function' ? cleanup : null;
      activeCleanup = tab.cleanup;
    } catch (err) {
      console.error(err);
      view.classList.remove('flush');
      view.innerHTML = `<div class="page"><div class="empty">${icon(
        'fa-solid fa-triangle-exclamation'
      )}<p>${esc(err.message || 'This app failed to load')}</p></div></div>`;
    }
    return;
  }

  if (meta && meta.kind === 'external') {
    const frame = document.createElement('iframe');
    frame.className = 'ext-app';
    frame.src = `/app-assets/${encodeURIComponent(meta.developer)}/${encodeURIComponent(
      meta.shortName || meta.id.split(':')[1]
    )}/${meta.entry || 'web/index.html'}`;
    frame.title = meta.name;
    view.appendChild(frame);
    return;
  }

  view.innerHTML = `<div class="page"><div class="empty">${icon(
    'fa-solid fa-cube'
  )}<p>This app is not available on this server.</p></div></div>`;
}

/* ------------------------------- activity -------------------------------- */

/* ------------------------------- palette --------------------------------- */

function paletteCommands() {
  const commands = [
    { name: 'Home', meta: 'Dashboard and widgets', icon: 'fa-solid fa-house', run: () => openTab('home') },
    { name: 'Search everything', meta: 'Files, people, events, tasks and mail', icon: 'fa-solid fa-magnifying-glass', run: () => openTab('search') },
    ...state.apps.map((app) => ({
      name: app.name,
      meta: app.description || 'App',
      icon: app.icon,
      run: () => openTab(app.id)
    })),
    { name: 'Me', meta: 'Profile, security and appearance', icon: 'fa-regular fa-circle-user', run: () => openTab('me') },
    {
      name: 'Switch theme',
      meta: 'Light and dark',
      icon: 'fa-regular fa-moon',
      run: () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        const button = document.querySelector('[data-theme-toggle]');
        if (button) button.innerHTML = icon(next === 'dark' ? 'fa-regular fa-sun' : 'fa-regular fa-moon');
      }
    }
  ];
  if (state.user?.role === 'admin') {
    commands.push(
      { name: 'Admin', meta: 'Users, server, backups and logs', icon: 'fa-solid fa-sliders', run: () => openTab('admin') },
      { name: 'App Store', meta: 'Install apps and widgets', icon: 'fa-solid fa-store', run: () => openTab('store') }
    );
  }
  return commands;
}

export function openPalette() {
  closePalette();
  paletteEl = document.createElement('div');
  paletteEl.className = 'palette-backdrop';
  paletteEl.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="palette-input">${icon('fa-solid fa-magnifying-glass')}<input id="palette-q" placeholder="Jump to an app, file or action…" autocomplete="off" aria-label="Command palette" /><span class="kbd">Esc</span></div>
    <div class="palette-list" id="palette-list"></div>
    <div class="palette-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> move</span><span><span class="kbd">Enter</span> open</span><span class="grow"></span><span>Files, people, events, tasks and mail</span></div>
  </div>`;
  document.body.appendChild(paletteEl);
  const input = paletteEl.querySelector('#palette-q');
  const list = paletteEl.querySelector('#palette-list');
  let results = [];
  let active = 0;
  let seq = 0;

  const close = () => closePalette();
  paletteEl.addEventListener('mousedown', (event) => {
    if (event.target === paletteEl) close();
  });

  const paint = (groups) => {
    results = groups.flatMap((group) => group.items);
    active = Math.min(active, Math.max(0, results.length - 1));
    list.innerHTML = groups.length
      ? groups
          .filter((group) => group.items.length)
          .map(
            (group) => `<section class="palette-group"><p>${esc(group.title)}</p>${group.items
              .map((item, itemIndex) => {
                const index = results.indexOf(item);
                return `<button class="palette-result ${index === active ? 'active' : ''}" data-palette="${index}">
                  <span class="file-ico">${icon(item.icon)}</span>
                  <span class="grow" style="min-width:0"><span class="palette-name truncate" style="display:block">${esc(item.name)}</span>
                  <span class="palette-meta truncate" style="display:block">${esc(item.meta || '')}</span></span>
                  ${item.hint ? `<span class="badge">${esc(item.hint)}</span>` : ''}
                </button>`;
              })
              .join('')}</section>`
          )
          .join('')
      : `<div class="empty compact">${icon('fa-regular fa-face-meh')}<p>Nothing matched.</p></div>`;
    list.querySelectorAll('[data-palette]').forEach((node) => {
      node.addEventListener('click', () => run(Number(node.dataset.palette)));
      node.addEventListener('mousemove', () => {
        active = Number(node.dataset.palette);
        list.querySelectorAll('.palette-result').forEach((other, index) => other.classList.toggle('active', index === active));
      });
    });
  };

  const run = (index) => {
    const item = results[index];
    if (!item) return;
    closePalette();
    item.run();
  };

  const local = (query) => {
    const needle = query.trim().toLowerCase();
    const commands = paletteCommands().filter((item) => !needle || `${item.name} ${item.meta}`.toLowerCase().includes(needle));
    return commands.map((item) => ({ ...item, hint: 'Action' }));
  };

  const search = debounce(async (query) => {
    const token = ++seq;
    if (query.trim().length < 2) return;
    let data;
    try {
      data = await api(`/api/search?q=${encodeURIComponent(query.trim())}`);
    } catch {
      return;
    }
    if (token !== seq || !paletteEl) return;
    const groups = [{ title: 'Results', items: resultsFromSearch(data) }];
    paint(groups);
  }, 220);

  const refresh = () => {
    const query = input.value;
    active = 0;
    paint([{ title: query.trim() ? 'Commands' : 'Go to', items: local(query) }]);
    search(query);
  };

  input.addEventListener('input', refresh);
  paletteEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      list.querySelectorAll('.palette-result').forEach((node, index) => {
        node.classList.toggle('active', index === active);
        if (index === active) node.scrollIntoView({ block: 'nearest' });
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    }
  });
  refresh();
  setTimeout(() => input.focus(), 30);
}

function resultsFromSearch(data) {
  const items = [];
  for (const file of (data.files || []).slice(0, 8)) {
    items.push({
      name: file.name,
      meta: file.path,
      icon: fileIcon(file.kind, file.name),
      hint: file.snippet ? 'content' : 'file',
      run: () => {
        if (file.kind === 'text') openTab(`cc:editor?file=${encodeURIComponent(file.path)}`);
        else openTab(`viewer?path=${encodeURIComponent(file.path)}`);
      }
    });
  }
  for (const tag of data.tags || []) {
    items.push({
      name: tag.name,
      meta: `Tagged ${tag.tags}`,
      icon: 'fa-solid fa-tag',
      hint: 'tag',
      run: () => openTab(`cc:files?path=${encodeURIComponent(tag.path.split('/').slice(0, -1).join('/'))}`)
    });
  }
  for (const person of (data.people || []).slice(0, 4)) {
    items.push({ name: person.name, meta: person.email || person.organization || 'Contact', icon: 'fa-regular fa-address-book', hint: 'person', run: () => openTab('cc:contacts') });
  }
  for (const event of (data.events || []).slice(0, 4)) {
    items.push({ name: event.title, meta: fmtDate(event.start, { time: true }), icon: 'fa-regular fa-calendar', hint: 'event', run: () => openTab('cc:calendar') });
  }
  for (const task of (data.tasks || []).slice(0, 4)) {
    items.push({ name: task.title, meta: task.due ? `Due ${fmtDate(task.due)}` : 'Task', icon: 'fa-solid fa-list-check', hint: 'task', run: () => openTab('cc:tasks') });
  }
  for (const mail of (data.mail || []).slice(0, 3)) {
    items.push({ name: mail.subject || '(no subject)', meta: `Mail to ${mail.to}`, icon: 'fa-regular fa-envelope', hint: 'mail', run: () => openTab('cc:mail') });
  }
  return items;
}

export function closePalette() {
  if (paletteEl) {
    paletteEl.remove();
    paletteEl = null;
  }
}

const NOTICE_ICONS = {
  invite: 'fa-solid fa-user-plus',
  call: 'fa-solid fa-phone',
  message: 'fa-regular fa-comment',
  notice: 'fa-regular fa-bell'
};

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refreshNotifications(), POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('cc:notifications-changed', () => refreshNotifications());
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
}

function onVisible() {
  if (document.visibilityState === 'visible') refreshNotifications();
}

export async function refreshNotifications({ silent = false } = {}) {
  if (!state.user) return;
  let data;
  try {
    data = await api('/api/notifications');
  } catch {
    return;
  }
  const previous = lastUnread;
  state.notifications = data;
  lastUnread = data.unread || 0;
  const badge = document.getElementById('bell-count');
  if (badge) {
    badge.textContent = String(data.unread || 0);
    badge.classList.toggle('hidden', !data.unread);
  }
  const bell = document.querySelector('[data-nav="activity"]');
  if (bell) bell.classList.toggle('has-unread', Boolean(data.unread));
  if (!silent && lastUnread > previous) chime();
  if (activityEl) renderActivityList();
}

function renderActivityList() {
  const list = activityEl?.querySelector('#activity-list');
  if (!list) return;
  const items = state.notifications.items || [];
  if (!items.length) {
    list.innerHTML = `<div class="empty">${icon(
      'fa-regular fa-bell-slash'
    )}<p>Nothing yet. Invites, calls and mentions land here.</p></div>`;
    return;
  }
  list.innerHTML = items
    .map(
      (item) => `<div class="activity-item ${item.read ? '' : 'unread'}" data-notice="${item.id}" role="button" tabindex="0">
        <span class="activity-glyph">${icon(NOTICE_ICONS[item.kind] || NOTICE_ICONS.notice)}</span>
        <span class="grow" style="min-width:0">
          <span class="activity-title" style="display:block">${esc(item.title)}</span>
          ${item.body ? `<span class="activity-body" style="display:block">${esc(item.body)}</span>` : ''}
          <span class="activity-when" style="display:block">${esc(timeAgo(item.createdAt))}${
            item.link ? ' · open' : ''
          }</span>
        </span>
        <button class="icon-btn sm" data-dismiss="${item.id}" title="Dismiss">${icon('fa-solid fa-xmark')}</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('[data-notice]').forEach((node) => {
    node.addEventListener('click', async (event) => {
      if (event.target.closest('[data-dismiss]')) return;
      const id = Number(node.dataset.notice);
      const item = items.find((entry) => entry.id === id);
      node.classList.remove('unread');
      closeActivity();
      try {
        await api('/api/notifications/read', { method: 'POST', body: { ids: [id] } });
      } catch {
        /* non-fatal */
      }
      refreshNotifications({ silent: true });
      if (item?.link) openTab(item.link);
    });
  });
  list.querySelectorAll('[data-dismiss]').forEach((node) => {
    node.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await api(`/api/notifications/${node.dataset.dismiss}`, { method: 'DELETE' });
      } catch {
        /* non-fatal */
      }
      refreshNotifications({ silent: true });
    });
  });
}

export function openActivity() {
  closeActivity();
  refreshNotifications({ silent: true });
  activityEl = document.createElement('div');
  activityEl.className = 'activity-scrim';
  activityEl.innerHTML = `<div class="activity-panel" role="dialog" aria-modal="true" aria-label="Activity">
    <div class="activity-head">
      <h2>Activity</h2>
      <span class="badge" id="activity-unread"></span>
      <span class="grow"></span>
      <button class="btn ghost sm" id="activity-read">Mark all read</button>
      <button class="icon-btn" id="activity-close" aria-label="Close">${icon('fa-solid fa-xmark')}</button>
    </div>
    <div class="activity-list" id="activity-list"></div>
    <div class="activity-foot">${icon('fa-regular fa-bell')} Invites and calls keep ringing until you read them.</div>
  </div>`;
  document.body.appendChild(activityEl);
  activityEl.addEventListener('mousedown', (event) => {
    if (event.target === activityEl) closeActivity();
  });
  activityEl.querySelector('#activity-close').addEventListener('click', closeActivity);
  activityEl.querySelector('#activity-read').addEventListener('click', async () => {
    try {
      await api('/api/notifications/read', { method: 'POST', body: { all: true } });
    } catch {
      /* non-fatal */
    }
    refreshNotifications({ silent: true });
    renderActivityList();
  });
  const unread = activityEl.querySelector('#activity-unread');
  if (unread) {
    unread.textContent = `${state.notifications.unread || 0} new`;
    unread.classList.toggle('accent', Boolean(state.notifications.unread));
  }
  renderActivityList();
}

export function closeActivity() {
  if (activityEl) {
    activityEl.remove();
    activityEl = null;
  }
}

/* ------------------------------- app drawer ------------------------------ */

function openWidgetLibrary(attempt = 0) {
  const button = document.getElementById('add-widget');
  if (button) return button.click();
  if (attempt < 12) setTimeout(() => openWidgetLibrary(attempt + 1), 70);
}

export function openDrawer() {
  closeDrawer();
  const builtins = [
    { id: 'home', name: 'Home', icon: 'fa-solid fa-house', accent: 'files', description: 'Your dashboard' },
    { id: 'search', name: 'Search', icon: 'fa-solid fa-magnifying-glass', accent: 'files', description: 'Everything, everywhere' },
    { id: 'me', name: 'Me', icon: 'fa-regular fa-circle-user', accent: 'contacts', description: 'Profile and preferences' }
  ];
  const apps = state.apps.map((app) => ({
    id: app.id,
    name: app.name,
    icon: app.icon,
    accent: (app.id.split(':')[1] || 'files').toLowerCase(),
    description: app.description || 'Installed app',
    pinnable: true
  }));
  const widgets = (state.widgets || []).map((app) => ({
    id: app.id,
    name: app.name,
    icon: app.icon,
    accent: (app.id.split(':')[1] || 'files').toLowerCase(),
    description: app.description || 'Home widget',
    widget: true
  }));
  const admin = state.user.role === 'admin'
    ? [
        { id: 'admin', name: 'Admin', icon: 'fa-solid fa-sliders', accent: 'mail', description: 'Users, server and apps' },
        { id: 'store', name: 'App Store', icon: 'fa-solid fa-store', accent: 'editor', description: 'Apps and widgets from registries' }
      ]
    : [];
  const everything = [...builtins, ...apps, ...widgets, ...admin];
  const byId = new Map(everything.map((item) => [item.id, item]));
  const pinnedItems = pinned.map((id) => byId.get(id)).filter(Boolean);
  const pinnedIds = new Set(pinnedItems.map((item) => item.id));
  const recentItems = recentApps()
    .map((id) => byId.get(id))
    .filter((item) => item && !item.widget && !pinnedIds.has(item.id))
    .slice(0, 5);
  const recentIds = new Set(recentItems.map((item) => item.id));

  const sections = [];
  if (pinnedItems.length) sections.push({ title: 'Pinned', items: pinnedItems });
  if (recentItems.length) sections.push({ title: 'Recent', items: recentItems });
  sections.push({
    title: 'Apps',
    items: apps.filter((item) => !pinnedIds.has(item.id) && !recentIds.has(item.id))
  });
  if (widgets.length) sections.push({ title: 'Widgets', items: widgets, note: 'Live on your home' });
  sections.push({
    title: 'Go to',
    items: builtins.filter((item) => !pinnedIds.has(item.id) && !recentIds.has(item.id))
  });
  if (admin.length) sections.push({ title: 'Administration', items: admin });

  drawerEl = document.createElement('div');
  drawerEl.className = 'drawer-backdrop';
  drawerEl.innerHTML = `<div class="drawer-panel" role="dialog" aria-modal="true" aria-label="App drawer">
    <div class="drawer-head">
      <div class="input-group drawer-search">
        ${icon('fa-solid fa-magnifying-glass')}
        <input id="drawer-q" placeholder="Search apps, widgets and actions" aria-label="Search apps" autocomplete="off" />
      </div>
      <span class="drawer-count" id="drawer-count"></span>
      <button class="icon-btn" id="drawer-close" aria-label="Close">${icon('fa-solid fa-xmark')}</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
    <div class="drawer-foot">
      <span>${icon('fa-solid fa-arrow-down-up-across-line')} Arrow keys move, Enter opens</span>
      <span class="grow"></span>
      <span><span class="kbd">A</span> opens this menu</span>
    </div>
  </div>`;

  document.body.appendChild(drawerEl);
  drawerEl.addEventListener('mousedown', (event) => {
    if (event.target === drawerEl) closeDrawer();
  });
  drawerEl.querySelector('#drawer-close').addEventListener('click', closeDrawer);

  const body = drawerEl.querySelector('#drawer-body');
  const countEl = drawerEl.querySelector('#drawer-count');
  let tiles = [];

  const renderGrid = (filter = '') => {
    const needle = filter.trim().toLowerCase();
    const matches = (item) => !needle || `${item.name} ${item.description}`.toLowerCase().includes(needle);
    let total = 0;
    const blocks = sections
      .map((section) => {
        const items = section.items.filter(matches);
        if (!items.length) return '';
        total += items.length;
        return `<section class="drawer-section">
          <div class="drawer-section-head">
            <span>${esc(section.title)}</span>
            <span class="drawer-section-meta">${section.note ? esc(section.note) : `${items.length}`}</span>
          </div>
          <div class="app-grid">
            ${items
              .map(
                (item) => `<div class="app-tile-wrap">
                  <button class="app-tile" data-app="${esc(item.id)}" ${
                  item.widget ? 'data-widget-tile="1"' : ''
                }>
                    <span class="app-icon lg" style="--app:var(--app-${esc(item.accent)})">${icon(item.icon)}</span>
                    <span class="app-tile-name">${esc(item.name)}${
                  item.widget ? ' <span class="badge">widget</span>' : ''
                }</span>
                    <span class="app-tile-desc">${esc(item.description)}</span>
                  </button>
                  ${
                    item.pinnable
                      ? `<button class="app-pin" data-pin="${esc(item.id)}" aria-pressed="${
                          pinned.includes(item.id)
                        }" title="Pin to sidebar" aria-label="Pin ${esc(item.name)}">${icon(
                          'fa-solid fa-thumbtack'
                        )}</button>`
                      : ''
                  }
                </div>`
              )
              .join('')}
          </div>
        </section>`;
      })
      .filter(Boolean);
    countEl.textContent = total ? `${total} item${total === 1 ? '' : 's'}` : '';
    body.innerHTML = blocks.length
      ? blocks.join('')
      : `<div class="drawer-empty">${icon('fa-solid fa-magnifying-glass')}<p>Nothing matches “${esc(
          filter.trim()
        )}”.</p></div>`;
    tiles = [...body.querySelectorAll('[data-app]')];
    tiles.forEach((node) => {
      node.addEventListener('click', () => {
        if (node.dataset.widgetTile) {
          openTab('home');
          closeDrawer();
          openWidgetLibrary();
          return;
        }
        openTab(node.dataset.app);
        closeDrawer();
      });
    });
    body.querySelectorAll('[data-pin]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        togglePin(node.dataset.pin);
      });
    });
  };

  renderGrid();
  const input = drawerEl.querySelector('#drawer-q');
  input.addEventListener('input', () => renderGrid(input.value));
  drawerEl.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const index = tiles.indexOf(document.activeElement);
    if (index === -1) {
      if (event.target === input) {
        event.preventDefault();
        tiles[0]?.focus();
      }
      return;
    }
    event.preventDefault();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const columns = getComputedStyle(body.querySelector('.app-grid') || body).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
      const step = event.key === 'ArrowDown' ? columns : -columns;
      tiles[Math.min(tiles.length - 1, Math.max(0, index + step))]?.focus();
    } else {
      const step = event.key === 'ArrowRight' ? 1 : -1;
      tiles[Math.min(tiles.length - 1, Math.max(0, index + step))]?.focus();
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim()) {
      event.preventDefault();
      tiles[0]?.click();
    }
  });
  setTimeout(() => input.focus(), 30);
}

export function closeDrawer() {
  if (drawerEl) {
    drawerEl.remove();
    drawerEl = null;
  }
}

export function refreshSession() {
  return api('/api/auth/session').then((session) => {
    state.user = session.user;
    applySessionApps(session);
    state.server = session.server || {};
    applyBranding(state.server.branding, state.server.name);
    return session;
  });
}
