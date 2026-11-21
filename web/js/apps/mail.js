import { api, esc, fmtDate, fmtTime, icon, openModal, timeAgo, toast } from '../core.js';

export default function mount(root, ctx) {
  let data = null;
  let view = 'inbox';
  let inbox = null;
  let inboxError = '';
  let inboxLoading = false;
  let drafts = [];

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Mail</h1>
        <p class="page-sub" id="mail-sub">Connect your own SMTP and IMAP servers.</p>
      </div>
      <div class="page-actions">
        <button class="btn quiet sm" id="mail-settings">${icon('fa-solid fa-sliders')} Server settings</button>
        <button class="btn primary sm" id="compose">${icon('fa-solid fa-pen')} Compose</button>
      </div>
    </header>

    <div class="mail-shell">
      <aside>
        <div class="mail-nav" id="mail-nav">
          <button data-view="inbox" aria-current="true">${icon('fa-regular fa-inbox')} Inbox</button>
          <button data-view="sent">${icon('fa-regular fa-paper-plane')} Sent</button>
          <button data-view="drafts">${icon('fa-regular fa-file-lines')} Drafts</button>
          <button data-view="settings">${icon('fa-solid fa-sliders')} Settings</button>
        </div>
        <div class="widget" style="margin-top:14px;gap:8px" id="mail-status"></div>
      </aside>
      <section class="mail-pane" id="mail-pane">
        <div class="skeleton" style="height:200px;margin:16px"></div>
      </section>
    </div>
  </div>`;

  const pane = root.querySelector('#mail-pane');
  const status = root.querySelector('#mail-status');

  async function load() {
    try {
      data = await api('/api/mail');
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    root.querySelector('#mail-sub').textContent = data.configured
      ? `${data.smtp.user || data.smtp.from} via ${data.smtp.host}`
      : 'Connect your own SMTP and IMAP servers.';
    status.innerHTML = `<div class="widget-head"><span class="widget-title">${icon('fa-solid fa-plug')} Connection</span></div>
      <div class="kv"><span class="k">SMTP</span><span class="v">${data.configured ? 'Connected' : 'Not set'}</span></div>
      <div class="kv"><span class="k">IMAP</span><span class="v">${data.imapConfigured ? 'Connected' : 'Not set'}</span></div>
      <p class="hint">Credentials are stored on this server and never sent to the browser.</p>`;
    render();
  }

  root.querySelector('#mail-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    switchView(button.dataset.view);
  });

  function switchView(next) {
    view = next;
    root.querySelectorAll('[data-view]').forEach((node) => node.setAttribute('aria-current', node.dataset.view === view ? 'true' : 'false'));
    render();
    if (view === 'inbox') fetchInbox();
    if (view === 'drafts') loadDrafts();
  }

  function render() {
    if (!data) return;
    if (!data.configured && view !== 'settings') {
      pane.innerHTML = `<div class="empty" style="padding:64px 24px">${icon(
        'fa-regular fa-envelope-open'
      )}<p>Connect an SMTP server to start sending mail.</p><p class="hint">CoolCloud never proxies your mail through a third party.</p><button class="btn primary sm" id="go-settings">Open mail settings</button></div>`;
      pane.querySelector('#go-settings').addEventListener('click', () => switchView('settings'));
      return;
    }
    if (view === 'settings') return renderSettings();
    if (view === 'sent') return renderSent();
    if (view === 'drafts') return renderDrafts();
    return renderInbox();
  }

  async function loadDrafts() {
    try {
      const result = await api('/api/mail/drafts');
      drafts = result.drafts || [];
    } catch (err) {
      toast(err.message, 'error');
      drafts = [];
    }
    if (view === 'drafts') renderDrafts();
  }

  function renderDrafts() {
    pane.innerHTML = `<div class="mail-toolbar"><span class="strong small">Drafts</span><span class="grow"></span><button class="btn ghost icon sm" id="refresh-drafts" title="Refresh">${icon('fa-solid fa-rotate')}</button></div>
      <div class="mail-list">${drafts.length
        ? drafts
            .map(
              (draft) => `<div class="mail-item draft-row"><button class="mail-item-main" data-draft="${draft.id}"><span class="mail-from truncate">${esc(draft.to || 'No recipient')}</span>
                <span class="mail-subject">${esc(draft.subject || '(no subject)')}</span><span class="mail-date">${timeAgo(draft.updatedAt)}</span></button>
                <button class="btn ghost icon sm" data-draft-delete="${draft.id}" aria-label="Delete draft">${icon('fa-solid fa-trash-can')}</button></div>`
            )
            .join('')
        : `<div class="empty">${icon('fa-regular fa-file-lines')}<p>No drafts. Compose a message and save it for later.</p></div>`}</div>`;
    pane.querySelector('#refresh-drafts').addEventListener('click', loadDrafts);
    pane.querySelectorAll('[data-draft]').forEach((node) => {
      node.addEventListener('click', () => {
        const draft = drafts.find((item) => String(item.id) === node.dataset.draft);
        if (draft) compose(draft);
      });
    });
    pane.querySelectorAll('[data-draft-delete]').forEach((node) => {
      node.addEventListener('click', async () => {
        await api(`/api/mail/drafts/${node.dataset.draftDelete}`, { method: 'DELETE' });
        toast('Draft deleted');
        loadDrafts();
      });
    });
  }

  function renderSettings() {
    const smtp = data.smtp;
    const imap = data.imap;
    pane.innerHTML = `<form id="mail-form" class="compose-grid" style="gap:14px;padding:20px">
      <div>
        <h2 style="font-size:16px">Outgoing mail (SMTP)</h2>
        <p class="hint">Anything that speaks SMTP works: your provider, your own mail server, or a relay.</p>
      </div>
      <div class="row" style="gap:10px">
        <div class="field grow"><label class="label">SMTP host</label><input class="input" name="smtpHost" value="${esc(smtp.host)}" placeholder="smtp.example.com" /></div>
        <div class="field" style="width:110px"><label class="label">Port</label><input class="input" name="smtpPort" value="${esc(smtp.port || 587)}" /></div>
      </div>
      <div class="row" style="gap:10px">
        <div class="field grow"><label class="label">Username</label><input class="input" name="smtpUser" value="${esc(smtp.user)}" autocomplete="off" /></div>
        <div class="field grow"><label class="label">Password</label><input class="input" type="password" name="smtpPass" placeholder="${smtp.hasPassword ? 'Saved — leave blank to keep' : ''}" autocomplete="new-password" /></div>
      </div>
      <div class="row" style="gap:10px">
        <div class="field grow"><label class="label">From address</label><input class="input" name="smtpFrom" value="${esc(smtp.from)}" placeholder="you@example.com" /></div>
        <label class="check" style="align-self:flex-end;padding-bottom:9px"><input type="checkbox" name="smtpSecure" ${
          smtp.secure ? 'checked' : ''
        } /> Implicit TLS (465)</label>
      </div>
      <hr />
      <div>
        <h2 style="font-size:16px">Incoming mail (IMAP)</h2>
        <p class="hint">Optional. Read your inbox inside CoolCloud.</p>
      </div>
      <div class="row" style="gap:10px">
        <div class="field grow"><label class="label">IMAP host</label><input class="input" name="imapHost" value="${esc(imap.host)}" placeholder="imap.example.com" /></div>
        <div class="field" style="width:110px"><label class="label">Port</label><input class="input" name="imapPort" value="${esc(imap.port || 993)}" /></div>
      </div>
      <div class="row" style="gap:10px">
        <div class="field grow"><label class="label">Username</label><input class="input" name="imapUser" value="${esc(imap.user)}" autocomplete="off" /></div>
        <div class="field grow"><label class="label">Password</label><input class="input" type="password" name="imapPass" placeholder="${
          imap.hasPassword ? 'Saved — leave blank to keep' : ''
        }" autocomplete="new-password" /></div>
      </div>
      <label class="check"><input type="checkbox" name="imapSecure" ${imap.secure === false ? '' : 'checked'} /> Implicit TLS (993)</label>
      <div class="row" style="justify-content:flex-end;gap:8px">
        <button class="btn primary" type="submit">${icon('fa-solid fa-floppy-disk')} Save settings</button>
      </div>
    </form>`;
    pane.querySelector('#mail-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const payload = {
        smtp: {
          host: form.smtpHost.value,
          port: Number(form.smtpPort.value || 587),
          user: form.smtpUser.value,
          pass: form.smtpPass.value,
          from: form.smtpFrom.value,
          secure: form.smtpSecure.checked
        },
        imap: {
          host: form.imapHost.value,
          port: Number(form.imapPort.value || 993),
          user: form.imapUser.value,
          pass: form.imapPass.value,
          secure: form.imapSecure.checked
        }
      };
      try {
        await api('/api/mail', { method: 'PUT', body: payload });
        toast('Mail settings saved');
        await load();
        switchView('inbox');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function renderSent() {
    pane.innerHTML = `<div class="mail-toolbar">
        <span class="strong small">Sent</span>
        <span class="grow"></span>
        <button class="btn ghost icon sm" id="refresh-sent" title="Refresh">${icon('fa-solid fa-rotate')}</button>
      </div>
      <div class="mail-list" id="sent-list"></div>`;
    const list = pane.querySelector('#sent-list');
    if (!data.sent.length) {
      list.innerHTML = `<div class="empty">${icon('fa-regular fa-paper-plane')}<p>Nothing sent from CoolCloud yet.</p></div>`;
    } else {
      list.innerHTML = data.sent
        .map(
          (item) => `<div class="mail-item">
            <span class="mail-from">To ${esc(item.to)}</span>
            <span class="mail-subject">${esc(item.subject)} ${item.status === 'failed' ? '<span class="badge danger">Failed</span>' : ''}</span>
            <span class="mail-date">${timeAgo(item.sentAt)}</span>
          </div>`
        )
        .join('');
    }
    pane.querySelector('#refresh-sent').addEventListener('click', load);
  }

  function renderInbox() {
    pane.innerHTML = `<div class="mail-toolbar">
        <span class="strong small">Inbox</span>
        <span class="grow"></span>
        <button class="btn ghost icon sm" id="refresh-inbox" title="Refresh">${icon('fa-solid fa-rotate')}</button>
      </div>
      <div id="inbox-body">${
        inboxLoading
          ? `<div class="empty"><span class="spinner"></span><p>Asking your IMAP server…</p></div>`
          : ''
      }</div>`;
    pane.querySelector('#refresh-inbox').addEventListener('click', fetchInbox);

    const body = pane.querySelector('#inbox-body');
    if (inboxLoading) return;
    if (!data.imapConfigured) {
      body.innerHTML = `<div class="empty">${icon('fa-regular fa-inbox')}<p>IMAP is not configured yet.</p><button class="btn sm" id="add-imap">Add IMAP settings</button></div>`;
      body.querySelector('#add-imap').addEventListener('click', () => switchView('settings'));
      return;
    }
    if (inboxError) {
      body.innerHTML = `<div class="empty">${icon('fa-solid fa-triangle-exclamation')}<p>${esc(inboxError)}</p><button class="btn sm" id="retry-inbox">Try again</button></div>`;
      body.querySelector('#retry-inbox').addEventListener('click', fetchInbox);
      return;
    }
    if (!inbox) {
      fetchInbox();
      return;
    }
    if (!inbox.length) {
      body.innerHTML = `<div class="empty">${icon('fa-regular fa-inbox')}<p>Your inbox is empty.</p></div>`;
      return;
    }
    const groups = [];
    for (const message of inbox) {
      const key = String(message.subject || '').replace(/^((re|fwd?):\s*)+/i, '').trim().toLowerCase();
      let group = groups.find((item) => item.key === key);
      if (!group) {
        group = { key, subject: message.subject, messages: [] };
        groups.push(group);
      }
      group.messages.push(message);
    }
    body.innerHTML = `<div class="mail-list">${groups
      .map((group, index) => {
        const latest = group.messages[0];
        const unread = group.messages.some((message) => !message.seen);
        return `<button class="mail-item ${unread ? 'unread' : ''}" data-thread="${index}">
          <span class="mail-from truncate">${esc(latest.from || 'Unknown sender')}${group.messages.length > 1 ? ` <span class="badge">${group.messages.length}</span>` : ''}</span>
          <span class="mail-subject">${esc(group.subject || '(no subject)')}</span>
          <span class="mail-date">${latest.date ? fmtDate(latest.date) : ''}</span>
        </button>`;
      })
      .join('')}</div>`;
    body.querySelectorAll('[data-thread]').forEach((node) => {
      node.addEventListener('click', () => openThread(groups[Number(node.dataset.thread)]));
    });
  }

  function openThread(group) {
    if (group.messages.length === 1) return openMessage(group.messages[0]);
    openModal({
      title: group.subject || '(no subject)',
      sub: `${group.messages.length} messages in this conversation`,
      wide: true,
      body: `<div class="stack-2">${group.messages
        .map(
          (message, index) => `<button class="version-row thread-row" data-thread-msg="${index}"><span class="file-ico">${icon('fa-regular fa-envelope')}</span>
            <span class="grow" style="min-width:0"><span class="strong small">${esc(message.from || 'Unknown sender')}</span>
            <span class="tiny dim" style="display:block">${esc(message.subject)} · ${message.date ? fmtDate(message.date, { time: true }) : ''}</span></span>
            <span class="badge ${message.seen ? '' : 'accent'}">${message.seen ? 'Read' : 'New'}</span></button>`
        )
        .join('')}</div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        dialog.querySelectorAll('[data-thread-msg]').forEach((node) => {
          node.addEventListener('click', () => {
            dialog.closest('.modal-backdrop')?.remove();
            openMessage(group.messages[Number(node.dataset.threadMsg)]);
          });
        });
      }
    });
  }

  async function fetchInbox() {
    if (!data?.imapConfigured) return;
    inboxLoading = true;
    inboxError = '';
    renderInbox();
    try {
      const result = await api('/api/mail/inbox?limit=25');
      inbox = result.messages || [];
    } catch (err) {
      inboxError = err.message;
    }
    inboxLoading = false;
    if (view === 'inbox') renderInbox();
  }

  async function openMessage(message) {
    openModal({
      title: message.subject,
      sub: `${message.from} · ${message.date ? fmtDate(message.date, { time: true }) : ''}`,
      wide: true,
      body: `<div class="mail-body" id="message-body"><span class="spinner"></span></div>`,
      actions: [
        {
          label: 'Reply',
          kind: 'ghost',
          onClick: ({ close }) => {
            close();
            compose({ to: extractAddress(message.from), subject: `Re: ${message.subject}` });
            return false;
          }
        },
        { label: 'Close', kind: 'primary' }
      ],
      onMount: async (dialog) => {
        const box = dialog.querySelector('#message-body');
        try {
          const body = await api(`/api/mail/message?uid=${message.uid}`);
          box.textContent = body.text || 'This message has no readable text body.';
        } catch (err) {
          box.textContent = `Could not load the message: ${err.message}`;
        }
      }
    });
  }

  function extractAddress(from) {
    const match = /<([^>]+)>/.exec(from || '');
    return match ? match[1] : from || '';
  }

  function compose(prefill = {}) {
    let draftId = prefill.id || prefill.draftId || null;
    const attachments = [];
    openModal({
      title: prefill.id ? 'Edit draft' : 'New message',
      wide: true,
      body: `<form id="compose-form" class="stack-3">
        <div class="field"><label class="label">To</label><input class="input" name="to" placeholder="name@example.com" value="${esc(prefill.to || '')}" required /></div>
        <div class="field"><label class="label">Cc</label><input class="input" name="cc" placeholder="Optional" value="${esc(prefill.cc || '')}" /></div>
        <div class="field"><label class="label">Subject</label><input class="input" name="subject" value="${esc(prefill.subject || '')}" /></div>
        <div class="field"><label class="label">Message</label><textarea class="textarea" name="text" rows="10" placeholder="Write something…">${esc(
          prefill.text || prefill.body || ''
        )}</textarea></div>
        <div class="field"><label class="label">Attachments</label>
          <div class="compose-attachments" id="compose-attachments"><span class="hint">Up to 5 files, 4 MB each.</span></div>
          <input type="file" id="compose-files" multiple hidden />
          <button type="button" class="btn quiet sm" id="compose-attach">${icon('fa-solid fa-paperclip')} Attach files</button>
        </div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save draft',
          kind: 'quiet',
          onClick: async ({ dialog }) => {
            const form = dialog.querySelector('#compose-form');
            const data = new FormData(form);
            try {
              const result = await api('/api/mail/drafts', {
                method: 'POST',
                body: { id: draftId, to: data.get('to'), cc: data.get('cc'), subject: data.get('subject'), text: data.get('text') }
              });
              draftId = result.id;
              toast('Draft saved');
            } catch (err) {
              toast(err.message, 'error');
            }
            return false;
          }
        },
        {
          label: 'Send message',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const form = dialog.querySelector('#compose-form');
            const data = new FormData(form);
            const button = dialog.querySelector('.btn.primary');
            button.disabled = true;
            button.innerHTML = '<span class="spinner"></span> Sending';
            try {
              await api('/api/mail/send', {
                method: 'POST',
                body: {
                  to: data.get('to'),
                  cc: data.get('cc'),
                  subject: data.get('subject'),
                  text: data.get('text'),
                  draftId,
                  attachments
                }
              });
              toast('Message sent');
              await load();
              switchView('sent');
            } catch (err) {
              toast(err.message, 'error');
              button.disabled = false;
              button.textContent = 'Send message';
              return false;
            }
          }
        }
      ]
      ,
      onMount: (dialog) => {
        const list = dialog.querySelector('#compose-attachments');
        const paint = () => {
          list.innerHTML = attachments.length
            ? attachments.map((file, index) => `<span class="attachment-chip">${icon('fa-solid fa-paperclip')} ${esc(file.name)} <button type="button" data-attach-remove="${index}" aria-label="Remove">${icon('fa-solid fa-xmark')}</button></span>`).join('')
            : '<span class="hint">Up to 5 files, 4 MB each.</span>';
          list.querySelectorAll('[data-attach-remove]').forEach((node) => {
            node.addEventListener('click', () => {
              attachments.splice(Number(node.dataset.attachRemove), 1);
              paint();
            });
          });
        };
        dialog.querySelector('#compose-attach').addEventListener('click', () => dialog.querySelector('#compose-files').click());
        dialog.querySelector('#compose-files').addEventListener('change', async (event) => {
          for (const file of [...(event.target.files || [])]) {
            if (attachments.length >= 5) return toast('Up to 5 attachments', 'error');
            if (file.size > 4 * 1024 * 1024) return toast(`${file.name} is over 4 MB`, 'error');
            if (attachments.reduce((sum, item) => sum + item.data.length, 0) + file.size * 1.4 > 8 * 1024 * 1024) {
              return toast('Attachments are capped at 8 MB total', 'error');
            }
            attachments.push({ name: file.name, type: file.type || 'application/octet-stream', data: await fileToBase64(file) });
          }
          event.target.value = '';
          paint();
        });
        paint();
      }
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^;]+;base64,/, ''));
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  root.querySelector('#compose').addEventListener('click', () => compose());
  root.querySelector('#mail-settings').addEventListener('click', () => switchView('settings'));

  load().then(() => {
    if (!data.configured) switchView('settings');
    else {
      switchView('inbox');
      fetchInbox();
    }
  });
}
