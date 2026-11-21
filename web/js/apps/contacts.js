import { api, confirmDialog, esc, fmtDate, hueFor, icon, initials, openModal, toast } from '../core.js';

export default function mount(root, ctx) {
  let contacts = [];
  let selected = null;
  let query = '';

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Contacts</h1>
        <p class="page-sub" id="contact-sub">People on your server and in your address book.</p>
      </div>
      <div class="page-actions">
        <button class="btn primary sm" id="new-contact">${icon('fa-solid fa-plus')} New contact</button>
      </div>
    </header>

    <div class="contact-layout">
      <div class="stack-3">
        <div class="input-group">
          ${icon('fa-solid fa-magnifying-glass')}
          <input id="contact-search" placeholder="Search people" aria-label="Search contacts" />
        </div>
        <div class="contact-list" id="list"></div>
      </div>
      <div id="detail"></div>
    </div>
  </div>`;

  const list = root.querySelector('#list');
  const detail = root.querySelector('#detail');
  const search = root.querySelector('#contact-search');

  async function load() {
    try {
      const data = await api('/api/contacts');
      contacts = data.contacts;
    } catch (err) {
      toast(err.message, 'error');
    }
    root.querySelector('#contact-sub').textContent = `${contacts.length} contact${contacts.length === 1 ? '' : 's'} in your address book`;
    if (selected) selected = contacts.find((item) => item.id === selected.id) || null;
    renderList();
    renderDetail();
  }

  function renderList() {
    const needle = query.toLowerCase();
    const visible = contacts.filter(
      (contact) =>
        !needle ||
        contact.name.toLowerCase().includes(needle) ||
        contact.email.toLowerCase().includes(needle) ||
        contact.organization.toLowerCase().includes(needle)
    );
    list.innerHTML = visible.length
      ? visible
          .map(
            (contact) => `<button class="contact-card ${selected?.id === contact.id ? 'active' : ''}" data-id="${contact.id}">
              <span class="contact-avatar" style="--hue:${hueFor(contact.name)}">${esc(initials(contact.name))}</span>
              <span class="grow" style="min-width:0">
                <span class="contact-name truncate" style="display:block">${esc(contact.name)}</span>
                <span class="contact-meta truncate" style="display:block">${esc(
                  contact.organization || contact.email || 'No details yet'
                )}</span>
              </span>
              ${icon('fa-solid fa-chevron-right', 'color:var(--text-3);font-size:10px')}
            </button>`
          )
          .join('')
      : `<div class="empty card">${icon('fa-regular fa-address-book')}<p>${
          query ? 'No one matches that search.' : 'No contacts yet. Add the people you work with.'
        }</p></div>`;
    list.querySelectorAll('[data-id]').forEach((node) => {
      node.addEventListener('click', () => {
        selected = contacts.find((contact) => String(contact.id) === node.dataset.id) || null;
        renderList();
        renderDetail();
      });
    });
  }

  function renderDetail() {
    if (!selected) {
      detail.innerHTML = `<div class="widget" style="min-height:320px;display:grid;place-content:center;text-align:center">
        <div class="empty" style="padding:0">${icon('fa-regular fa-address-book')}<p>Select a contact to see their details.</p></div>
      </div>`;
      return;
    }
    const contact = selected;
    detail.innerHTML = `<div class="widget">
      <div class="row" style="gap:14px">
        <span class="contact-avatar" style="--hue:${hueFor(contact.name)};width:48px;height:48px;font-size:15px;border-radius:14px">${esc(
          initials(contact.name)
        )}</span>
        <div class="grow">
          <h2 style="font-size:18px">${esc(contact.name)}</h2>
          <p class="tiny dim">${esc(contact.jobTitle ? `${contact.jobTitle}${contact.organization ? ' · ' : ''}` : '')}${esc(
            contact.organization
          )}</p>
        </div>
        <button class="btn ghost icon sm" id="edit-contact" aria-label="Edit">${icon('fa-solid fa-pen')}</button>
        <button class="btn ghost icon sm" id="delete-contact" aria-label="Delete">${icon('fa-solid fa-trash-can')}</button>
      </div>
      <div class="kv-list" style="margin-top:6px">
        <div class="kv"><span class="k">Email</span><span class="v">${
          contact.email ? `<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>` : '—'
        }</span></div>
        <div class="kv"><span class="k">Phone</span><span class="v">${contact.phone ? `<a href="tel:${esc(contact.phone)}">${esc(contact.phone)}</a>` : '—'}</span></div>
        <div class="kv"><span class="k">Organisation</span><span class="v">${esc(contact.organization || '—')}</span></div>
        <div class="kv"><span class="k">Job title</span><span class="v">${esc(contact.jobTitle || '—')}</span></div>
      </div>
      ${contact.notes ? `<p class="small muted" style="white-space:pre-wrap">${esc(contact.notes)}</p>` : ''}
      <div class="row" style="gap:8px;margin-top:4px">
        ${contact.email ? `<a class="btn sm" href="mailto:${esc(contact.email)}">${icon('fa-regular fa-envelope')} Write</a>` : ''}
        ${contact.email ? `<button class="btn sm quiet" data-copy="${esc(contact.email)}">${icon('fa-regular fa-copy')} Copy email</button>` : ''}
      </div>
    </div>`;
    detail.querySelector('#edit-contact').addEventListener('click', () => form(contact));
    detail.querySelector('#delete-contact').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete contact?', message: `${contact.name} will be removed from your address book.` });
      if (!ok) return;
      await api(`/api/contacts/${contact.id}`, { method: 'DELETE' });
      selected = null;
      toast('Contact deleted');
      load();
    });
    detail.querySelector('[data-copy]')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(contact.email);
      toast('Email copied');
    });
  }

  function form(existing = null) {
    openModal({
      title: existing ? 'Edit contact' : 'New contact',
      wide: true,
      body: `<form id="contact-form" class="stack-3">
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">First name</label><input class="input" name="firstName" required value="${esc(
            existing?.firstName || ''
          )}" /></div>
          <div class="field grow"><label class="label">Last name</label><input class="input" name="lastName" value="${esc(
            existing?.lastName || ''
          )}" /></div>
        </div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Email</label><input class="input" type="email" name="email" value="${esc(
            existing?.email || ''
          )}" /></div>
          <div class="field grow"><label class="label">Phone</label><input class="input" name="phone" value="${esc(
            existing?.phone || ''
          )}" /></div>
        </div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label class="label">Organisation</label><input class="input" name="organization" value="${esc(
            existing?.organization || ''
          )}" /></div>
          <div class="field grow"><label class="label">Job title</label><input class="input" name="jobTitle" value="${esc(
            existing?.jobTitle || ''
          )}" /></div>
        </div>
        <div class="field"><label class="label">Notes</label><textarea class="textarea" name="notes" rows="3">${esc(
          existing?.notes || ''
        )}</textarea></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: existing ? 'Save contact' : 'Add contact',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const data = new FormData(dialog.querySelector('#contact-form'));
            const payload = Object.fromEntries(data.entries());
            if (!payload.firstName?.trim()) return false;
            if (existing) await api(`/api/contacts/${existing.id}`, { method: 'PATCH', body: payload });
            else await api('/api/contacts', { method: 'POST', body: payload });
            toast(existing ? 'Contact saved' : 'Contact added');
            await load();
            if (!existing) selected = contacts[contacts.length - 1] || null;
            renderList();
            renderDetail();
          }
        }
      ]
    });
  }

  root.querySelector('#new-contact').addEventListener('click', () => form());
  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });

  load();
}
