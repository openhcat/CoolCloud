export const state = {
  user: null,
  apps: [],
  widgets: [],
  allApps: [],
  server: null,
  branding: null,
  notifications: { unread: 0, items: [] },
  theme: 'light',
  tabs: [],
  active: null
};

/* ---------------------------------- DOM ---------------------------------- */

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function html(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

export function icon(cls, style = '') {
  return `<i class="${cls}"${style ? ` style="${style}"` : ''} aria-hidden="true"></i>`;
}

export function debounce(fn, ms = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------------------------- API ---------------------------------- */

export async function api(path, { method = 'GET', body, headers = {}, signal, raw = false } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error('Cannot reach the server');
  }
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('cc:unauthorized'));
    throw new Error('Your session ended. Sign in again.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data.error) message = data.error;
    } catch {
      /* not JSON */
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (raw) return response;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json();
  return response;
}

/* ---------------------------------- toast -------------------------------- */

export function toast(message, kind = 'ok') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = html(
    `<div class="toast ${kind === 'error' ? 'error' : ''}">${icon(
      kind === 'error' ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-check'
    )}<span>${esc(message)}</span></div>`
  );
  root.appendChild(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3200);
}

/* --------------------------------- modal --------------------------------- */

let escHandler = null;
let modalCloseHandler = null;

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
  const onClose = modalCloseHandler;
  modalCloseHandler = null;
  if (onClose) {
    try {
      onClose();
    } catch {
      /* the caller's cleanup must not break modal teardown */
    }
  }
}

export function openModal({ title, sub = '', body = '', wide = false, actions = [], onMount, onClose } = {}) {
  closeModal();
  modalCloseHandler = onClose || null;
  const root = document.getElementById('modal-root');
  const buttons = (actions.length ? actions : [{ label: 'Close', kind: 'ghost' }])
    .map(
      (action, index) =>
        `<button class="btn ${action.kind || 'ghost'}" data-action="${index}">${action.icon ? icon(action.icon) : ''}${esc(
          action.label
        )}</button>`
    )
    .join('');
  root.innerHTML = `<div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        ${sub ? `<p class="modal-sub">${esc(sub)}</p>` : ''}
        <div class="modal-content">${body}</div>
        <div class="modal-actions">${buttons}</div>
      </div>
    </div>`;

  const backdrop = root.firstElementChild;
  const dialog = backdrop.querySelector('.modal');
  const close = () => closeModal();

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  escHandler = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', escHandler);

  const actionNodes = [...dialog.querySelectorAll('[data-action]')];
  actionNodes.forEach((node, index) => {
    node.addEventListener('click', async () => {
      const action = (actions.length ? actions : [{ label: 'Close' }])[index];
      if (!action) return close();
      if (action.onClick) {
        node.disabled = true;
        try {
          const result = await action.onClick({ dialog, close });
          // A handler returns false to keep the modal open (for example after a
          // validation error), so give the button back instead of leaving it dead.
          if (result === false) node.disabled = false;
          else close();
        } catch (err) {
          toast(err.message, 'error');
          node.disabled = false;
        }
        return;
      }
      close();
    });
  });

  const form = dialog.querySelector('form');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const primary = actionNodes.find((node) => node.classList.contains('primary'));
      if (primary) primary.click();
    });
  }

  const focusable = dialog.querySelector('input, textarea, select, button.primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);

  if (onMount) onMount(dialog, close);
  return { dialog, close };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="muted small" style="line-height:1.6">${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => resolve(false) },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: () => {
            resolve(true);
          }
        }
      ],
      onMount: (dialog, close) => {
        const observer = new MutationObserver(() => {
          if (!document.body.contains(dialog)) {
            observer.disconnect();
            resolve(false);
          }
        });
        observer.observe(document.getElementById('modal-root'), { childList: true });
        dialog.addEventListener('click', (event) => {
          if (event.target.closest('[data-action]')) return;
        });
        close;
      }
    });
  });
}

/* ------------------------------- formatting ------------------------------ */

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function fmtDate(value, { time = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    ...(time ? { hour: '2-digit', minute: '2-digit' } : {})
  });
}

export function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return fmtDate(value);
}

export function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

