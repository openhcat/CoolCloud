import { requireUser } from '../auth.js';
import { sendJson } from '../http.js';
import { nowISO } from '../util.js';
import { runRules } from '../storage.js';
import crypto from 'node:crypto';

const COLORS = new Set(['teal', 'blue', 'amber', 'rose', 'violet', 'slate']);

function recurrenceStep(rule) {
  const text = String(rule || '').toUpperCase();
  if (!text) return null;
  const interval = Math.max(1, Math.min(30, Number((/INTERVAL=(\d+)/.exec(text) || [])[1] || 1)));
  if (text.includes('FREQ=DAILY')) return { unit: 'day', interval };
  if (text.includes('FREQ=WEEKLY')) return { unit: 'week', interval };
  if (text.includes('FREQ=MONTHLY')) return { unit: 'month', interval };
  if (text.includes('FREQ=YEARLY')) return { unit: 'year', interval };
  return null;
}

function advance(date, step) {
  const next = new Date(date);
  if (step.unit === 'day') next.setDate(next.getDate() + step.interval);
  else if (step.unit === 'week') next.setDate(next.getDate() + step.interval * 7);
  else if (step.unit === 'month') next.setMonth(next.getMonth() + step.interval);
  else next.setFullYear(next.getFullYear() + step.interval);
  return next;
}

