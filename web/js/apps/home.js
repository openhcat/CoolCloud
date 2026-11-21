import { api, debounce, esc, fileIcon, fmtBytes, fmtDate, fmtTime, icon, openModal, state, timeAgo, toast } from '../core.js';
import { openTab } from '../shell.js';

const GREETINGS = [
  (name) => `Back at it, ${name}.`,
  (name) => `Welcome back, ${name}.`,
  (name) => `Ready for some action, ${name}?`,
  (name) => `What shall we do today, ${name}?`,
  (name) => `Good to see you, ${name}.`
];

const WEATHER = {
  0: ['fa-sun', 'Clear'],
  1: ['fa-sun', 'Mostly clear'],
  2: ['fa-cloud-sun', 'Partly cloudy'],
  3: ['fa-cloud', 'Cloudy'],
  45: ['fa-smog', 'Fog'],
  48: ['fa-smog', 'Rime fog'],
  51: ['fa-cloud-rain', 'Light drizzle'],
  53: ['fa-cloud-rain', 'Drizzle'],
  55: ['fa-cloud-rain', 'Heavy drizzle'],
  61: ['fa-cloud-rain', 'Light rain'],
  63: ['fa-cloud-rain', 'Rain'],
  65: ['fa-cloud-showers-heavy', 'Heavy rain'],
  71: ['fa-snowflake', 'Light snow'],
  73: ['fa-snowflake', 'Snow'],
  75: ['fa-snowflake', 'Heavy snow'],
  80: ['fa-cloud-sun-rain', 'Showers'],
  81: ['fa-cloud-sun-rain', 'Showers'],
  82: ['fa-cloud-showers-heavy', 'Violent showers'],
  95: ['fa-cloud-bolt', 'Thunderstorm'],
  96: ['fa-cloud-bolt', 'Thunder and hail']
};

const WIDTHS = [3, 4, 5, 6, 7, 8, 9, 12];

/* ------------------------------- widgets --------------------------------- */

function openFile(path, kind) {
  if (kind === 'folder') return openTab(`cc:files?path=${encodeURIComponent(path)}`);
  if (kind === 'text') return openTab(`cc:editor?file=${encodeURIComponent(path)}`);
  return openTab(`viewer?path=${encodeURIComponent(path)}`);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeValue(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Real creation flows behind the Quick actions widget. */
function quickAction(kind, refresh) {
  if (kind === 'document') {
    openModal({
      title: 'New document',
      sub: 'Saved at the root of Files and opened in the editor.',
      body: `<div class="field"><label class="label">File name</label><input class="input" id="quick-name" value="untitled.md" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const name = dialog.querySelector('#quick-name').value.trim();
            if (!name) return false;
            try {
              await api('/api/files/text', { method: 'PUT', body: { path: name, content: '', create: true } });
              refresh();
              openTab(`cc:editor?file=${encodeURIComponent(name)}`);
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
    return;
  }

  if (kind === 'folder') {
    openModal({
      title: 'New folder',
      body: `<div class="field"><label class="label">Folder name</label><input class="input" id="quick-name" placeholder="Projects" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const name = dialog.querySelector('#quick-name').value.trim();
            if (!name) return false;
            try {
              await api('/api/files/folder', { method: 'POST', body: { path: name } });
              refresh();
              toast('Folder created');
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
    return;
  }

  if (kind === 'task') {
    openModal({
      title: 'New task',
      body: `<div class="field"><label class="label">Task</label><input class="input" id="quick-name" placeholder="Reply to the team" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Add task',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const title = dialog.querySelector('#quick-name').value.trim();
            if (!title) return false;
            try {
              await api('/api/tasks', { method: 'POST', body: { title } });
              refresh();
              toast('Task added');
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
    return;
  }

  if (kind === 'event') {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    openModal({
      title: 'New event',
      body: `<div class="field"><label class="label">Event</label><input class="input" id="quick-name" placeholder="Team sync" /></div>
        <div class="row" style="gap:10px;margin-top:10px">
          <div class="field grow"><label class="label">Date</label><input class="input" type="date" id="quick-date" value="${dateValue(
            start
          )}" /></div>
          <div class="field grow"><label class="label">Start</label><input class="input" type="time" id="quick-time" value="${timeValue(
            start
          )}" /></div>
        </div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Add event',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const title = dialog.querySelector('#quick-name').value.trim();
            const date = dialog.querySelector('#quick-date').value;
            const time = dialog.querySelector('#quick-time').value || '09:00';
            if (!title) return false;
            const begin = new Date(`${date || dateValue(new Date())}T${time}`);
            if (Number.isNaN(begin.getTime())) {
              toast('Pick a valid date and time', 'error');
              return false;
            }
            try {
              await api('/api/calendar', {
                method: 'POST',
                body: {
                  title,
                  start: begin.toISOString(),
                  end: new Date(begin.getTime() + 60 * 60 * 1000).toISOString()
                }
              });
              refresh();
              toast('Event added');
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
          }
        }
      ]
    });
  }
}