export function hueFor(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return `hsl(${hash} 32% 42%)`;
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/* ---------------------------------- files -------------------------------- */

export function fileIcon(kind, name = '') {
  if (kind === 'folder') return 'fa-solid fa-folder';
  if (kind === 'image') return 'fa-regular fa-image';
  if (kind === 'video') return 'fa-solid fa-play';
  if (kind === 'audio') return 'fa-solid fa-waveform';
  if (kind === 'pdf') return 'fa-regular fa-file-pdf';
  if (kind === 'archive') return 'fa-solid fa-file-zipper';
  if (kind === 'office') return 'fa-regular fa-file-word';
  if (kind === 'text') {
    if (/\.(md|markdown)$/i.test(name)) return 'fa-regular fa-file-lines';
    if (/\.(js|mjs|ts|py|sh|css|html|json|yml|yaml)$/i.test(name)) return 'fa-solid fa-code';
    return 'fa-regular fa-file-lines';
  }
  return 'fa-regular fa-file';
}

export const APP_ACCENTS = {
  files: 'files',
  calendar: 'calendar',
  mail: 'mail',
  contacts: 'contacts',
  editor: 'editor',
  tasks: 'tasks',
  connect: 'connect',
  media: 'media',
  assistant: 'assistant',
  crm: 'crm',
  finance: 'finance',
  projects: 'projects',
  studio: 'studio',
  notes: 'notes'
};

export function accentFor(id = '') {
  const short = String(id).split(':').pop();
  return APP_ACCENTS[short] || 'files';
}

export function appMeta(id) {
  return state.apps.find((app) => app.id === id || app.id === `cc:${id}`) || null;
}

export function appIcon(id) {
  const meta = appMeta(id);
  if (meta) return meta.icon;
  const map = {
    home: 'fa-solid fa-house',
    search: 'fa-solid fa-magnifying-glass',
    me: 'fa-regular fa-circle-user',
    admin: 'fa-solid fa-sliders',
    store: 'fa-solid fa-store',
    viewer: 'fa-regular fa-eye'
  };
  return map[id] || 'fa-solid fa-cube';
}

/* ------------------------------- misc utils ------------------------------ */

export function paramString(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

export function parseRoute(route) {
  const [pathPart, queryPart] = String(route || '').split('?');
  return { app: pathPart, params: new URLSearchParams(queryPart || '') };
}

export function applyTheme(theme) {
  const resolved = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
  state.theme = theme;
  try {
    localStorage.setItem('cc:theme', theme);
  } catch {
    /* ignore */
  }
}

export function readTheme() {
  try {
    return localStorage.getItem('cc:theme') || 'light';
  } catch {
    return 'light';
  }
}

/* --------------------------------- brand --------------------------------- */

export const DEFAULT_BRANDING = {
  logoWord: 'Cloud',
  accent: '#0b5fb0',
  logo: ''
};

/** The wordmark: C infinity L and the product word on one dark blue plate. */
export function brandLockup({ word = 'Cloud', logo = '', title = '' } = {}) {
  const name = title || `CoolCloud ${word || ''}`.trim();
  if (logo) return `<img class="brand-img" src="${esc(logo)}" alt="${esc(name)}" />`;
  return `<span class="brand-lockup" role="img" aria-label="${esc(name)}">
    <span class="bl-mark">C<span class="bl-inf">&#8734;</span>L</span>
    <span class="bl-word">${esc(word || 'Cloud')}</span>
  </span>`;
}

/** Pull a colour towards black, for the plate and the favicon. */
export function shade(hex, keep = 0.6) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return '#0b3a5c';
  const mix = (pair) => Math.round(parseInt(pair, 16) * keep + 6 * (1 - keep));
  return `#${[value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)]
    .map((pair) => mix(pair).toString(16).padStart(2, '0'))
    .join('')}`;
}

function inkFor(hex) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return '#ffffff';
  const channels = [0, 2, 4].map((index) => {
    const c = parseInt(value.slice(index, index + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.42 ? '#17120d' : '#ffffff';
}

function faviconFor(accent) {
  const plate = shade(accent, 0.62);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="${plate}"/><path d="M24 24c-3.6-6.4-12.2-5.8-12.2 0s8.6 6.4 12.2 0c3.6-6.4 12.2-5.8 12.2 0s-8.6 6.4-12.2 0" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Push instance branding into the document: title, accent, favicon, state. */
export function applyBranding(branding, name = 'CoolCloud') {
  const resolved = { ...DEFAULT_BRANDING, ...(branding && typeof branding === 'object' ? branding : {}) };
  if (!/^#[0-9a-f]{6}$/i.test(resolved.accent)) resolved.accent = DEFAULT_BRANDING.accent;
  state.branding = resolved;

  const root = document.documentElement.style;
  root.setProperty('--accent', resolved.accent);
  root.setProperty('--accent-ink', inkFor(resolved.accent));
  root.setProperty('--brand', shade(resolved.accent, 0.6));
  document.title = name || 'CoolCloud';

  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = resolved.logo || faviconFor(resolved.accent);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved.accent);
  return resolved;
}

/* ------------------------------- attention ------------------------------- */

let audioContext = null;

/** Browsers need one gesture before audio may play. */
export function unlockAudio() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
  } catch {
    audioContext = null;
  }
}

/** Two-tone chime for a new Activity entry. */
export function chime() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const start = audioContext.currentTime + 0.01;
    [
      [784, 0],
      [1174, 0.1]
    ].forEach(([frequency, offset]) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.055, start + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.26);
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.3);
    });
  } catch {
    /* sound is optional */
  }
}