/** Expand recurring rows into the requested window so every view sees them. */
function expandRows(rows, from, to) {
  if (!from || !to) return rows;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return rows;
  const out = [];
  for (const row of rows) {
    const start = new Date(row.start_at);
    const end = new Date(row.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const step = recurrenceStep(row.recurrence);
    if (!step) {
      if (start.getTime() < toMs && end.getTime() >= fromMs) out.push(row);
      continue;
    }
    const duration = Math.max(0, end.getTime() - start.getTime());
    let cursor = start;
    for (let guard = 0; guard < 400 && cursor.getTime() < toMs; guard++) {
      const finish = new Date(cursor.getTime() + duration);
      if (finish.getTime() >= fromMs) {
        out.push({ ...row, start_at: cursor.toISOString(), end_at: finish.toISOString(), occurrence: cursor.toISOString() });
      }
      cursor = advance(cursor, step);
    }
  }
  return out.sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
}

export function registerWorkspace(router) {
  /* ------------------------------- calendar ------------------------------- */
  router.get('/api/calendar', async (ctx) => {
    const user = requireUser(ctx);
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const allRows =
      from && to
        ? ctx.db.prepare('SELECT * FROM events WHERE owner_id = ? ORDER BY start_at ASC LIMIT 1000').all(user.id)
        : ctx.db.prepare('SELECT * FROM events WHERE owner_id = ? ORDER BY start_at ASC LIMIT 500').all(user.id);
    const rows = from && to ? expandRows(allRows, from, to) : allRows;
    sendJson(ctx.res, 200, {
      events: rows.map((row) => ({
        id: row.id,
        title: row.title,
        start: row.start_at,
        end: row.end_at,
        allDay: Boolean(row.all_day),
        location: row.location,
        notes: row.notes,
        calendar: row.calendar,
        color: row.color,
        recurrence: row.recurrence || '',
        reminderMin: row.reminder_min || 0,
        attendees: row.attendees || '',
        uid: row.uid || '',
        occurrence: row.occurrence || ''
      }))
    });
  });

  router.post('/api/calendar', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const title = String(body.title || '').trim();
    if (!title) return sendJson(ctx.res, 400, { error: 'Give the event a title' });
    const start = String(body.start || nowISO());
    const end = String(body.end || start);
    const info = ctx.db
      .prepare(
        'INSERT INTO events (owner_id, calendar, title, start_at, end_at, all_day, location, notes, color, created_at, recurrence, reminder_min, attendees, uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        user.id,
        String(body.calendar || 'Personal').slice(0, 60),
        title.slice(0, 200),
        start,
        end,
        body.allDay ? 1 : 0,
        String(body.location || '').slice(0, 200),
        String(body.notes || '').slice(0, 4000),
        COLORS.has(body.color) ? body.color : 'teal',
        nowISO(),
        String(body.recurrence || '').slice(0, 200),
        Math.max(0, Math.min(10080, Number(body.reminderMin || 0))),
        String(body.attendees || '').slice(0, 500),
        `cc-${crypto.randomUUID()}@coolcloud`
      );
    runRules(ctx, 'event.created', { userId: user.id, title, list: body.calendar });
    sendJson(ctx.res, 200, { id: Number(info.lastInsertRowid) });
  });

  router.patch('/api/calendar/:id', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const row = ctx.db.prepare('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(Number(ctx.params.id), user.id);
    if (!row) return sendJson(ctx.res, 404, { error: 'Event not found' });
    ctx.db
      .prepare(
        'UPDATE events SET title = ?, start_at = ?, end_at = ?, all_day = ?, location = ?, notes = ?, calendar = ?, color = ?, recurrence = ?, reminder_min = ?, attendees = ? WHERE id = ?'
      )
      .run(
        body.title !== undefined ? String(body.title).slice(0, 200) : row.title,
        body.start !== undefined ? String(body.start) : row.start_at,
        body.end !== undefined ? String(body.end) : row.end_at,
        body.allDay !== undefined ? (body.allDay ? 1 : 0) : row.all_day,
        body.location !== undefined ? String(body.location).slice(0, 200) : row.location,
        body.notes !== undefined ? String(body.notes).slice(0, 4000) : row.notes,
        body.calendar !== undefined ? String(body.calendar).slice(0, 60) : row.calendar,
        body.color !== undefined && COLORS.has(body.color) ? body.color : row.color,
        body.recurrence !== undefined ? String(body.recurrence).slice(0, 200) : row.recurrence,
        body.reminderMin !== undefined ? Math.max(0, Math.min(10080, Number(body.reminderMin))) : row.reminder_min,
        body.attendees !== undefined ? String(body.attendees).slice(0, 500) : row.attendees,
        row.id
      );
    ctx.db.prepare('UPDATE events SET reminder_sent = 0 WHERE id = ?').run(row.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/calendar/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM events WHERE id = ? AND owner_id = ?').run(Number(ctx.params.id), user.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /* ------------------------------- contacts ------------------------------- */
  const contactOut = (row) => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    phone: row.phone,
    organization: row.organization,
    jobTitle: row.job_title,
    notes: row.notes
  });

  router.get('/api/contacts', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db
      .prepare('SELECT * FROM contacts WHERE owner_id = ? ORDER BY first_name COLLATE NOCASE ASC')
      .all(user.id);
    sendJson(ctx.res, 200, { contacts: rows.map(contactOut) });
  });

  router.post('/api/contacts', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const first = String(body.firstName || '').trim();
    if (!first) return sendJson(ctx.res, 400, { error: 'A first name is required' });
    const info = ctx.db
      .prepare(
        'INSERT INTO contacts (owner_id, first_name, last_name, email, phone, organization, job_title, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        user.id,
        first.slice(0, 80),
        String(body.lastName || '').slice(0, 80),
        String(body.email || '').slice(0, 160),
        String(body.phone || '').slice(0, 60),
        String(body.organization || '').slice(0, 120),
        String(body.jobTitle || '').slice(0, 120),
        String(body.notes || '').slice(0, 4000),
        nowISO()
      );
    sendJson(ctx.res, 200, { id: Number(info.lastInsertRowid) });
  });

  router.patch('/api/contacts/:id', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const row = ctx.db.prepare('SELECT * FROM contacts WHERE id = ? AND owner_id = ?').get(Number(ctx.params.id), user.id);
    if (!row) return sendJson(ctx.res, 404, { error: 'Contact not found' });
    ctx.db
      .prepare(
        'UPDATE contacts SET first_name = ?, last_name = ?, email = ?, phone = ?, organization = ?, job_title = ?, notes = ? WHERE id = ?'
      )
      .run(
        body.firstName !== undefined ? String(body.firstName).slice(0, 80) : row.first_name,
        body.lastName !== undefined ? String(body.lastName).slice(0, 80) : row.last_name,
        body.email !== undefined ? String(body.email).slice(0, 160) : row.email,
        body.phone !== undefined ? String(body.phone).slice(0, 60) : row.phone,
        body.organization !== undefined ? String(body.organization).slice(0, 120) : row.organization,
        body.jobTitle !== undefined ? String(body.jobTitle).slice(0, 120) : row.job_title,
        body.notes !== undefined ? String(body.notes).slice(0, 4000) : row.notes,
        row.id
      );
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/contacts/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM contacts WHERE id = ? AND owner_id = ?').run(Number(ctx.params.id), user.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /* -------------------------------- tasks -------------------------------- */
  router.get('/api/tasks', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db
      .prepare('SELECT * FROM tasks WHERE owner_id = ? ORDER BY done ASC, due IS NULL, due ASC, id DESC')
      .all(user.id);
    sendJson(ctx.res, 200, {
      tasks: rows.map((row) => ({
        id: row.id,
        title: row.title,
        notes: row.notes,
        list: row.list,
        done: Boolean(row.done),
        due: row.due,
        priority: row.priority,
        recurrence: row.recurrence || '',
        parentId: row.parent_id || null,
        tags: row.tags || '',
        createdAt: row.created_at
      }))
    });
  });

  router.post('/api/tasks', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const title = String(body.title || '').trim();
    if (!title) return sendJson(ctx.res, 400, { error: 'Give the task a title' });
    const info = ctx.db
      .prepare('INSERT INTO tasks (owner_id, title, notes, list, due, priority, created_at, recurrence, parent_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        user.id,
        title.slice(0, 200),
        String(body.notes || '').slice(0, 4000),
        String(body.list || 'Inbox').slice(0, 60),
        body.due ? String(body.due) : null,
        ['low', 'normal', 'high'].includes(body.priority) ? body.priority : 'normal',
        nowISO(),
        ['daily', 'weekly', 'monthly'].includes(body.recurrence) ? body.recurrence : '',
        body.parentId ? Number(body.parentId) : null,
        String(body.tags || '').slice(0, 200)
      );
    runRules(ctx, 'task.created', { userId: user.id, title, list: body.list });
    sendJson(ctx.res, 200, { id: Number(info.lastInsertRowid) });
  });

  router.patch('/api/tasks/:id', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const row = ctx.db.prepare('SELECT * FROM tasks WHERE id = ? AND owner_id = ?').get(Number(ctx.params.id), user.id);
    if (!row) return sendJson(ctx.res, 404, { error: 'Task not found' });
    const done = body.done !== undefined ? (body.done ? 1 : 0) : row.done;
    ctx.db
      .prepare('UPDATE tasks SET title = ?, notes = ?, list = ?, done = ?, due = ?, priority = ?, completed_at = ?, recurrence = ?, parent_id = ?, tags = ? WHERE id = ?')
      .run(
        body.title !== undefined ? String(body.title).slice(0, 200) : row.title,
        body.notes !== undefined ? String(body.notes).slice(0, 4000) : row.notes,
        body.list !== undefined ? String(body.list).slice(0, 60) : row.list,
        done,
        body.due !== undefined ? (body.due ? String(body.due) : null) : row.due,
        body.priority !== undefined && ['low', 'normal', 'high'].includes(body.priority) ? body.priority : row.priority,
        done ? nowISO() : null,
        body.recurrence !== undefined ? (['daily', 'weekly', 'monthly'].includes(body.recurrence) ? body.recurrence : '') : row.recurrence,
        body.parentId !== undefined ? (body.parentId ? Number(body.parentId) : null) : row.parent_id,
        body.tags !== undefined ? String(body.tags).slice(0, 200) : row.tags,
        row.id
      );
    if (done && !row.done) {
      runRules(ctx, 'task.completed', { userId: user.id, title: row.title, list: row.list });
      const recurrence = body.recurrence !== undefined ? body.recurrence : row.recurrence;
      if (['daily', 'weekly', 'monthly'].includes(recurrence)) {
        const base = row.due ? new Date(row.due) : new Date();
        if (recurrence === 'daily') base.setDate(base.getDate() + 1);
        if (recurrence === 'weekly') base.setDate(base.getDate() + 7);
        if (recurrence === 'monthly') base.setMonth(base.getMonth() + 1);
        ctx.db
          .prepare('INSERT INTO tasks (owner_id, title, notes, list, due, priority, created_at, recurrence, parent_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(user.id, row.title, row.notes, row.list, base.toISOString().slice(0, 10), row.priority, nowISO(), recurrence, row.parent_id, row.tags);
      }
    }
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/tasks/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM tasks WHERE id = ? AND owner_id = ?').run(Number(ctx.params.id), user.id);
    sendJson(ctx.res, 200, { ok: true });
  });
}