const BUILTINS = [
  {
    id: 'today',
    name: 'Today',
    icon: 'fa-regular fa-calendar',
    description: 'Your agenda for today',
    span: 5,
    link: 'cc:calendar',
    linkLabel: 'Calendar',
    render(el, ctx, data) {
      if (!data.today.length) {
        el.innerHTML = `<div class="empty compact">${icon(
          'fa-regular fa-calendar'
        )}<p>Nothing scheduled today.</p><button class="btn sm" data-open="cc:calendar">Plan something</button></div>`;
        return;
      }
      el.innerHTML = data.today
        .map(
          (event) => `<div class="agenda-item">
            <div class="agenda-time">${event.allDay ? 'All day' : fmtTime(event.start)}</div>
            <div><div class="agenda-title">${esc(event.title)}</div>
            ${event.location ? `<div class="agenda-meta">${esc(event.location)}</div>` : ''}</div>
          </div>`
        )
        .join('');
      el.querySelectorAll('[data-open]').forEach((node) => node.addEventListener('click', () => openTab(node.dataset.open)));
    }
  },
  {
    id: 'tasks',
    name: 'Tasks',
    icon: 'fa-solid fa-list-check',
    description: 'What is still open',
    span: 4,
    link: 'cc:tasks',
    linkLabel: 'All tasks',
    render(el, ctx, data) {
      if (!data.tasks.length) {
        el.innerHTML = `<div class="empty compact">${icon('fa-regular fa-circle-check')}<p>Inbox zero. Nice.</p></div>`;
        return;
      }
      el.innerHTML = data.tasks
        .map(
          (task) => `<div class="task-line" data-task="${task.id}">
            <button class="task-check" aria-label="Complete ${esc(task.title)}">${icon('fa-solid fa-check')}</button>
            <div class="grow" style="min-width:0"><div class="task-name truncate">${esc(task.title)}</div>
            <div class="tiny dim">${task.due ? `Due ${esc(fmtDate(task.due))}` : esc(task.list)}</div></div>
          </div>`
        )
        .join('');
      el.querySelectorAll('[data-task]').forEach((node) => {
        node.querySelector('.task-check').addEventListener('click', async () => {
          node.classList.add('done');
          try {
            await api(`/api/tasks/${node.dataset.task}`, { method: 'PATCH', body: { done: true } });
            node.remove();
          } catch (err) {
            node.classList.remove('done');
            toast(err.message, 'error');
          }
        });
      });
    }
  },
  {
    id: 'stats',
    name: 'Workspace',
    icon: 'fa-solid fa-chart-simple',
    description: 'Activity at a glance',
    span: 3,
    render(el, ctx, data) {
      el.innerHTML = `<div class="stat-row" style="grid-template-columns:1fr 1fr">
        <div class="mini-stat"><span class="mini-stat-value">${data.counts.files}</span><span class="mini-stat-label">Files</span></div>
        <div class="mini-stat"><span class="mini-stat-value">${data.counts.tasksOpen}</span><span class="mini-stat-label">Open tasks</span></div>
        <div class="mini-stat"><span class="mini-stat-value">${data.counts.contacts}</span><span class="mini-stat-label">Contacts</span></div>
        <div class="mini-stat"><span class="mini-stat-value">${data.counts.users}</span><span class="mini-stat-label">People</span></div>
      </div>`;
    }
  },
  {
    id: 'briefing',
    name: 'Daily briefing',
    icon: 'fa-regular fa-sun',
    description: 'Today at a glance',
    span: 6,
    render(el, ctx, data) {
      const unread = state.notifications?.unread || 0;
      const next = data.today[0];
      el.innerHTML = `<div class="briefing">
        <div class="briefing-line"><span class="briefing-k">${icon('fa-regular fa-calendar')} Today</span><span class="briefing-v">${data.today.length ? `${data.today.length} event${data.today.length === 1 ? '' : 's'}` : 'Nothing scheduled'}</span></div>
        ${next ? `<div class="briefing-next">Next: <strong>${esc(next.title)}</strong> · ${next.allDay ? 'All day' : fmtTime(next.start)}${next.location ? ` · ${esc(next.location)}` : ''}</div>` : ''}
        <div class="briefing-line"><span class="briefing-k">${icon('fa-solid fa-list-check')} Tasks</span><span class="briefing-v">${data.counts.tasksOpen ? `${data.counts.tasksOpen} open` : 'Inbox zero'}</span></div>
        <div class="briefing-line"><span class="briefing-k">${icon('fa-regular fa-bell')} Activity</span><span class="briefing-v">${unread ? `${unread} unread` : 'All caught up'}</span></div>
      </div>`;
    }
  },
  {
    id: 'recent',
    name: 'Recent files',
    icon: 'fa-solid fa-folder-open',
    description: 'The files you touched last',
    span: 7,
    link: 'cc:files',
    linkLabel: 'All files',
    render(el, ctx, data) {
      if (!data.recentFiles.length) {
        el.innerHTML = `<div class="empty compact">${icon(
          'fa-regular fa-folder'
        )}<p>No files yet. Upload your first one.</p><button class="btn sm" data-open="cc:files">Open Files</button></div>`;
        el.querySelectorAll('[data-open]').forEach((node) => node.addEventListener('click', () => openTab(node.dataset.open)));
        return;
      }
      el.innerHTML = data.recentFiles
        .map(
          (file) => `<button class="file-line" data-path="${esc(file.path)}" data-kind="${file.kind}">
            <span class="file-ico">${icon(fileIcon(file.kind, file.name))}</span>
            <span class="file-line-name">${esc(file.name)}</span>
            <span class="file-line-meta">${fmtBytes(file.size)} · ${timeAgo(file.mtime)}</span>
          </button>`
        )
        .join('');
      el.querySelectorAll('[data-path]').forEach((node) => {
        node.addEventListener('click', () => openFile(node.dataset.path, node.dataset.kind));
      });
    }
  },
  {
    id: 'media',
    name: 'Media',
    icon: 'fa-regular fa-images',
    description: 'Photos and videos',
    span: 5,
    link: 'cc:media',
    linkLabel: 'Library',
    render(el, ctx, data) {
      if (!data.media.length) {
        el.innerHTML = `<div class="media-empty">Photos and videos you upload to Files show up here.<br /><button class="btn sm" style="margin-top:10px" data-open="cc:files">Upload media</button></div>`;
        el.querySelectorAll('[data-open]').forEach((node) => node.addEventListener('click', () => openTab(node.dataset.open)));
        return;
      }
      el.innerHTML = `<div class="media-strip">${data.media
        .slice(0, 8)
        .map(
          (item) => `<button class="media-thumb" data-path="${esc(item.path)}" title="${esc(item.name)}">
            <img loading="lazy" src="/api/files/raw?path=${encodeURIComponent(item.path)}" alt="${esc(item.name)}" />
            ${item.kind === 'video' ? `<span class="kind">${icon('fa-solid fa-play')}</span>` : ''}
          </button>`
        )
        .join('')}</div><p class="tiny dim" style="margin-top:10px">${data.counts.media} photos and videos in your library</p>`;
      el.querySelectorAll('[data-path]').forEach((node) => {
        node.addEventListener('click', () => openTab(`viewer?path=${encodeURIComponent(node.dataset.path)}`));
      });
    }
  },
  {
    id: 'clock',
    name: 'Clock',
    icon: 'fa-regular fa-clock',
    description: 'The time, front and centre',
    span: 3,
    render(el) {
      const now = new Date();
      el.innerHTML = `<div class="wz-clock">
        <span class="wz-clock-time" data-clock-time>${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="wz-clock-date">${esc(now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</span>
      </div>`;
    }
  },
  {
    id: 'weather',
    name: 'Weather',
    icon: 'fa-solid fa-cloud-sun',
    description: 'Conditions where you are',
    span: 4,
    link: 'me',
    linkLabel: 'Set location',
    render(el, ctx) {
      const location = state.user?.prefs?.weather || ctx.user.prefs?.weather;
      el.innerHTML = `<div class="wz-weather"><div class="skeleton" style="height:56px"></div></div>`;
      if (!location?.lat || !location?.lon) {
        el.innerHTML = `<div class="empty compact">${icon(
          'fa-solid fa-location-dot'
        )}<p>Add a location to see local weather.</p><button class="btn sm" data-open="me">Set location</button></div>`;
        el.querySelectorAll('[data-open]').forEach((node) => node.addEventListener('click', () => openTab(node.dataset.open)));
        return;
      }
      api(`/api/weather?lat=${location.lat}&lon=${location.lon}`)
        .then((weather) => {
          if (!el.isConnected) return;
          if (weather.unavailable) {
            el.innerHTML = `<div class="empty compact">${icon('fa-solid fa-cloud-rain')}<p>Weather is unavailable right now.</p></div>`;
            return;
          }
          const info = WEATHER[weather.code] || ['fa-cloud', 'Weather'];
          el.innerHTML = `<div class="wz-weather">
            <span class="wz-weather-glyph">${icon('fa-solid ' + info[0])}</span>
            <span class="wz-weather-temp">${Math.round(weather.temperature)}<small>${esc(weather.units || '°C')}</small></span>
            <span class="wz-weather-meta">${esc(info[1])} · ${esc(location.label || 'Local')}${
            weather.high != null ? ` · ${Math.round(weather.low)}°/${Math.round(weather.high)}°` : ''
          }</span>
          </div>`;
        })
        .catch(() => {
          if (el.isConnected) el.innerHTML = `<div class="empty compact">${icon('fa-solid fa-cloud-rain')}<p>Weather is unavailable right now.</p></div>`;
        });
    }
  },
  {
    id: 'notes',
    name: 'Quick notes',
    icon: 'fa-solid fa-pen',
    description: 'A scratchpad saved to your account',
    span: 4,
    render(el, ctx) {
      el.innerHTML = `<textarea class="wz-notes" placeholder="Jot something down…" aria-label="Quick notes">${esc(
        state.user?.prefs?.homeNotes || ctx.user.prefs?.homeNotes || ''
      )}</textarea><p class="wz-save tiny dim" data-save>Saved with your account</p>`;
      const field = el.querySelector('.wz-notes');
      const label = el.querySelector('[data-save]');
      const save = debounce(async () => {
        try {
          const { user } = await api('/api/me', { method: 'PATCH', body: { prefs: { homeNotes: field.value } } });
          state.user = user;
          label.textContent = 'Saved';
        } catch (err) {
          label.textContent = 'Could not save';
          toast(err.message, 'error');
        }
      }, 500);
      field.addEventListener('input', () => {
        label.textContent = 'Saving…';
        save();
      });
    }
  },
  {
    id: 'quick',
    name: 'Quick actions',
    icon: 'fa-solid fa-bolt',
    description: 'Start something in one click',
    span: 3,
    render(el, ctx, data, helpers) {
      const actions = [
        ['document', 'fa-regular fa-file-lines', 'New document'],
        ['folder', 'fa-regular fa-folder', 'New folder'],
        ['task', 'fa-solid fa-list-check', 'New task'],
        ['event', 'fa-regular fa-calendar-plus', 'New event']
      ];
      el.innerHTML = `<div class="wz-quick">${actions
        .map(
          ([kind, glyph, label]) =>
            `<button class="wz-quick-btn" data-quick="${kind}">${icon(glyph)}<span>${esc(label)}</span></button>`
        )
        .join('')}</div>`;
      el.querySelectorAll('[data-quick]').forEach((node) =>
        node.addEventListener('click', () => quickAction(node.dataset.quick, helpers.refresh))
      );
    }
  },
  {
    id: 'activity',
    name: 'Activity',
    icon: 'fa-regular fa-bell',
    description: 'Your latest notifications',
    span: 4,
    link: 'activity',
    linkLabel: 'Open',
    render(el) {
      el.innerHTML = `<div class="skeleton" style="height:64px"></div>`;
      api('/api/notifications')
        .then((data) => {
          if (!el.isConnected) return;
          const items = (data.items || []).slice(0, 4);
          if (!items.length) {
            el.innerHTML = `<div class="empty compact">${icon('fa-regular fa-bell-slash')}<p>Nothing yet.</p></div>`;
            return;
          }
          el.innerHTML = items
            .map(
              (item) => `<div class="wz-activity ${item.read ? '' : 'unread'}">
                <span class="wz-activity-dot"></span>
                <span class="grow" style="min-width:0">
                  <span class="wz-activity-title">${esc(item.title)}</span>
                  <span class="wz-activity-when">${esc(timeAgo(item.createdAt))}</span>
                </span>
              </div>`
            )
            .join('');
        })
        .catch(() => {
          if (el.isConnected) el.innerHTML = `<div class="empty compact"><p>Activity is unavailable.</p></div>`;
        });
    }
  }
];

