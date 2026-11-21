import { api, esc, fmtDate, fmtTime, icon, openModal, toast } from '../core.js';

const COLORS = {
  teal: '#0f7b6c',
  blue: '#3b6f95',
  amber: '#a8792a',
  rose: '#a35570',
  violet: '#6c5a80',
  slate: '#5a6670'
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfGrid(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const weekday = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - weekday);
  start.setHours(0, 0, 0, 0);
  return start;
}

function startOfWeek(date) {
  const start = new Date(date);
  const weekday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - weekday);
  start.setHours(0, 0, 0, 0);
  return start;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localDateTime(date, time) {
  const [hours, minutes] = String(time || '09:00').split(':').map(Number);
  const copy = new Date(date);
  copy.setHours(hours || 0, minutes || 0, 0, 0);
  return copy;
}

export default function mount(root, ctx) {
  let month = new Date();
  month.setDate(1);
  let events = [];
  let loading = true;
  let view = 'month';
  let dragged = null;

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Calendar</h1>
        <p class="page-sub" id="cal-range"></p>
      </div>
      <div class="page-actions">
        <div class="segmented">
          <button data-nav="prev" aria-label="Previous">${icon('fa-solid fa-chevron-left')}</button>
          <button data-nav="today">Today</button>
          <button data-nav="next" aria-label="Next">${icon('fa-solid fa-chevron-right')}</button>
        </div>
        <div class="segmented" id="cal-view"><button data-view="month" aria-selected="true">Month</button><button data-view="week" aria-selected="false">Week</button></div>
        <button class="btn quiet sm" id="import-ics">${icon('fa-solid fa-file-import')} Import</button>
        <a class="btn quiet sm" href="/api/calendar/export.ics" download>${icon('fa-solid fa-file-export')} ICS</a>
        <button class="btn primary sm" id="new-event">${icon('fa-solid fa-plus')} New event</button>
      </div>
    </header>

    <div class="cal-shell">
      <aside class="cal-side">
        <div class="widget" style="gap:10px">
          <div class="widget-head"><span class="widget-title">${icon('fa-regular fa-calendar')} Upcoming</span></div>
          <div id="upcoming" class="stack-2"></div>
        </div>
        <div class="widget" style="gap:8px">
          <div class="widget-head"><span class="widget-title">${icon('fa-solid fa-tag')} Calendars</span></div>
          <div class="cal-list">
            ${Object.entries({ Personal: 'teal', Work: 'blue', Family: 'rose' })
              .map(
                ([name, color]) =>
                  `<div class="cal-list-item"><span class="cal-swatch ${color}"></span>${name}</div>`
              )
              .join('')}
          </div>
        </div>
      </aside>

      <div class="cal-grid" id="cal-week-wrap">
        <div class="cal-weekhead">${WEEKDAYS.map((day) => `<div>${day}</div>`).join('')}</div>
        <div class="cal-days" id="days">${'<div class="cal-day"><div class="skeleton" style="height:80px"></div></div>'.repeat(7)}</div>
      </div>
    </div>
    <input type="file" id="ics-file" accept=".ics,text/calendar" hidden />
  </div>`;

  const daysEl = root.querySelector('#days');
  const rangeEl = root.querySelector('#cal-range');
  const upcomingEl = root.querySelector('#upcoming');

  root.querySelectorAll('[data-nav]').forEach((node) => {
    node.addEventListener('click', () => {
      if (node.dataset.nav === 'prev') {
        if (view === 'week') month = new Date(month.getTime() - 7 * 86400000);
        else month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
      }
      if (node.dataset.nav === 'next') {
        if (view === 'week') month = new Date(month.getTime() + 7 * 86400000);
        else month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      }
      if (node.dataset.nav === 'today') month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      load();
    });
  });

  root.querySelector('#cal-view').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    view = button.dataset.view;
    root.querySelectorAll('[data-view]').forEach((node) => node.setAttribute('aria-selected', node === button ? 'true' : 'false'));
    load();
  });

  root.querySelector('#new-event').addEventListener('click', () => openEditor(dateKey(new Date())));

  root.querySelector('#import-ics').addEventListener('click', () => root.querySelector('#ics-file').click());
  root.querySelector('#ics-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = await api('/api/calendar/import.ics', { method: 'POST', body: { text } });
      toast(`${data.imported} event${data.imported === 1 ? '' : 's'} imported`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
    event.target.value = '';
  });

  async function load() {
    loading = true;
    const start = view === 'week' ? startOfWeek(month) : startOfGrid(month);
    const end = new Date(start);
    end.setDate(start.getDate() + (view === 'week' ? 7 : 42));
    rangeEl.textContent =
      view === 'week'
        ? `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(end.getTime() - 86400000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
        : month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    try {
      const data = await api(`/api/calendar?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
      events = data.events;
    } catch (err) {
      toast(err.message, 'error');
      events = [];
    }
    loading = false;
    render();
    renderUpcoming();
  }

  function render() {
    if (view === 'week') return renderWeek();
    daysEl.classList.remove('week-mode');
    root.querySelector('#cal-week-wrap').classList.remove('week-view');
    const start = startOfGrid(month);
    const todayKey = dateKey(new Date());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const key = dateKey(date);
      const dayEvents = events
        .filter((event) => {
          const eventStart = new Date(event.start);
          const eventEnd = new Date(event.end);
          return dateKey(eventStart) <= key && dateKey(eventEnd) >= key;
        })
        .slice(0, 3);
      cells.push(`<div class="cal-day ${date.getMonth() !== month.getMonth() ? 'out' : ''} ${
        key === todayKey ? 'today' : ''
      }" data-date="${key}">
        <div class="cal-date">${date.getDate()}</div>
        ${dayEvents
          .map(
            (event) =>
              `<button class="cal-event" draggable="true" data-event="${event.id}" data-start="${esc(event.start)}" style="--ev:${COLORS[event.color] || COLORS.teal}" title="${esc(
                event.title
              )}">${esc(event.title)}</button>`
          )
          .join('')}
        ${events.filter((event) => dateKey(new Date(event.start)) === key && !dayEvents.includes(event)).length > 3 ? '<span class="tiny dim">more…</span>' : ''}
      </div>`);
    }
    daysEl.innerHTML = cells.join('');

    daysEl.querySelectorAll('.cal-day').forEach((cell) => {
      cell.addEventListener('click', (event) => {
        if (event.target.closest('.cal-event')) return;
        openEditor(cell.dataset.date);
      });
      cell.addEventListener('dragover', (event) => {
        if (!dragged) return;
        event.preventDefault();
        cell.classList.add('drop-target');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
      cell.addEventListener('drop', async (event) => {
        event.preventDefault();
        cell.classList.remove('drop-target');
        if (!dragged) return;
        const old = new Date(dragged.start);
        const next = new Date(`${cell.dataset.date}T00:00:00`);
        const delta = next.getTime() - new Date(old.getFullYear(), old.getMonth(), old.getDate()).getTime();
        const start = new Date(old.getTime() + delta);
        const end = new Date(new Date(dragged.end).getTime() + delta);
        try {
          await api(`/api/calendar/${dragged.id}`, { method: 'PATCH', body: { start: start.toISOString(), end: end.toISOString() } });
          toast('Event moved');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    daysEl.querySelectorAll('[data-event]').forEach((node) => {
      node.addEventListener('dragstart', (event) => {
        const found = events.find((item) => String(item.id) === node.dataset.event && item.start === node.dataset.start);
        dragged = found || null;
        if (dragged) event.dataTransfer.effectAllowed = 'move';
      });
      node.addEventListener('dragend', () => {
        dragged = null;
        daysEl.querySelectorAll('.drop-target').forEach((cell) => cell.classList.remove('drop-target'));
      });
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        const found = events.find((item) => String(item.id) === node.dataset.event && item.start === node.dataset.start);
        if (found) openEditor(null, found);
      });
    });
  }

  function renderWeek() {
    const start = startOfWeek(month);
    const todayKey = dateKey(new Date());
    daysEl.classList.add('week-mode');
    root.querySelector('#cal-week-wrap').classList.add('week-view');
    daysEl.innerHTML = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = dateKey(date);
      const dayEvents = events
        .filter((event) => {
          const eventStart = new Date(event.start);
          const eventEnd = new Date(event.end);
          return dateKey(eventStart) === key || (event.allDay && dateKey(eventStart) <= key && dateKey(eventEnd) >= key);
        })
        .sort((a, b) => new Date(a.start) - new Date(b.start));
      return `<div class="cal-week-col ${key === todayKey ? 'today' : ''}" data-week-date="${key}">
        <div class="cal-week-head"><span>${esc(WEEKDAYS[index])}</span><strong>${date.getDate()}</strong></div>
        <div class="cal-week-events">${dayEvents
          .map(
            (event) => `<button class="cal-week-event" data-week-event="${event.id}" data-start="${esc(event.start)}" style="--ev:${COLORS[event.color] || COLORS.teal}">
              <span class="cal-week-time">${event.allDay ? 'All day' : fmtTime(event.start)}</span>
              <span class="cal-week-title">${esc(event.title)}</span>
              ${event.location ? `<span class="cal-week-place">${esc(event.location)}</span>` : ''}
            </button>`
          )
          .join('')}</div>
        <button class="cal-week-add" data-week-add="${key}" aria-label="Add event">${icon('fa-solid fa-plus')}</button>
      </div>`;
    }).join('');
    daysEl.querySelectorAll('[data-week-event]').forEach((node) => {
      node.addEventListener('click', () => {
        const found = events.find((item) => String(item.id) === node.dataset.weekEvent && item.start === node.dataset.start);
        if (found) openEditor(null, found);
      });
    });
    daysEl.querySelectorAll('[data-week-add]').forEach((node) => node.addEventListener('click', () => openEditor(node.dataset.weekAdd)));
  }

  function renderUpcoming() {
    const now = new Date();
    const upcoming = events
      .filter((event) => new Date(event.end) >= now)
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, 5);
    upcomingEl.innerHTML = upcoming.length
      ? upcoming
          .map(
            (event) => `<button class="file-line" data-up="${event.id}">
              <span class="cal-swatch ${event.color}" style="width:8px;height:8px"></span>
              <span class="grow"><span class="file-line-name" style="display:block">${esc(event.title)}</span>
              <span class="tiny dim">${fmtDate(event.start, { time: true })}</span></span>
            </button>`
          )
          .join('')
      : `<p class="hint">No upcoming events.</p>`;
    upcomingEl.querySelectorAll('[data-up]').forEach((node) => {
      node.addEventListener('click', () => {
        const found = events.find((item) => String(item.id) === node.dataset.up);
        if (found) openEditor(null, found);
      });
    });
  }

  function openEditor(dateString, existing = null) {
    const baseDate = existing ? new Date(existing.start) : new Date(dateString || dateKey(new Date()));
    const defaultDate = dateKey(baseDate);
    const startTime = existing ? `${String(baseDate.getHours()).padStart(2, '0')}:${String(baseDate.getMinutes()).padStart(2, '0')}` : '09:00';
    const endDate = existing ? new Date(existing.end) : localDateTime(baseDate, '10:00');
    const endTime = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`;

    openModal({
      title: existing ? 'Edit event' : 'New event',
      body: `<form id="event-form" class="stack-3">
        <div class="field"><label class="label">Title</label><input class="input" name="title" required value="${esc(
          existing?.title || ''
        )}" placeholder="Design review" /></div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Date</label><input class="input" type="date" name="date" value="${defaultDate}" required /></div>
          <div class="field" style="width:96px"><label class="label">Start</label><input class="input" type="time" name="start" value="${startTime}" /></div>
          <div class="field" style="width:96px"><label class="label">End</label><input class="input" type="time" name="end" value="${endTime}" /></div>
        </div>
        <label class="check"><input type="checkbox" name="allDay" ${existing?.allDay ? 'checked' : ''} /> All day</label>
        <div class="field"><label class="label">Location</label><input class="input" name="location" value="${esc(
          existing?.location || ''
        )}" placeholder="Optional" /></div>
        <div class="field"><label class="label">Notes</label><textarea class="textarea" name="notes" rows="3">${esc(
          existing?.notes || ''
        )}</textarea></div>
        <div class="field-row">
          <div class="field"><label class="label">Repeats</label><select class="select" name="recurrence">
            <option value="">Never</option>
            <option value="FREQ=DAILY" ${existing?.recurrence === 'FREQ=DAILY' ? 'selected' : ''}>Every day</option>
            <option value="FREQ=WEEKLY" ${existing?.recurrence === 'FREQ=WEEKLY' ? 'selected' : ''}>Every week</option>
            <option value="FREQ=MONTHLY" ${existing?.recurrence === 'FREQ=MONTHLY' ? 'selected' : ''}>Every month</option>
          </select></div>
          <div class="field"><label class="label">Reminder</label><select class="select" name="reminderMin">
            ${[[0, 'None'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']]
              .map(([value, label]) => `<option value="${value}" ${Number(existing?.reminderMin || 0) === value ? 'selected' : ''}>${label}</option>`)
              .join('')}
          </select></div>
        </div>
        <div class="field"><label class="label">Attendees</label><input class="input" name="attendees" value="${esc(
          existing?.attendees || ''
        )}" placeholder="ana@example.com, sam@example.com" /><span class="hint">Separate addresses with commas. Use Email invite to send them the details.</span></div>
        <div class="field"><label class="label">Calendar</label>
          <select class="select" name="calendar">
            ${['Personal', 'Work', 'Family']
              .map((name) => `<option ${existing?.calendar === name ? 'selected' : ''}>${name}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field"><label class="label">Colour</label>
          <div class="row-tight" id="color-row">
            ${Object.entries(COLORS)
              .map(
                ([name, hex]) =>
                  `<button type="button" class="btn ghost icon sm" data-color="${name}" style="background:${
                    existing?.color === name ? 'var(--surface-3)' : 'transparent'
                  }"><span class="cal-swatch" style="background:${hex};width:12px;height:12px;border-radius:4px"></span></button>`
              )
              .join('')}
          </div>
          <input type="hidden" name="color" value="${existing?.color || 'teal'}" />
        </div>
      </form>`,
      wide: true,
      actions: [
        ...(existing
          ? [
              {
                label: 'ICS',
                kind: 'quiet',
                onClick: () => {
                  window.open(`/api/calendar/${existing.id}/ics`, '_blank');
                  return false;
                }
              },
              {
                label: 'Email invite',
                kind: 'quiet',
                onClick: async () => {
                  if (!existing.attendees) {
                    toast('Add attendee addresses first', 'error');
                    return false;
                  }
                  try {
                    await api('/api/mail/send', {
                      method: 'POST',
                      body: {
                        to: existing.attendees,
                        subject: `Invite: ${existing.title}`,
                        text: `${existing.title}\n${fmtDate(existing.start, { time: true })}${existing.location ? `\n${existing.location}` : ''}\n\n${existing.notes || ''}`
                      }
                    });
                    toast('Invite sent');
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                  return false;
                }
              },
              {
                label: 'Delete',
                kind: 'danger',
                onClick: async () => {
                  await api(`/api/calendar/${existing.id}`, { method: 'DELETE' });
                  toast('Event deleted');
                  load();
                }
              }
            ]
          : []),
        { label: 'Cancel', kind: 'ghost' },
        {
          label: existing ? 'Save event' : 'Create event',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const form = dialog.querySelector('#event-form');
            const data = new FormData(form);
            const title = String(data.get('title') || '').trim();
            if (!title) return false;
            const day = String(data.get('date'));
            const allDay = data.get('allDay') === 'on';
            const startAt = allDay ? localDateTime(new Date(`${day}T00:00:00`), '00:00') : localDateTime(new Date(`${day}T00:00:00`), data.get('start'));
            const endAt = allDay
              ? new Date(localDateTime(new Date(`${day}T00:00:00`), '23:59').getTime())
              : localDateTime(new Date(`${day}T00:00:00`), data.get('end') || data.get('start'));
            if (endAt < startAt) endAt.setDate(endAt.getDate() + 1);
            const payload = {
              title,
              start: startAt.toISOString(),
              end: endAt.toISOString(),
              allDay,
              location: data.get('location'),
              notes: data.get('notes'),
              calendar: data.get('calendar'),
              color: data.get('color'),
              recurrence: data.get('recurrence'),
              reminderMin: Number(data.get('reminderMin') || 0),
              attendees: data.get('attendees')
            };
            if (existing) await api(`/api/calendar/${existing.id}`, { method: 'PATCH', body: payload });
            else await api('/api/calendar', { method: 'POST', body: payload });
            toast(existing ? 'Event saved' : 'Event created');
            load();
          }
        }
      ],
      onMount: (dialog) => {
        dialog.querySelectorAll('[data-color]').forEach((node) => {
          node.addEventListener('click', () => {
            dialog.querySelector('input[name="color"]').value = node.dataset.color;
            dialog.querySelectorAll('[data-color]').forEach((other) => (other.style.background = 'transparent'));
            node.style.background = 'var(--surface-3)';
          });
        });
      }
    });
  }

  load();
}
