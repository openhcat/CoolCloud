import { api, esc, fmtDate, icon, openModal, toast } from '../core.js';

export default function mount(root, ctx) {
  let tasks = [];
  let filter = 'open';
  let view = 'list';
  let dragged = null;

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Tasks</h1>
        <p class="page-sub" id="task-sub">Everything you owe yourself.</p>
      </div>
      <div class="page-actions">
        <div class="segmented" id="filters">
          <button data-filter="open" aria-selected="true">Open</button>
          <button data-filter="all" aria-selected="false">All</button>
          <button data-filter="done" aria-selected="false">Done</button>
        </div>
        <div class="segmented" id="task-views"><button data-view="list" aria-selected="true">List</button><button data-view="board" aria-selected="false">Board</button></div>
      </div>
    </header>

    <form class="dash-search" id="add-task" style="max-width:none">
      ${icon('fa-solid fa-plus')}
      <input id="task-title" placeholder="Add a task and press Enter" aria-label="New task" />
      <input class="input" type="date" id="task-due" style="max-width:160px;height:34px" aria-label="Due date" />
      <select class="select" id="task-priority" style="max-width:120px;height:34px" aria-label="Priority">
        <option value="normal">Normal</option>
        <option value="high">High</option>
        <option value="low">Low</option>
      </select>
      <select class="select" id="task-repeat" style="max-width:130px;height:34px" aria-label="Repeat">
        <option value="">No repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
      </select>
      <button class="btn primary sm" type="submit">Add</button>
    </form>

    <div class="task-board" id="board"></div>
  </div>`;

  const board = root.querySelector('#board');
  const sub = root.querySelector('#task-sub');

  root.querySelector('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    root.querySelectorAll('[data-filter]').forEach((node) => node.setAttribute('aria-selected', node === button ? 'true' : 'false'));
    render();
  });

  root.querySelector('#task-views').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    view = button.dataset.view;
    root.querySelectorAll('[data-view]').forEach((node) => node.setAttribute('aria-selected', node === button ? 'true' : 'false'));
    render();
  });

  root.querySelector('#add-task').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = root.querySelector('#task-title').value.trim();
    if (!title) return;
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: {
          title,
          due: root.querySelector('#task-due').value || null,
          priority: root.querySelector('#task-priority').value,
          recurrence: root.querySelector('#task-repeat').value
        }
      });
      root.querySelector('#task-title').value = '';
      root.querySelector('#task-due').value = '';
      root.querySelector('#task-priority').value = 'normal';
      root.querySelector('#task-repeat').value = '';
      toast('Task added');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function load() {
    try {
      const data = await api('/api/tasks');
      tasks = data.tasks;
    } catch (err) {
      toast(err.message, 'error');
    }
    render();
  }

  function render() {
    const open = tasks.filter((task) => !task.done).length;
    sub.textContent = `${open} open · ${tasks.length - open} done`;
    const visible = tasks.filter((task) => (filter === 'open' ? !task.done : filter === 'done' ? task.done : true));
    if (view === 'board') return renderBoard(visible);
    const roots = visible.filter((task) => !task.parentId);
    board.innerHTML = roots.length
      ? visible
          .map(
            (task) => (task.parentId ? '' : `<div class="task-row ${task.done ? 'done' : ''}" data-id="${task.id}">
              <button class="task-check ${task.done ? '' : ''}" data-toggle aria-label="${task.done ? 'Mark open' : 'Complete'}">
                ${icon('fa-solid fa-check')}
              </button>
              <div class="grow">
                <div class="title">${esc(task.title)}</div>
                <div class="tiny dim">${esc(task.list)}${task.recurrence ? ` · repeats ${esc(task.recurrence)}` : ''}${task.notes ? ` · ${esc(task.notes.slice(0, 80))}` : ''}${task.tags ? ` · ${esc(task.tags)}` : ''}</div>
                ${subtasksOf(task.id)
                  .map(
                    (child) => `<div class="subtask ${child.done ? 'done' : ''}" data-subtask="${child.id}"><button class="task-check sm" data-toggle-sub aria-label="Toggle subtask">${icon('fa-solid fa-check')}</button><span class="grow">${esc(child.title)}</span></div>`
                  )
                  .join('')}
              </div>
              <div class="meta">
                ${task.due ? `<span class="badge ${new Date(task.due) < new Date() && !task.done ? 'warn' : ''}">${fmtDate(task.due)}</span>` : ''}
                <span class="prio ${task.priority}">${icon(
                  task.priority === 'high' ? 'fa-solid fa-circle-exclamation' : task.priority === 'low' ? 'fa-solid fa-circle-minus' : 'fa-solid fa-circle'
                )} ${task.priority}</span>
                <button class="btn ghost icon sm" data-sub-add aria-label="Add subtask" title="Add subtask">${icon('fa-solid fa-turn-up')}</button>
                <button class="btn ghost icon sm" data-edit aria-label="Edit">${icon('fa-solid fa-pen')}</button>
                <button class="btn ghost icon sm" data-delete aria-label="Delete">${icon('fa-solid fa-trash-can')}</button>
              </div>
            </div>`)
          )
          .join('')
      : `<div class="empty card">${icon('fa-regular fa-circle-check')}<p>${
          filter === 'done' ? 'Nothing completed yet.' : 'No tasks here. Add one above.'
        }</p></div>`;

    board.querySelectorAll('[data-id]').forEach((row) => {
      const task = tasks.find((item) => String(item.id) === row.dataset.id);
      row.querySelector('[data-toggle]').addEventListener('click', async () => {
        await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } });
        load();
      });
      row.querySelector('[data-delete]').addEventListener('click', async () => {
        await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
        toast('Task removed');
        load();
      });
      row.querySelector('[data-edit]').addEventListener('click', () => edit(task));
      row.querySelector('[data-sub-add]').addEventListener('click', () => addSubtask(task));
      row.querySelectorAll('[data-subtask]').forEach((child) => {
        child.querySelector('[data-toggle-sub]').addEventListener('click', async () => {
          const sub = tasks.find((item) => String(item.id) === child.dataset.subtask);
          if (!sub) return;
          await api(`/api/tasks/${sub.id}`, { method: 'PATCH', body: { done: !sub.done } });
          load();
        });
      });
    });
  }

  function subtasksOf(id) {
    return tasks.filter((task) => Number(task.parentId) === Number(id));
  }

  function renderBoard(visible) {
    const lists = [...new Set(visible.filter((task) => !task.done).map((task) => task.list || 'Inbox'))];
    if (!lists.length) lists.push('Inbox');
    const columns = [
      ...lists.map((list) => ({ title: list, tasks: visible.filter((task) => !task.done && (task.list || 'Inbox') === list) })),
      { title: 'Done', tasks: visible.filter((task) => task.done) }
    ];
    board.innerHTML = `<div class="task-kanban">${columns
      .map(
        (column) => `<section class="task-column" data-list="${esc(column.title)}">
          <div class="task-column-head"><span>${esc(column.title)}</span><span class="badge">${column.tasks.length}</span></div>
          <div class="task-column-body">${column.tasks
            .map(
              (task) => `<article class="task-card ${task.done ? 'done' : ''}" draggable="true" data-card="${task.id}">
                <button class="task-check" data-card-toggle aria-label="Toggle">${icon('fa-solid fa-check')}</button>
                <div class="grow" style="min-width:0"><div class="task-card-title">${esc(task.title)}</div>
                <div class="tiny dim">${task.due ? fmtDate(task.due) : 'No due date'}${task.recurrence ? ` · ${esc(task.recurrence)}` : ''}${subtasksOf(task.id).length ? ` · ${subtasksOf(task.id).length} subtask${subtasksOf(task.id).length === 1 ? '' : 's'}` : ''}</div></div>
                <span class="prio ${task.priority}">${task.priority[0].toUpperCase()}</span>
              </article>`
            )
            .join('') || `<p class="task-column-empty">Drop a task here</p>`}</div>
        </section>`
      )
      .join('')}</div>`;
    board.querySelectorAll('[data-card]').forEach((card) => {
      const task = tasks.find((item) => String(item.id) === card.dataset.card);
      card.addEventListener('dragstart', () => {
        dragged = task;
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        dragged = null;
        card.classList.remove('dragging');
      });
      card.querySelector('[data-card-toggle]').addEventListener('click', async (event) => {
        event.stopPropagation();
        await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } });
        load();
      });
      card.addEventListener('dblclick', () => edit(task));
    });
    board.querySelectorAll('[data-list]').forEach((column) => {
      column.addEventListener('dragover', (event) => {
        if (!dragged) return;
        event.preventDefault();
        column.classList.add('drop-target');
      });
      column.addEventListener('dragleave', () => column.classList.remove('drop-target'));
      column.addEventListener('drop', async (event) => {
        event.preventDefault();
        column.classList.remove('drop-target');
        if (!dragged) return;
        const list = column.dataset.list;
        try {
          await api(`/api/tasks/${dragged.id}`, { method: 'PATCH', body: list === 'Done' ? { done: true } : { done: false, list } });
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  function addSubtask(task) {
    openModal({
      title: 'Add subtask',
      sub: task.title,
      body: `<div class="field"><label class="label">Subtask</label><input class="input" id="sub-title" placeholder="Next step" /></div>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Add',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const title = dialog.querySelector('#sub-title').value.trim();
            if (!title) return false;
            await api('/api/tasks', { method: 'POST', body: { title, parentId: task.id, list: task.list, priority: task.priority } });
            toast('Subtask added');
            load();
          }
        }
      ]
    });
  }

  function edit(task) {
    openModal({
      title: 'Edit task',
      body: `<form id="edit-form" class="stack-3">
        <div class="field"><label class="label">Title</label><input class="input" name="title" value="${esc(task.title)}" required /></div>
        <div class="field"><label class="label">Notes</label><textarea class="textarea" name="notes" rows="3">${esc(task.notes || '')}</textarea></div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Due</label><input class="input" type="date" name="due" value="${esc(task.due || '')}" /></div>
          <div class="field grow"><label class="label">Priority</label>
            <select class="select" name="priority">
              ${['low', 'normal', 'high'].map((p) => `<option ${task.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field"><label class="label">List</label><input class="input" name="list" value="${esc(task.list)}" /></div>
        <div class="field-row">
          <div class="field"><label class="label">Repeats</label><select class="select" name="recurrence">
            <option value="">Never</option>
            <option value="daily" ${task.recurrence === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="weekly" ${task.recurrence === 'weekly' ? 'selected' : ''}>Weekly</option>
            <option value="monthly" ${task.recurrence === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select></div>
          <div class="field"><label class="label">Tags</label><input class="input" name="tags" value="${esc(task.tags || '')}" placeholder="home, errand" /></div>
        </div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const data = new FormData(dialog.querySelector('#edit-form'));
            await api(`/api/tasks/${task.id}`, {
              method: 'PATCH',
              body: {
                title: data.get('title'),
                notes: data.get('notes'),
                due: data.get('due') || null,
                priority: data.get('priority'),
                list: data.get('list'),
                recurrence: data.get('recurrence'),
                tags: data.get('tags')
              }
            });
            toast('Task saved');
            load();
          }
        }
      ]
    });
  }

  load();
}