const BUILTIN_MAP = new Map(BUILTINS.map((widget) => [widget.id, widget]));

const DEFAULT_LAYOUT = [
  { id: 'today', kind: 'builtin', span: 5 },
  { id: 'tasks', kind: 'builtin', span: 4 },
  { id: 'stats', kind: 'builtin', span: 3 },
  { id: 'recent', kind: 'builtin', span: 7 },
  { id: 'media', kind: 'builtin', span: 5 }
];

/* ------------------------------- helpers --------------------------------- */

function pickGreeting(name) {
  let last = -1;
  try {
    last = Number(sessionStorage.getItem('cc:greeting') ?? -1);
  } catch {
    last = -1;
  }
  let index = Math.floor(Math.random() * GREETINGS.length);
  if (index === last) index = (index + 1) % GREETINGS.length;
  try {
    sessionStorage.setItem('cc:greeting', String(index));
  } catch {
    /* ignore */
  }
  return GREETINGS[index](name);
}

function widgetMeta(entry) {
  if (!entry) return null;
  if (entry.kind === 'builtin') return BUILTIN_MAP.get(entry.id) || null;
  const app = (state.widgets || []).find((item) => item.id === entry.id);
  if (!app) return null;
  return {
    id: app.id,
    name: app.name,
    icon: app.icon || 'fa-solid fa-cube',
    description: app.description || 'Installed widget',
    link: '',
    linkLabel: '',
    external: app
  };
}

