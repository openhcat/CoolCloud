import { api, esc, icon, initials, openModal, toast } from '../core.js';
import { openActivity, openTab } from '../shell.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isDm(room) {
  return /^dm-\d+-\d+$/.test(room);
}

function dmRoom(a, b) {
  const [low, high] = [Number(a), Number(b)].sort((x, y) => x - y);
  return `dm-${low}-${high}`;
}

function dmPeer(room, meId) {
  const match = /^dm-(\d+)-(\d+)$/.exec(room);
  if (!match) return null;
  const ids = [Number(match[1]), Number(match[2])];
  return ids.find((id) => id !== Number(meId)) ?? ids[0];
}

function toB64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function fromB64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveKey(passphrase, room) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(`coolcloud:${room}`), iterations: 120000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
  return JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(cipher) });
}

async function decryptText(key, payload) {
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || parsed.v !== 1) return { text: payload, encrypted: false };
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(parsed.iv) },
      key,
      fromB64(parsed.data)
    );
    return { text: decoder.decode(plain), encrypted: true };
  } catch {
    return { text: null, encrypted: true };
  }
}

function dayLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function clock(value) {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function mount(root, ctx) {
  const me = ctx.user;
  let socket = null;
  let activeRoom = ctx.params.get('room') || 'general';
  let rooms = [];
  let people = [];
  let members = [];
  let messages = [];
  let query = '';
  let keys = {};
  let passphrases = {};
  let typingTimers = new Map();

  let disposed = false;
  let peer = null;
  let localStream = null;
  let callTimer = null;
  let meterFrame = null;
  let audioContext = null;

  try {
    passphrases = JSON.parse(localStorage.getItem('cc:connect:passphrases') || '{}');
  } catch {
    passphrases = {};
  }

  root.innerHTML = `<div class="cn">
    <nav class="cn-rail" aria-label="Workspace">
      <button class="cn-rail-btn" data-rail="chat" aria-current="true" title="Connect">${icon(
        'fa-solid fa-comment-dots'
      )}</button>
      <button class="cn-rail-btn" data-rail="activity" title="Activity">${icon('fa-regular fa-bell')}</button>
      <button class="cn-rail-btn" data-rail="invite" title="Invite people">${icon('fa-solid fa-user-plus')}</button>
      <div class="cn-rail-sep"></div>
      <div id="rail-people" class="stack-1" style="display:grid;gap:5px;width:100%;justify-items:center"></div>
      <div class="cn-rail-spacer"></div>
      <button class="cn-rail-btn" data-rail="app-drawer" title="All apps">${icon('fa-solid fa-grip')}</button>
      <button class="cn-rail-btn" data-rail="me" title="${esc(me.name || me.username)}">${icon(
        'fa-regular fa-circle-user'
      )}</button>
    </nav>

    <aside class="cn-side">
      <div class="cn-side-head">
        <button class="cn-ws" id="ws" title="Workspace">
          <span class="cn-ws-name">${esc(ctx.server?.name || 'CoolCloud')}</span>
          ${icon('fa-solid fa-chevron-down')}
        </button>
        <button class="icon-btn" data-open-activity title="Activity">${icon('fa-regular fa-bell')}</button>
        <button class="icon-btn" id="side-invite" title="Invite people">${icon('fa-solid fa-pen-to-square')}</button>
      </div>
      <div class="cn-search">
        <div class="input-group">
          ${icon('fa-solid fa-magnifying-glass')}
          <input id="cn-filter" placeholder="Search" aria-label="Filter conversations" autocomplete="off" />
        </div>
      </div>
      <div class="cn-scroll" id="cn-side-list"></div>
      <div class="cn-side-foot">
        <button class="cn-me" data-rail="me">
          <span class="avatar">${esc(initials(me.name || me.username))}</span>
          <span class="grow" style="min-width:0">
            <span class="cn-me-name truncate" style="display:block">${esc(me.name || me.username)}</span>
            <span class="cn-me-sub truncate" style="display:block">${
              members.length ? `${members.length} in this conversation` : 'Available'
            }</span>
          </span>
          <span class="dot on"></span>
        </button>
      </div>
    </aside>

    <section class="cn-main">
      <header class="cn-head">
        <div style="min-width:0">
          <div class="cn-head-title"><span id="room-name">…</span></div>
          <div class="cn-head-sub" id="room-sub"></div>
        </div>
        <div class="cn-topic" id="room-topic"></div>
        <div class="cn-head-actions">
          <button class="icon-btn" data-call="voice" title="Start a voice call">${icon('fa-solid fa-phone')}</button>
          <button class="icon-btn" data-call="video" title="Start a video call">${icon('fa-solid fa-video')}</button>
          <span class="divider-v"></span>
          <button class="btn quiet sm" data-open-invite>${icon('fa-solid fa-user-plus')} Invite</button>
        </div>
      </header>

      <div class="cn-log" id="cn-log"></div>

      <div class="cn-composer">
        <div class="cn-input">
          <textarea id="cn-text" rows="1" placeholder="Message"></textarea>
          <div class="cn-input-bar">
            <span class="cn-lock" id="cn-lock"></span>
            <button class="btn ghost sm" id="cn-key" title="Room key">${icon('fa-solid fa-key')}</button>
            <button class="btn primary sm" id="cn-send">${icon('fa-solid fa-paper-plane')} Send</button>
          </div>
        </div>
        <div class="cn-foot-hint" id="cn-hint">Enter sends · Shift + Enter adds a line</div>
      </div>
    </section>
  </div>`;

  const log = root.querySelector('#cn-log');
  const textarea = root.querySelector('#cn-text');

  /* ------------------------------- rendering ------------------------------ */

  function peerOf(room) {
    return isDm(room) ? people.find((person) => person.id === Number(dmPeer(room, me.id))) || null : null;
  }

  function roomLabel(room) {
    if (isDm(room)) return peerOf(room)?.name || 'Direct message';
    return room;
  }

  function onlineIds() {
    return new Set(members.map((member) => Number(member.id)));
  }

  function renderSide() {
    const list = root.querySelector('#cn-side-list');
    if (!list) return;
    const online = onlineIds();
    const needle = query.trim().toLowerCase();
    const channelList = [...new Set([...rooms.filter((room) => !isDm(room.room ?? room)).map((room) => room.room ?? room), 'general'])]
      .filter((room) => !needle || room.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b));
    const dms = people.filter(
      (person) =>
        !needle ||
        person.name.toLowerCase().includes(needle) ||
        person.username.toLowerCase().includes(needle)
    );

    list.innerHTML = `
      <div class="cn-group"><span>Channels</span><button data-new-channel title="New channel">${icon(
        'fa-solid fa-plus'
      )}</button></div>
      ${channelList
        .map(
          (room) => `<button class="cn-row ${room === activeRoom ? 'active' : ''}" data-room="${esc(room)}">
            ${icon('fa-solid fa-hashtag')}<span class="grow">${esc(room)}</span>
            ${passphrases[room] ? icon('fa-solid fa-lock', 'font-size:9px') : ''}
          </button>`
        )
        .join('')}
      <div class="cn-group"><span>Direct messages</span></div>
      ${
        dms.length
          ? dms
              .map((person) => {
                const room = dmRoom(me.id, person.id);
                return `<button class="cn-row ${room === activeRoom ? 'active' : ''}" data-dm="${person.id}">
                  <span class="avatar sm">${esc(initials(person.name))}</span>
                  <span class="grow">${esc(person.name)}</span>
                  <span class="presence ${online.has(Number(person.id)) ? 'on' : ''}"></span>
                </button>`;
              })
              .join('')
          : '<p class="hint" style="padding:4px 8px">No other members yet.</p>'
      }
      <div class="cn-group"><span>Calls</span></div>
      <button class="cn-row" data-solo>
        ${icon('fa-solid fa-phone')}<span class="grow">Call yourself</span>
        <span class="badge neutral">Test</span>
      </button>
      <button class="cn-row" data-open-activity>
        ${icon('fa-regular fa-bell')}<span class="grow">Activity</span>
      </button>
    `;

    root.querySelectorAll('[data-room]').forEach((node) => {
      node.addEventListener('click', () => selectRoom(node.dataset.room));
    });
    root.querySelectorAll('[data-dm]').forEach((node) => {
      node.addEventListener('click', () => selectRoom(dmRoom(me.id, node.dataset.dm)));
    });
    root.querySelectorAll('[data-new-channel]').forEach((node) => {
      node.addEventListener('click', createChannel);
    });
    root.querySelectorAll('[data-solo]').forEach((node) => {
      node.addEventListener('click', () => startSoloCall(true));
    });
    root.querySelectorAll('[data-open-activity]').forEach((node) => {
      node.addEventListener('click', () => openActivity());
    });

    root.querySelector('#rail-people').innerHTML = people
      .slice(0, 5)
      .map(
        (person) => `<button class="cn-rail-ava" data-rail-dm="${person.id}" title="${esc(person.name)}">
          ${esc(initials(person.name))}
          <span class="presence ${online.has(Number(person.id)) ? 'on' : ''}"></span>
        </button>`
      )
      .join('');
    root.querySelectorAll('[data-rail-dm]').forEach((node) => {
      node.addEventListener('click', () => selectRoom(dmRoom(me.id, node.dataset.railDm)));
    });
    markRail();
  }

  function markRail() {
    const dmActive = isDm(activeRoom) ? Number(dmPeer(activeRoom, me.id)) : null;
    root.querySelectorAll('[data-rail-dm]').forEach((node) => {
      node.setAttribute('aria-current', String(Number(node.dataset.railDm) === dmActive));
    });
  }

  function renderHead() {
    if (!root.querySelector('#room-name')) return;
    const direct = isDm(activeRoom);
    const peerPerson = peerOf(activeRoom);
    root.querySelector('#room-name').innerHTML = direct
      ? `<span class="avatar sm">${esc(initials(peerPerson?.name || '?'))}</span> ${esc(
          peerPerson?.name || 'Direct message'
        )}`
      : `${icon('fa-solid fa-hashtag')} ${esc(activeRoom)}`;
    const others = members.filter((member) => Number(member.id) !== Number(me.id));
    root.querySelector('#room-sub').textContent = direct
      ? peerPerson
        ? `@${peerPerson.username} · direct message`
        : 'Direct message'
      : `${others.length ? `${others.length} other${others.length === 1 ? '' : 's'} here` : 'Just you so far'}`;
    root.querySelector('#room-topic').textContent = direct
      ? 'Direct messages stay between the two of you. Calls are peer to peer.'
      : passphrases[activeRoom]
      ? 'End-to-end encrypted with the room key'
      : 'Add a room key to encrypt messages on your device';

    const lock = root.querySelector('#cn-lock');
    lock.className = `cn-lock ${passphrases[activeRoom] ? 'locked' : ''}`;
    lock.innerHTML = direct
      ? `${icon('fa-solid fa-lock')} Stored on this server`
      : passphrases[activeRoom]
      ? `${icon('fa-solid fa-lock')} Encrypted`
      : `${icon('fa-solid fa-lock-open')} No room key`;
    root.querySelector('#cn-key').classList.toggle('hidden', direct);
    root.querySelector('[data-open-invite]').classList.toggle('hidden', direct);
    textarea.placeholder = direct
      ? `Message ${peerPerson?.name || ''}`.trim()
      : `Message #${activeRoom}`;
  }

  function renderMessages() {
    if (!log.isConnected) return;
    if (!messages.length) {
      log.innerHTML = `<div class="cn-empty">${icon('fa-regular fa-comments')}
        <p>${isDm(activeRoom) ? 'This is the start of your conversation.' : `No messages in #${esc(activeRoom)} yet.`}</p>
        ${
          isDm(activeRoom)
            ? ''
            : `<button class="btn quiet sm" data-open-invite>${icon('fa-solid fa-user-plus')} Invite someone</button>`
        }
      </div>`;
      log.querySelector('[data-open-invite]')?.addEventListener('click', openInvite);
      return;
    }
    let lastDay = '';
    log.innerHTML = messages
      .map((message) => {
        let divider = '';
        const day = dayLabel(message.createdAt);
        if (day !== lastDay) {
          divider = `<div class="cn-day"><span>${esc(day)}</span></div>`;
          lastDay = day;
        }
        if (message.system) {
          return `${divider}<div class="cn-sys">${icon('fa-solid fa-user-plus')}<span>${esc(message.text)}</span></div>`;
        }
        const mine = Number(message.senderId) === Number(me.id);
        return `${divider}<div class="cn-msg" data-msg="${message.id}">
          <span class="cn-msg-ava ${mine ? 'me' : ''}">${esc(initials(message.senderName))}</span>
          <div class="cn-msg-body">
            <div class="cn-msg-head">
              <span class="cn-msg-name">${esc(message.senderName)}${mine ? ' (you)' : ''}</span>
              <span class="cn-msg-time">${esc(clock(message.createdAt))}</span>
            </div>
            <div class="cn-msg-text">${
              message.locked ? '<em>Encrypted — set the room key to read this.</em>' : esc(message.body)
            }</div>
          </div>
          <div class="cn-msg-acts">
            <button class="icon-btn sm" data-copy="${message.id}" title="Copy">${icon('fa-regular fa-copy')}</button>
          </div>
        </div>`;
      })
      .join('');
    log.querySelectorAll('[data-copy]').forEach((node) => {
      node.addEventListener('click', () => {
        const message = messages.find((item) => String(item.id) === node.dataset.copy);
        if (message && !message.locked) navigator.clipboard?.writeText(message.body);
      });
    });
    log.scrollTop = log.scrollHeight;
  }

  /* --------------------------------- data --------------------------------- */

  async function loadLists() {
    try {
      const [roomsData, peopleData] = await Promise.all([api('/api/connect/rooms'), api('/api/connect/people')]);
      rooms = roomsData.rooms || [];
      people = peopleData.people || [];
    } catch (err) {
      toast(err.message, 'error');
    }
    renderSide();
    renderHead();
  }

  async function ensureKey(room, { ask = false } = {}) {
    if (keys[room]) return keys[room];
    if (!passphrases[room]) {
      if (!ask) return null;
      const passphrase = await askPassphrase(room);
      if (!passphrase) return null;
      passphrases[room] = passphrase;
      localStorage.setItem('cc:connect:passphrases', JSON.stringify(passphrases));
    }
    keys[room] = await deriveKey(passphrases[room], room);
    renderHead();
    renderSide();
    return keys[room];
  }

  function askPassphrase(room) {
    return new Promise((resolve) => {
      openModal({
        title: `Room key for #${room}`,
        sub: 'Everyone who wants to read this room needs the same passphrase. It never leaves your device.',
        body: `<div class="field"><label class="label">Passphrase</label><input class="input" id="pass" type="password" autocomplete="new-password" /></div>
          <p class="hint" style="margin-top:8px">Leave empty to send unencrypted messages.</p>`,
        actions: [
          { label: 'Cancel', kind: 'ghost', onClick: () => resolve(null) },
          {
            label: 'Unlock',
            kind: 'primary',
            onClick: ({ dialog }) => resolve(dialog.querySelector('#pass').value)
          }
        ]
      });
    });
  }

  async function hydrate(list) {
    const key = await ensureKey(activeRoom);
    return Promise.all(
      list.map(async (message) => {
        if (Number(message.senderId) === 0 || message.senderName === 'system') {
          return { ...message, system: true, text: message.body, body: '' };
        }
        if (!key) return { ...message, locked: false };
        const result = await decryptText(key, message.body);
        return { ...message, body: result.text ?? '', locked: result.text === null };
      })
    );
  }

  /* ------------------------------- realtime ------------------------------- */

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.addEventListener('open', () => {
      send({ type: 'join', room: activeRoom });
    });
    socket.addEventListener('close', () => {
      if (disposed) return;
      setTimeout(connect, 2400);
    });
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('message', async (event) => {
      if (disposed) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === 'error') {
        toast(payload.error || 'That conversation is not yours', 'error');
        return;
      }
      if (payload.type === 'history') {
        if (payload.room !== activeRoom) return;
        messages = await hydrate(payload.messages || []);
        renderMessages();
        return;
      }
      if (payload.type === 'message') {
        if (payload.room !== activeRoom) return;
        const key = await ensureKey(activeRoom);
        if (Number(payload.senderId) === 0) {
          messages.push({ ...payload, system: true, text: payload.body, body: '' });
          renderMessages();
          return;
        }
        const result = key ? await decryptText(key, payload.body) : { text: payload.body, encrypted: false };
        messages.push({ ...payload, body: result.text ?? '', locked: result.text === null });
        renderMessages();
        if (Number(payload.senderId) !== Number(me.id)) renderSide();
        return;
      }
      if (payload.type === 'presence') {
        if (payload.room === activeRoom) members = payload.members || [];
        renderSide();
        renderHead();
        return;
      }
      if (payload.type === 'typing') {
        noteTyping(payload.senderName);
        return;
      }
      if (payload.type === 'signal') {
        handleSignal(payload);
      }
    });
  }

  function noteTyping(name) {
    const hint = root.querySelector('#cn-hint');
    if (!hint || !name) return;
    clearTimeout(typingTimers.get(name));
    typingTimers.set(
      name,
      setTimeout(() => typingTimers.delete(name), 2600)
    );
    const names = [...typingTimers.keys()];
    hint.textContent = names.length
      ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…`
      : 'Enter sends · Shift + Enter adds a line';
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  /* ------------------------------ navigation ------------------------------ */

  function selectRoom(room) {
    if (room === activeRoom) return;
    send({ type: 'leave', room: activeRoom });
    activeRoom = room;
    messages = [];
    members = [];
    renderHead();
    renderSide();
    log.innerHTML = `<div class="cn-empty">${icon('fa-solid fa-circle-notch', 'fa-spin')}<p>Loading…</p></div>`;
    send({ type: 'join', room });
    history.replaceState(null, '', `#/cc:connect?room=${encodeURIComponent(room)}`);
    sessionStorage.setItem('cc:lastRoute', `cc:connect?room=${encodeURIComponent(room)}`);
    textarea.focus();
  }

  function createChannel() {
    openModal({
      title: 'New channel',
      sub: 'Channels are open to everyone on this server.',
      body: `<div class="field"><label class="label">Name</label><input class="input" id="chan-name" placeholder="design" /></div>
        <p class="hint" style="margin-top:8px">Lowercase letters, numbers, dashes and spaces.</p>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create channel',
          kind: 'primary',
          onClick: ({ dialog }) => {
            const name = dialog
              .querySelector('#chan-name')
              .value.trim()
              .toLowerCase()
              .replace(/[^a-z0-9\- ]/g, '')
              .slice(0, 40);
            if (!name) return false;
            if (!rooms.some((room) => (room.room ?? room) === name)) rooms.push({ room: name });
            selectRoom(name);
          }
        }
      ]
    });
  }

  /* -------------------------------- sending ------------------------------- */

  async function sendMessage() {
    const text = textarea.value.trim();
    if (!text) return;
    const key = isDm(activeRoom) ? null : await ensureKey(activeRoom, { ask: false });
    const payload = key ? await encryptText(key, text) : text;
    textarea.value = '';
    autoGrow();
    send({ type: 'message', room: activeRoom, body: payload });
    renderHead();
  }

  function autoGrow() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`;
  }

  /* -------------------------------- invites ------------------------------- */

  function openInvite() {
    if (isDm(activeRoom)) return openDirectMessage();
    openModal({
      title: `Invite to #${activeRoom}`,
      sub: 'They get a chime and an entry in Activity with the bell in their sidebar.',
      wide: true,
      body: `<form id="invite-form" class="stack-3">
        <div class="field">
          <label class="label">Username</label>
          <input class="input" name="username" list="invite-people" placeholder="sam" autocomplete="off" required />
          <datalist id="invite-people">${people
            .map((person) => `<option value="${esc(person.username)}">${esc(person.name)}</option>`)
            .join('')}</datalist>
          <span class="hint">Pick an existing member or type a new username.</span>
        </div>
        ${
          me.role === 'admin'
            ? `<div class="field-row">
                <div class="field"><label class="label">Display name</label><input class="input" name="name" placeholder="For new accounts" /></div>
                <div class="field"><label class="label">Email</label><input class="input" name="email" type="email" placeholder="Optional" /></div>
              </div>
              <p class="hint">A free username creates the account here. CoolCloud shows you a one-time password to pass on.</p>`
            : `<p class="hint">Only administrators can create accounts for usernames that do not exist yet.</p>`
        }
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Send invite',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const form = dialog.querySelector('#invite-form');
            const username = form.username.value.trim();
            if (!username) return false;
            let result;
            try {
              result = await api('/api/connect/invite', {
                method: 'POST',
                body: {
                  room: activeRoom,
                  username,
                  name: form.name?.value || '',
                  email: form.email?.value || ''
                }
              });
            } catch (err) {
              toast(err.message, 'error');
              return false;
            }
            toast(`${result.user.name} was invited to #${activeRoom}`);
            if (result.created) {
              setTimeout(() => showCredentials(result.created, activeRoom), 40);
            }
            await loadLists();
            send({ type: 'join', room: activeRoom });
          }
        }
      ]
    });
  }

  function showCredentials(created, room) {
    openModal({
      title: 'Account created',
      sub: 'Share these once. The password is not shown again.',
      body: `<div class="stack-3">
        <div class="kv-list">
          <div class="kv"><span class="k">Username</span><span class="v">${esc(created.username)}</span></div>
          <div class="kv"><span class="k">Password</span><span class="v">${esc(created.password)}</span></div>
          <div class="kv"><span class="k">Invited to</span><span class="v">#${esc(room)}</span></div>
        </div>
        <p class="hint">They sign in at this address. Ask them to change the password in Me → Security.</p>
      </div>`,
      actions: [
        { label: 'Done', kind: 'ghost' },
        {
          label: 'Copy',
          kind: 'primary',
          onClick: () => {
            navigator.clipboard?.writeText(`Username: ${created.username}\nPassword: ${created.password}`);
            toast('Credentials copied');
            setTimeout(() => openInvite(), 60);
            return true;
          }
        }
      ]
    });
  }

  function openDirectMessage() {
    openModal({
      title: 'New direct message',
      body: `<div class="stack-1">${
        people.length
          ? people
              .map(
                (person) => `<button class="cn-row" data-pick-dm="${person.id}">
                  <span class="avatar sm">${esc(initials(person.name))}</span>
                  <span class="grow">${esc(person.name)}</span>
                  <span class="meta">@${esc(person.username)}</span>
                </button>`
              )
              .join('')
          : '<p class="hint">No other members yet. Invite someone to a channel first.</p>'
      }</div>`,
      onMount: (dialog, close) => {
        dialog.querySelectorAll('[data-pick-dm]').forEach((node) => {
          node.addEventListener('click', () => {
            close();
            selectRoom(dmRoom(me.id, node.dataset.pickDm));
          });
        });
      }
    });
  }

  /* --------------------------------- calls -------------------------------- */

  function stageShell(inner) {
    document.getElementById('call-stage')?.remove();
    const stage = document.createElement('div');
    stage.className = 'call-stage';
    stage.id = 'call-stage';
    stage.innerHTML = inner;
    document.body.appendChild(stage);
    return stage;
  }

  async function openMedia(video) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
      return localStream;
    } catch (err) {
      toast(`Cannot open microphone or camera: ${err.message}`, 'error');
      return null;
    }
  }

  function mountMeter(stage, stream) {
    const bar = stage.querySelector('#call-meter > span');
    if (!bar || !stream) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!document.body.contains(stage)) return;
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const normal = (value - 128) / 128;
          sum += normal * normal;
        }
        const rms = Math.sqrt(sum / buffer.length);
        bar.style.transform = `scaleX(${Math.min(1, rms * 4.6)})`;
        meterFrame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter is decoration */
    }
  }

  function startTimer(stage) {
    const started = Date.now();
    const label = stage.querySelector('#call-clock');
    callTimer = setInterval(() => {
      if (!label) return;
      const seconds = Math.floor((Date.now() - started) / 1000);
      label.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
  }

  async function startSoloCall(video = true) {
    if (peer) return toast('A call is already running', 'error');
    const stream = await openMedia(video);
    if (!stream) return;
    const stage = stageShell(`
      <div class="call-top">
        <strong>Call with yourself</strong>
        <span class="badge">Test</span>
        <span class="grow"></span>
        <span class="badge" id="call-clock">00:00</span>
      </div>
      <div class="call-body">
        ${
          video
            ? '<video id="call-media" class="mirror" autoplay muted playsinline></video>'
            : `<div class="call-self">
                <span class="avatar xl" style="background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16);color:#f2efe9">${esc(
                  initials(me.name || me.username)
                )}</span>
                <div class="call-self-title">Only you in this call</div>
              </div>`
        }
      </div>
      <div class="call-self" style="padding:0 20px">
        <p class="call-self-sub">${
          video
            ? 'This is exactly what others see when you start a video call. No one else is connected, and nothing leaves this machine.'
            : 'Your microphone is live. No one else is connected, so you can check levels safely.'
        }</p>
        <div class="call-meter" id="call-meter"><span></span></div>
      </div>
      <div class="call-bar">
        <button class="call-btn" id="toggle-mic" title="Mute">${icon('fa-solid fa-microphone')}</button>
        ${
          video
            ? `<button class="call-btn" id="toggle-cam" title="Turn camera off">${icon('fa-solid fa-video')}</button>`
            : ''
        }
        <button class="call-btn hang" id="hangup" title="End call">${icon('fa-solid fa-phone-slash')}</button>
      </div>
    `);
    const media = stage.querySelector('#call-media');
    if (media) media.srcObject = stream;
    mountMeter(stage, stream);
    startTimer(stage);
    wireControls(stage, stream);
  }

  async function startCall(target, video) {
    if (peer) return toast('A call is already running', 'error');
    const stream = await openMedia(video);
    if (!stream) return;
    peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        send({ type: 'signal', room: activeRoom, to: target.id, data: { kind: 'candidate', candidate: event.candidate } });
      }
    });
    peer.addEventListener('track', (event) => {
      const remote = document.getElementById('call-remote');
      if (remote) remote.srcObject = event.streams[0];
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    send({ type: 'signal', room: activeRoom, to: target.id, data: { kind: 'offer', sdp: offer, video } });
    showPeerStage(target.name, video, stream, 'Calling');
  }

  function showPeerStage(label, video, stream, status) {
    const stage = stageShell(`
      <div class="call-top">
        <strong>${esc(label)}</strong>
        <span class="badge" id="call-status">${esc(status)}</span>
        <span class="grow"></span>
        <span class="badge" id="call-clock">00:00</span>
      </div>
      <div class="call-body">
        ${
          video
            ? '<video id="call-remote" autoplay playsinline></video>'
            : `<audio id="call-remote" autoplay></audio>
         <div class="call-self">
                <span class="avatar xl" style="background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16);color:#f2efe9">${esc(
                  initials(label)
                )}</span>
                <div class="call-self-title">${esc(label)}</div>
                <div class="call-self-sub">Voice call · peer to peer</div>
              </div>`
        }
        ${
          video
            ? '<div class="call-pip"><video id="call-local" autoplay muted playsinline></video></div>'
            : ''
        }
      </div>
      <div class="call-bar">
        <button class="call-btn" id="toggle-mic" title="Mute">${icon('fa-solid fa-microphone')}</button>
        ${
          video
            ? `<button class="call-btn" id="toggle-cam" title="Turn camera off">${icon('fa-solid fa-video')}</button>`
            : ''
        }
        <button class="call-btn hang" id="hangup" title="End call">${icon('fa-solid fa-phone-slash')}</button>
      </div>
    `);
    const local = stage.querySelector('#call-local');
    if (local) local.srcObject = stream;
    startTimer(stage);
    wireControls(stage, stream);
  }

  function wireControls(stage, stream) {
    const mic = stage.querySelector('#toggle-mic');
    const cam = stage.querySelector('#toggle-cam');
    mic?.addEventListener('click', () => {
      const track = stream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      mic.classList.toggle('off', !track.enabled);
      mic.innerHTML = icon(track.enabled ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash');
    });
    cam?.addEventListener('click', () => {
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      cam.classList.toggle('off', !track.enabled);
      cam.innerHTML = icon(track.enabled ? 'fa-solid fa-video' : 'fa-solid fa-video-slash');
    });
    stage.querySelector('#hangup').addEventListener('click', endCall);
  }

  function chooseCall(video) {
    const others = members.filter((member) => Number(member.id) !== Number(me.id));
    if (!others.length) {
      openModal({
        title: 'No one else is here',
        sub: 'You can still check your camera and microphone on your own.',
        body: `<div class="note">${icon('fa-solid fa-circle-info')} <span>Calls connect two people directly. Invite someone first, then call them from this room.</span></div>`,
        actions: [
          { label: 'Cancel', kind: 'ghost' },
          {
            label: 'Test call',
            kind: 'primary',
            onClick: () => {
              setTimeout(() => startSoloCall(video), 40);
            }
          }
        ]
      });
      return;
    }
    if (others.length === 1) return startCall(others[0], video);
    openModal({
      title: 'Call someone',
      body: `<div class="stack-1">${others
        .map(
          (member) => `<button class="cn-row" data-pick-call="${member.id}">
            <span class="avatar sm">${esc(initials(member.name))}</span>
            <span class="grow">${esc(member.name)}</span>
          </button>`
        )
        .join('')}</div>`,
      onMount: (dialog, close) => {
        dialog.querySelectorAll('[data-pick-call]').forEach((node) => {
          node.addEventListener('click', () => {
            const target = others.find((member) => String(member.id) === node.dataset.pickCall);
            close();
            if (target) startCall(target, video);
          });
        });
      }
    });
  }

  function endCall() {
    document.getElementById('call-stage')?.remove();
    if (callTimer) clearInterval(callTimer);
    callTimer = null;
    if (meterFrame) cancelAnimationFrame(meterFrame);
    meterFrame = null;
    try {
      peer?.close();
    } catch {
      /* ignore */
    }
    peer = null;
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    pendingCandidates = [];
  }

  let pendingCandidates = [];

  async function handleSignal(payload) {
    const data = payload.data || {};
    if (data.kind === 'offer') {
      const accepted = await new Promise((resolve) => {
        openModal({
          title: 'Incoming call',
          sub: `${payload.fromName} is calling in ${isDm(activeRoom) ? 'your conversation' : `#${activeRoom}`}`,
          body: '<p class="small muted">Accepting opens your microphone and camera and connects you directly to them.</p>',
          actions: [
            { label: 'Decline', kind: 'ghost', onClick: () => resolve(false) },
            { label: 'Accept', kind: 'primary', onClick: () => resolve(true) }
          ]
        });
      });
      if (!accepted) return;
      const stream = await openMedia(Boolean(data.video));
      if (!stream) return;
      peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.addEventListener('icecandidate', (event) => {
        if (event.candidate) {
          send({ type: 'signal', room: activeRoom, to: payload.from, data: { kind: 'candidate', candidate: event.candidate } });
        }
      });
      peer.addEventListener('track', (event) => {
        const remote = document.getElementById('call-remote');
        if (remote) remote.srcObject = event.streams[0];
      });
      await peer.setRemoteDescription(data.sdp);
      for (const candidate of pendingCandidates) await peer.addIceCandidate(candidate).catch(() => {});
      pendingCandidates = [];
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      send({ type: 'signal', room: activeRoom, to: payload.from, data: { kind: 'answer', sdp: answer } });
      showPeerStage(payload.fromName, Boolean(data.video), stream, 'Connected');
      return;
    }
    if (data.kind === 'answer' && peer) {
      await peer.setRemoteDescription(data.sdp).catch(() => {});
      const status = document.getElementById('call-status');
      if (status) status.textContent = 'Connected';
      return;
    }
    if (data.kind === 'candidate') {
      if (peer && peer.remoteDescription) await peer.addIceCandidate(data.candidate).catch(() => {});
      else pendingCandidates.push(data.candidate);
    }
  }

  /* ------------------------------ wiring ---------------------------------- */

  root.querySelector('[data-rail="chat"]').addEventListener('click', () => textarea.focus());
  root.querySelector('[data-rail="activity"]').addEventListener('click', () => openActivity());
  root.querySelector('[data-rail="invite"]').addEventListener('click', openInvite);
  root.querySelector('[data-rail="app-drawer"]').addEventListener('click', () => ctx.openDrawer());
  root.querySelectorAll('[data-rail="me"]').forEach((node) =>
    node.addEventListener('click', () => openTab('me'))
  );
  root.querySelector('#side-invite').addEventListener('click', openInvite);
  root.querySelector('[data-open-invite]').addEventListener('click', openInvite);
  root.querySelectorAll('[data-call]').forEach((node) => {
    node.addEventListener('click', () => chooseCall(node.dataset.call === 'video'));
  });
  root.querySelector('#cn-send').addEventListener('click', sendMessage);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  textarea.addEventListener('input', () => {
    autoGrow();
    send({ type: 'typing', room: activeRoom });
  });
  root.querySelector('#cn-key').addEventListener('click', async () => {
    const passphrase = await askPassphrase(activeRoom);
    if (passphrase === null) return;
    if (!passphrase) {
      delete passphrases[activeRoom];
      delete keys[activeRoom];
    } else {
      passphrases[activeRoom] = passphrase;
      keys[activeRoom] = await deriveKey(passphrase, activeRoom);
    }
    localStorage.setItem('cc:connect:passphrases', JSON.stringify(passphrases));
    renderHead();
    renderSide();
    send({ type: 'join', room: activeRoom });
    toast(passphrase ? 'Room key set' : 'Room key cleared');
  });
  root.querySelector('#cn-filter').addEventListener('input', (event) => {
    query = event.target.value;
    renderSide();
  });
  root.querySelector('#ws').addEventListener('click', () => ctx.openDrawer());

  renderHead();
  renderMessages();
  loadLists();
  connect();
  textarea.focus();

  return () => {
    disposed = true;
    endCall();
    socket?.close();
    socket = null;
    for (const timer of typingTimers.values()) clearTimeout(timer);
    typingTimers.clear();
  };
}