function normalizeSpan(value, fallback = 6) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(12, Math.max(3, number));
}

function clampLayout(raw) {
  const installed = new Set((state.widgets || []).map((app) => app.id));
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item.id !== 'string') continue;
    const kind = item.kind === 'widget' ? 'widget' : 'builtin';
    if (kind === 'builtin' && !BUILTIN_MAP.has(item.id)) continue;
    if (kind === 'widget' && !installed.has(item.id)) continue;
    out.push({
      id: item.id,
      kind,
      uid: typeof item.uid === 'string' && item.uid ? item.uid : `${item.id}-${out.length}-${Math.random().toString(36).slice(2, 7)}`,
      span: normalizeSpan(item.span, kind === 'builtin' ? BUILTIN_MAP.get(item.id).span : 6)
    });
  }
  return out;
}

/* --------------------------------- mount --------------------------------- */

export default function mount(root, ctx) {
  const user = ctx.user;
  const assistantEnabled = state.apps.some((app) => app.id === 'cc:assistant');
  const now = new Date();
  const greeting = pickGreeting(user.name || user.username);
  const dateLine = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  // Prefer the live session user: saveLayout and the notes widget update it
  // without re-running the shell, so ctx.user can lag behind.
  const prefs = state.user?.prefs || user.prefs || {};
  const profiles = prefs.homeProfiles && typeof prefs.homeProfiles === 'object' ? prefs.homeProfiles : {};
  const activeProfile = prefs.homeProfile && (prefs.homeProfile === 'Default' || profiles[prefs.homeProfile]) ? prefs.homeProfile : 'Default';
  const saved = activeProfile === 'Default' ? prefs.homeWidgets : profiles[activeProfile];
  let layout = Array.isArray(saved) ? clampLayout(saved) : clampLayout(DEFAULT_LAYOUT);
  let repaintPanel = () => {};
  let data = null;
  let failed = false;

  root.innerHTML = `<div class="page home">
    <header class="dash-head">
      <p class="dash-date">${esc(dateLine)}</p>
      <h1 class="dash-greeting">${esc(greeting)}</h1>
      <div class="home-status">
        <span class="home-chip">${icon('fa-regular fa-clock')}<span id="clock">${now.toLocaleTimeString(
          undefined,
          { hour: '2-digit', minute: '2-digit' }
        )}</span></span>
        <span class="home-chip" id="weather-line">${icon('fa-solid fa-cloud-sun')}<span class="home-chip-text">Weather</span></span>
        <span class="home-chip" id="dash-summary">${icon(
          'fa-solid fa-chart-simple'
        )}<span class="home-chip-text">Loading your workspace…</span></span>
      </div>
      <div class="home-actions">
        <select class="select home-profile-select" id="home-profile" aria-label="Home profile">
          ${['Default', ...Object.keys(profiles)].map((name) => `<option ${name === activeProfile ? 'selected' : ''}>${esc(name)}</option>`).join('')}
        </select>
        <button class="btn quiet sm" id="save-profile">${icon('fa-regular fa-bookmark')} Save view</button>
        <button class="btn quiet sm" id="customize">${icon('fa-solid fa-sliders')} Customize home</button>
        <button class="btn primary sm" id="add-widget">${icon('fa-solid fa-plus')} Add widget</button>
      </div>
    </header>

    <form class="dash-search" id="dash-search">
      ${icon('fa-solid fa-magnifying-glass')}
      <input id="dash-query" placeholder="Search files, people, events, tasks…" aria-label="Search CoolCloud" autocomplete="off" />
      <div class="segmented" role="tablist" id="mode-switch">
        <button type="button" aria-selected="true" data-mode="search">Search</button>
        ${assistantEnabled ? '<button type="button" aria-selected="false" data-mode="assistant">Assistant</button>' : ''}
      </div>
      <button class="btn primary sm go" type="submit">Go</button>
    </form>

    <div class="bento" id="bento"></div>
  </div>`;

  const bento = root.querySelector('#bento');
  const page = root.querySelector('.page.home');
  if (prefs.wallpaper) {
    page.classList.add('has-wallpaper');
    page.style.backgroundImage = `linear-gradient(180deg, color-mix(in srgb, var(--bg) 55%, transparent), color-mix(in srgb, var(--bg) 75%, transparent)), url("${prefs.wallpaper}")`;
  }

  /* ------------------------------ interactions ----------------------------- */
  let mode = 'search';
  const switchEl = root.querySelector('#mode-switch');
  switchEl?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    mode = button.dataset.mode;
    switchEl.querySelectorAll('button').forEach((node) => node.setAttribute('aria-selected', node === button ? 'true' : 'false'));
    const input = root.querySelector('#dash-query');
    input.placeholder = mode === 'assistant' ? 'Ask the assistant anything…' : 'Search files, people, events, tasks…';
    input.focus();
  });

  root.querySelector('#dash-search').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = root.querySelector('#dash-query').value.trim();
    if (!value) {
      openTab('search');
      return;
    }
    if (mode === 'assistant') {
      try {
        sessionStorage.setItem('cc:assistantPrompt', value);
      } catch {
        /* ignore */
      }
      openTab('cc:assistant');
      return;
    }
    openTab(`search?q=${encodeURIComponent(value)}`);
  });

  root.querySelector('#customize').addEventListener('click', () => openCustomize({ add: false }));
  root.querySelector('#add-widget').addEventListener('click', () => openCustomize({ add: true }));
  root.querySelector('#home-profile').addEventListener('change', async (event) => {
    try {
      const { user: fresh } = await api('/api/me', { method: 'PATCH', body: { prefs: { homeProfile: event.target.value } } });
      state.user = fresh;
      location.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  root.querySelector('#save-profile').addEventListener('click', () => {
    openModal({
      title: 'Save home view',
      sub: 'Profiles keep a separate widget layout for work, weekends or projects.',
      body: `<div class="field"><label class="label">Profile name</label><input class="input" id="profile-name" placeholder="Work" value="${activeProfile === 'Default' ? '' : esc(activeProfile)}" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save view',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const name = dialog.querySelector('#profile-name').value.trim().slice(0, 40);
            if (!name) return false;
            try {
              const nextProfiles = name === 'Default' ? profiles : { ...profiles, [name]: layout };
              const { user: fresh } = await api('/api/me', {
                method: 'PATCH',
                body: { prefs: { homeProfiles: nextProfiles, homeProfile: name, ...(name === 'Default' ? { homeWidgets: layout } : {}) } }
              });
              state.user = fresh;
              toast(`Saved “${name}”`);
              location.reload();
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }
      ]
    });
  });

  const tick = setInterval(() => {
    const clock = root.querySelector('#clock');
    if (!clock) return clearInterval(tick);
    clock.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    root.querySelectorAll('[data-clock-time]').forEach((node) => {
      node.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    });
  }, 15000);

  /* -------------------------------- painting ------------------------------- */
  function paint() {
    if (!layout.length) {
      bento.innerHTML = `<div class="home-empty">
        ${icon('fa-solid fa-wand-magic-sparkles')}
        <h2>Make this home yours</h2>
        <p>Add widgets for your files, tasks, calendar, notes and installed apps.</p>
        <button class="btn primary" data-add-first>${icon('fa-solid fa-plus')} Add your first widget</button>
      </div>`;
      bento.querySelector('[data-add-first]').addEventListener('click', () => openCustomize({ add: true }));
      return;
    }
    bento.innerHTML = layout
      .map((entry) => {
        const meta = widgetMeta(entry);
        if (!meta) return '';
        return `<section class="widget b-span-${entry.span}" data-widget="${esc(entry.uid || entry.id)}">
          <div class="widget-head">
            <span class="widget-title">${icon(meta.icon)} ${esc(meta.name)}</span>
            <span class="widget-tools">
              ${
                meta.link
                  ? `<button class="widget-link" data-widget-link="${esc(entry.uid || entry.id)}">${esc(meta.linkLabel || 'Open')}</button>`
                  : ''
              }
              <button class="widget-menu" data-widget-menu="${esc(entry.uid || entry.id)}" title="Widget options" aria-label="Options for ${esc(
                meta.name
              )}">${icon('fa-solid fa-ellipsis')}</button>
            </span>
          </div>
          <div class="widget-body" data-widget-body="${esc(entry.uid || entry.id)}"><div class="skeleton" style="height:72px"></div></div>
        </section>`;
      })
      .join('');

    bento.querySelectorAll('[data-widget-link]').forEach((node) => {
      node.addEventListener('click', () => {
        const entry = layout.find((item) => (item.uid || item.id) === node.dataset.widgetLink);
        if (entry) handleLink(entry);
      });
    });
    bento.querySelectorAll('[data-widget-menu]').forEach((node) => {
      node.addEventListener('click', () => openWidgetMenu(node, node.dataset.widgetMenu));
    });
    paintBodies();
  }

  function paintBodies() {
    for (const entry of layout) {
      const body = bento.querySelector(`[data-widget-body="${CSS.escape(entry.uid || entry.id)}"]`);
      if (!body) continue;
      const meta = widgetMeta(entry);
      if (!meta) continue;
      if (meta.external) {
        body.innerHTML = '';
        const frame = document.createElement('iframe');
        frame.className = 'widget-frame';
        frame.title = meta.name;
        frame.loading = 'lazy';
        frame.src = `/app-assets/${encodeURIComponent(meta.external.developer)}/${encodeURIComponent(
          meta.external.shortName || meta.external.id.split(':')[1]
        )}/${encodeURIComponent(meta.external.entry || 'web/index.html').replace(/%2F/g, '/')}`;
        body.appendChild(frame);
        continue;
      }
      if (failed) {
        body.innerHTML = `<div class="empty compact"><p>This widget could not load.</p></div>`;
        continue;
      }
      if (!data) continue;
      body.innerHTML = '';
      try {
        BUILTIN_MAP.get(entry.id).render(body, ctx, data, { refresh: loadDashboard });
      } catch (err) {
        console.error(err);
        body.innerHTML = `<div class="empty compact"><p>This widget could not render.</p></div>`;
      }
    }
  }

  function handleLink(entry) {
    const meta = widgetMeta(entry);
    if (!meta) return;
    if (meta.link === 'activity') return document.querySelector('[data-nav="activity"]')?.click();
    if (meta.link) openTab(meta.link);
  }

  function openWidgetMenu(node, id) {
    const entry = layout.find((item) => (item.uid || item.id) === id);
    if (!entry) return;
    document.querySelector('.menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'menu';
    const meta = widgetMeta(entry);
    menu.innerHTML = `
      ${meta?.link ? `<button data-act="open">${icon('fa-solid fa-arrow-up-right-from-square')} Open</button>` : ''}
      <div class="menu-label">Width</div>
      <div class="menu-widths">
        ${WIDTHS.map(
          (width) => `<button data-width="${width}" class="${entry.span === width ? 'is-active' : ''}" title="${width} of 12 columns">${width}</button>`
        ).join('')}
      </div>
      <button data-act="move-left" ${layout.indexOf(entry) === 0 ? 'disabled' : ''}>${icon('fa-solid fa-arrow-left')} Move left</button>
      <button data-act="move-right" ${layout.indexOf(entry) === layout.length - 1 ? 'disabled' : ''}>${icon(
        'fa-solid fa-arrow-right'
      )} Move right</button>
      <button data-act="duplicate">${icon('fa-regular fa-clone')} Add another copy</button>
      <div class="sep"></div>
      <button data-act="remove" class="danger">${icon('fa-solid fa-xmark')} Remove widget</button>`;
    document.body.appendChild(menu);
    const rect = node.getBoundingClientRect();
    menu.style.top = `${Math.min(window.innerHeight - 300, rect.bottom + 6)}px`;
    menu.style.left = `${Math.min(window.innerWidth - 220, rect.right - 200)}px`;
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);

    menu.querySelector('[data-act="open"]')?.addEventListener('click', () => {
      handleLink(entry);
      close();
    });
    menu.querySelectorAll('[data-width]').forEach((node) => {
      node.addEventListener('click', () => {
        close();
        entry.span = normalizeSpan(node.dataset.width, 6);
        paint();
        saveLayout();
      });
    });
    menu.querySelector('[data-act="move-left"]').addEventListener('click', () => {
      close();
      move(id, -1);
    });
    menu.querySelector('[data-act="move-right"]').addEventListener('click', () => {
      close();
      move(id, 1);
    });
    menu.querySelector('[data-act="duplicate"]').addEventListener('click', () => {
      close();
      const index = layout.findIndex((item) => (item.uid || item.id) === id);
      const copy = { ...entry, uid: `${entry.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
      layout.splice(index + 1, 0, copy);
      paint();
      saveLayout();
    });
    menu.querySelector('[data-act="remove"]').addEventListener('click', () => {
      close();
      layout = layout.filter((item) => (item.uid || item.id) !== id);
      paint();
      saveLayout();
      toast(`${meta?.name || 'Widget'} removed`);
    });
  }

  function move(id, direction) {
    const index = layout.findIndex((item) => (item.uid || item.id) === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= layout.length) return;
    const [entry] = layout.splice(index, 1);
    layout.splice(next, 0, entry);
    paint();
    saveLayout();
  }

  async function saveLayout() {
    try {
      const prefsPatch =
        activeProfile === 'Default'
          ? { homeWidgets: layout }
          : { homeProfiles: { ...profiles, [activeProfile]: layout } };
      const { user: fresh } = await api('/api/me', { method: 'PATCH', body: { prefs: prefsPatch } });
      state.user = fresh;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------- customize ------------------------------- */

  function availableWidgets() {
    const used = new Set(layout.map((entry) => entry.id));
    const builtins = BUILTINS.filter((widget) => !used.has(widget.id)).map((widget) => ({
      id: widget.id,
      kind: 'builtin',
      name: widget.name,
      icon: widget.icon,
      description: widget.description,
      span: widget.span
    }));
    const widgets = (state.widgets || [])
      .filter((app) => !used.has(app.id))
      .map((app) => ({
        id: app.id,
        kind: 'widget',
        name: app.name,
        icon: app.icon,
        description: app.description || 'Installed widget',
        span: 5
      }));
    return [...builtins, ...widgets];
  }

  function openCustomize({ add = false } = {}) {
    let dragRowId = '';
    openModal({
      title: 'Customize home',
      sub: 'Reorder, resize, remove or add widgets. Changes save as you go.',
      wide: true,
      body: `<div class="wz-panel">
        <section class="wz-section">
          <div class="wz-section-head"><h3>On your home</h3><span class="badge" id="wz-count">${layout.length}</span></div>
          <div class="wz-list" id="wz-list"></div>
        </section>
        <section class="wz-section">
          <div class="wz-section-head"><h3>Add a widget</h3><span class="badge" id="wz-available">0</span></div>
          <div class="wz-add-grid" id="wz-add"></div>
        </section>
      </div>`,
      actions: [
        {
          label: 'Reset to default',
          kind: 'ghost',
          onClick: () => {
            layout = clampLayout(DEFAULT_LAYOUT);
            paint();
            saveLayout();
            repaintPanel();
            return false;
          }
        },
        { label: 'Done', kind: 'primary' }
      ],
      onMount: (dialog) => {
        const list = dialog.querySelector('#wz-list');
        const addGrid = dialog.querySelector('#wz-add');
        const paintPanel = () => {
          dialog.querySelector('#wz-count').textContent = String(layout.length);
          if (!layout.length) {
            list.innerHTML = `<p class="wz-empty">No widgets yet. Add one below.</p>`;
          } else {
            list.innerHTML = layout
              .map((entry, index) => {
                const meta = widgetMeta(entry);
                if (!meta) return '';
                return `<div class="wz-row" data-id="${esc(entry.uid || entry.id)}" draggable="true">
                  <span class="wz-grip" title="Drag to reorder" aria-hidden="true">${icon('fa-solid fa-grip-vertical')}</span>
                  <span class="app-icon sm" style="--app:var(--accent)">${icon(meta.icon)}</span>
                  <span class="wz-row-name">${esc(meta.name)}${
                  entry.kind === 'widget' ? ' <span class="badge">widget</span>' : ''
                }</span>
                  <span class="wz-span-meter" aria-hidden="true"><i style="width:${(entry.span / 12) * 100}%"></i></span>
                  <select class="select wz-span" data-span="${esc(entry.uid || entry.id)}" aria-label="Width for ${esc(meta.name)}">
                    ${WIDTHS.map(
                      (width) => `<option value="${width}" ${entry.span === width ? 'selected' : ''}>${width}/12</option>`
                    ).join('')}
                  </select>
                  <span class="wz-row-actions">
                    <button class="btn ghost icon sm" data-up="${esc(entry.uid || entry.id)}" ${
                  index === 0 ? 'disabled' : ''
                } title="Move up" aria-label="Move ${esc(meta.name)} up">${icon('fa-solid fa-arrow-up')}</button>
                    <button class="btn ghost icon sm" data-down="${esc(entry.uid || entry.id)}" ${
                  index === layout.length - 1 ? 'disabled' : ''
                } title="Move down" aria-label="Move ${esc(meta.name)} down">${icon('fa-solid fa-arrow-down')}</button>
                    <button class="btn ghost icon sm" data-remove="${esc(entry.uid || entry.id)}" title="Remove" aria-label="Remove ${esc(
                  meta.name
                )}">${icon('fa-solid fa-xmark')}</button>
                  </span>
                </div>`;
              })
              .join('');
          }

          const available = availableWidgets();
          dialog.querySelector('#wz-available').textContent = String(available.length);
          addGrid.innerHTML = available.length
            ? available
                .map(
                  (widget) => `<button class="wz-add" data-add="${esc(widget.id)}">
                    <span class="app-icon sm">${icon(widget.icon)}</span>
                    <span class="wz-add-text"><span class="wz-add-name">${esc(widget.name)}</span>
                    <span class="wz-add-desc">${esc(widget.description)}</span></span>
                    ${icon('fa-solid fa-plus')}
                  </button>`
                )
                .join('')
            : `<p class="wz-empty">Everything available is already on your home. Install more widgets from the App Store.</p>`;

          list.querySelectorAll('[data-up]').forEach((node) => {
            node.addEventListener('click', () => {
              move(node.dataset.up, -1);
              paintPanel();
            });
          });
          list.querySelectorAll('[data-down]').forEach((node) => {
            node.addEventListener('click', () => {
              move(node.dataset.down, 1);
              paintPanel();
            });
          });
          list.querySelectorAll('[data-remove]').forEach((node) => {
            node.addEventListener('click', () => {
              layout = layout.filter((entry) => (entry.uid || entry.id) !== node.dataset.remove);
              paint();
              saveLayout();
              paintPanel();
            });
          });
          list.querySelectorAll('.wz-row').forEach((row) => {
            row.addEventListener('dragstart', (event) => {
              dragRowId = row.dataset.id;
              row.classList.add('dragging');
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', row.dataset.id);
            });
            row.addEventListener('dragend', () => {
              dragRowId = '';
              row.classList.remove('dragging');
              list.querySelectorAll('.wz-row').forEach((node) => node.classList.remove('drop-before', 'drop-after'));
            });
            row.addEventListener('dragover', (event) => {
              if (!dragRowId || dragRowId === row.dataset.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const rect = row.getBoundingClientRect();
              const before = event.clientY < rect.top + rect.height / 2;
              row.classList.toggle('drop-before', before);
              row.classList.toggle('drop-after', !before);
            });
            row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
            row.addEventListener('drop', (event) => {
              event.preventDefault();
              if (!dragRowId || dragRowId === row.dataset.id) return;
              const rect = row.getBoundingClientRect();
              const before = event.clientY < rect.top + rect.height / 2;
              const fromIndex = layout.findIndex((item) => (item.uid || item.id) === dragRowId);
              if (fromIndex === -1) return;
              const [moved] = layout.splice(fromIndex, 1);
              const targetIndex = layout.findIndex((item) => (item.uid || item.id) === row.dataset.id);
              layout.splice(before ? targetIndex : targetIndex + 1, 0, moved);
              dragRowId = '';
              paint();
              saveLayout();
              paintPanel();
            });
          });
          list.querySelectorAll('[data-span]').forEach((node) => {
            node.addEventListener('change', () => {
              const entry = layout.find((item) => (item.uid || item.id) === node.dataset.span);
              if (!entry) return;
              entry.span = normalizeSpan(node.value, 6);
              const meter = node.closest('.wz-row')?.querySelector('.wz-span-meter i');
              if (meter) meter.style.width = `${(entry.span / 12) * 100}%`;
              paint();
              saveLayout();
            });
          });
          addGrid.querySelectorAll('[data-add]').forEach((node) => {
            node.addEventListener('click', () => {
              const widget = available.find((item) => item.id === node.dataset.add);
              if (!widget) return;
              layout.push({ id: widget.id, kind: widget.kind, span: widget.span, uid: `${widget.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
              paint();
              saveLayout();
              paintPanel();
            });
          });
        };
        repaintPanel = paintPanel;
        paintPanel();
        if (add) dialog.querySelector('#wz-add')?.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /* --------------------------------- data --------------------------------- */
  paint();
  loadDashboard();
  loadWeather(root, ctx);

  async function loadDashboard() {
    try {
      const payload = await api('/api/dashboard');
      data = payload;
      failed = false;
      const counts = payload.counts;
      const summary = root.querySelector('#dash-summary .home-chip-text');
      if (summary) {
        const parts = [`${counts.files} file${counts.files === 1 ? '' : 's'}`];
        if (payload.today.length) parts.push(`${payload.today.length} event${payload.today.length === 1 ? '' : 's'} today`);
        if (counts.tasksOpen) parts.push(`${counts.tasksOpen} open task${counts.tasksOpen === 1 ? '' : 's'}`);
        summary.textContent = parts.join(' · ');
      }
      paintBodies();
    } catch {
      failed = true;
      const summary = root.querySelector('#dash-summary .home-chip-text');
      if (summary) summary.textContent = 'Dashboard unavailable';
      paintBodies();
    }
  }

  return () => clearInterval(tick);
}

async function loadWeather(root, ctx) {
  const line = root.querySelector('#weather-line');
  if (!line) return;
  const location = state.user?.prefs?.weather || ctx.user.prefs?.weather;
  if (!location?.lat || !location?.lon) {
    line.innerHTML = `${icon('fa-solid fa-location-dot')}<button class="home-chip-action" data-set-weather>Add location</button>`;
    line.querySelector('[data-set-weather]')?.addEventListener('click', () => openTab('me'));
    return;
  }
  try {
    const weather = await api(`/api/weather?lat=${location.lat}&lon=${location.lon}`);
    if (!line.isConnected || weather.unavailable) return;
    const info = WEATHER[weather.code] || ['fa-cloud', 'Weather'];
    line.innerHTML = `${icon('fa-solid ' + info[0])}<span class="home-chip-text">${Math.round(weather.temperature)}${
      weather.units || '°C'
    } · ${esc(info[1])}</span>`;
  } catch {
    /* weather is decoration */
  }
}
