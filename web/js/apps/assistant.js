import { api, esc, icon, openModal, toast } from '../core.js';

export default function mount(root, ctx) {
  let config = null;
  let messages = [];
  let streaming = false;
  let useContext = localStorage.getItem('cc:assistantContext') !== 'off';
  let contextText = '';

  const defaultPrompts = [
    { name: 'Plan my week', text: 'Look at my calendar and open tasks, then propose a realistic plan for this week with time blocks.' },
    { name: 'Summarise files', text: 'Summarise the most recently changed files in my workspace and call out anything that looks unfinished.' },
    { name: 'Project brief', text: 'Write a one-page project brief with goals, audience, milestones and open questions.' },
    { name: 'Explain code', text: 'Explain what this code does, then list concrete risks and a simpler alternative.\n\n```\n\n```' }
  ];
  const readPrompts = () => {
    try {
      const saved = JSON.parse(localStorage.getItem('cc:assistantPrompts') || '[]');
      return [...defaultPrompts, ...(Array.isArray(saved) ? saved : [])];
    } catch {
      return defaultPrompts;
    }
  };

  root.innerHTML = `<div class="page">
    <header class="page-head">
      <div>
        <h1 class="page-title">Assistant <span class="badge warn">BETA</span></h1>
        <p class="page-sub">An assistant that lives inside your cloud. Bring your own key.</p>
      </div>
      <div class="page-actions">
        <button class="btn quiet sm" id="ai-context">${icon('fa-solid fa-layer-group')} Context</button>
        <button class="btn quiet sm" id="ai-prompts">${icon('fa-regular fa-bookmark')} Prompts</button>
        <button class="btn quiet sm" id="ai-settings">${icon('fa-solid fa-sliders')} Settings</button>
        <button class="btn ghost sm" id="ai-clear">${icon('fa-solid fa-broom')} Clear</button>
      </div>
    </header>

    <div class="assistant-shell">
      <div class="assistant-log" id="ai-log"></div>
      <form class="ai-compose" id="ai-form">
        <textarea id="ai-input" rows="1" placeholder="Ask anything. Shift+Enter for a new line." aria-label="Message the assistant"></textarea>
        <button class="btn primary" type="submit" id="ai-send">${icon('fa-solid fa-arrow-up')} Send</button>
      </form>
      <p class="hint" style="text-align:center">Requests go from this server directly to the provider you configure. CoolCloud stores no transcripts.</p>
    </div>
  </div>`;

  const log = root.querySelector('#ai-log');
  const input = root.querySelector('#ai-input');
  const form = root.querySelector('#ai-form');
  const sendBtn = root.querySelector('#ai-send');
  const contextBtn = root.querySelector('#ai-context');

  function paintContext() {
    contextBtn.classList.toggle('active', useContext);
    contextBtn.setAttribute('aria-pressed', String(useContext));
    contextBtn.title = useContext ? 'Workspace context is included' : 'Workspace context is off';
  }
  paintContext();

  async function loadContext() {
    if (!useContext) return '';
    try {
      const data = await api('/api/assistant/context');
      const lines = ['Recent files:'];
      lines.push(...(data.recentFiles || []).slice(0, 20).map((file) => `- ${file.path} (${Math.max(1, Math.round(file.size / 1024))} KB)`));
      lines.push('', 'Open tasks:');
      lines.push(...(data.tasks || []).slice(0, 15).map((task) => `- ${task.title}${task.due ? ` (due ${task.due})` : ''}${task.list ? ` [${task.list}]` : ''}`));
      lines.push('', 'Upcoming events:');
      lines.push(...(data.events || []).slice(0, 15).map((event) => `- ${event.title} at ${event.start_at}`));
      contextText = lines.join('\n');
      return contextText;
    } catch {
      return '';
    }
  }

  function renderLog() {
    if (!messages.length) {
      const suggestions = [
        ...readPrompts().slice(0, 4).map((prompt) => prompt.text)
      ];
      log.innerHTML = `<div class="empty" style="padding:40px 12px">
        ${icon('fa-solid fa-wand-magic-sparkles', 'font-size:22px')}
        <p>Bring your own provider key, then ask away.</p>
        <div class="row wrap" style="justify-content:center;gap:6px;margin-top:8px">
          ${suggestions.map((text) => `<button class="btn quiet sm" data-suggest="${esc(text)}">${esc(text)}</button>`).join('')}
        </div>
      </div>`;
      log.querySelectorAll('[data-suggest]').forEach((node) => {
        node.addEventListener('click', () => {
          input.value = node.dataset.suggest;
          form.requestSubmit();
        });
      });
      return;
    }
    log.innerHTML = messages
      .map(
        (message) => `<div class="ai-msg ${message.role === 'user' ? 'me' : ''}">
          <span class="ai-role">${message.role === 'user' ? 'You' : 'Assistant'}</span>
          <div class="ai-text">${esc(message.content) || '<span class="dim">…</span>'}</div>
        </div>`
      )
      .join('');
    log.scrollTop = log.scrollHeight;
  }

  async function loadConfig() {
    try {
      config = await api('/api/assistant');
    } catch {
      config = { configured: false };
    }
    if (!config.configured) showSetup();
  }

  function showSetup() {
    log.innerHTML = `<div class="widget" style="margin:auto;max-width:520px">
      <h2 style="font-size:17px">Connect a provider</h2>
      <p class="small muted">The Assistant uses an OpenAI-compatible chat endpoint with your own key. Keys are stored server-side and never sent to the browser.</p>
      <form id="ai-setup" class="stack-3">
        <div class="field"><label class="label">Base URL</label><input class="input" name="baseUrl" placeholder="https://api.openai.com/v1" value="${esc(
          config?.baseUrl || ''
        )}" /></div>
        <div class="field"><label class="label">Model</label><input class="input" name="model" placeholder="gpt-4o-mini" value="${esc(
          config?.model || ''
        )}" /></div>
        <div class="field"><label class="label">API key</label><input class="input" type="password" name="apiKey" placeholder="${config?.hasKey ? 'Saved — leave blank to keep' : 'sk-…'}" autocomplete="off" /></div>
        <button class="btn primary" type="submit">Save provider</button>
      </form>
      <p class="hint">Also works with local gateways: Ollama, LM Studio, vLLM and anything else that speaks the same API.</p>
    </div>`;
    log.querySelector('#ai-setup').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      try {
        await api('/api/assistant', {
          method: 'PUT',
          body: { baseUrl: data.get('baseUrl'), model: data.get('model'), apiKey: data.get('apiKey') }
        });
        toast('Assistant connected');
        config = await api('/api/assistant');
        renderLog();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (streaming) return;
    const text = input.value.trim();
    if (!text) return;
    if (!config?.configured) {
      showSetup();
      return;
    }
    input.value = '';
    input.style.height = 'auto';
    messages.push({ role: 'user', content: text });
    messages.push({ role: 'assistant', content: '' });
    renderLog();
    streaming = true;
    sendBtn.disabled = true;

    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.filter((message) => message.content).slice(0, -1),
          model: config.model,
          context: useContext ? await loadContext() : ''
        })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Provider error (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json.error) throw new Error(json.error);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              messages[messages.length - 1].content += delta;
              const bubbles = log.querySelectorAll('.ai-text');
              const bubble = bubbles[bubbles.length - 1];
              if (bubble) {
                bubble.textContent = messages[messages.length - 1].content;
                log.scrollTop = log.scrollHeight;
              }
            }
          } catch (err) {
            if (err.message && !err.message.includes('JSON')) throw err;
          }
        }
      }
      if (!messages[messages.length - 1].content) messages[messages.length - 1].content = '(no response)';
    } catch (err) {
      messages[messages.length - 1].content = `Error: ${err.message}`;
      toast(err.message, 'error');
    } finally {
      streaming = false;
      sendBtn.disabled = false;
      renderLog();
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  });

  root.querySelector('#ai-settings').addEventListener('click', () => {
    openModal({
      title: 'Assistant provider',
      body: `<form id="ai-config" class="stack-3">
        <div class="field"><label class="label">Base URL</label><input class="input" name="baseUrl" value="${esc(config?.baseUrl || '')}" /></div>
        <div class="field"><label class="label">Model</label><input class="input" name="model" value="${esc(config?.model || '')}" /></div>
        <div class="field"><label class="label">API key</label><input class="input" type="password" name="apiKey" placeholder="${
          config?.hasKey ? 'Saved — leave blank to keep' : ''
        }" autocomplete="off" /></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save',
          kind: 'primary',
          onClick: async ({ dialog }) => {
            const data = new FormData(dialog.querySelector('#ai-config'));
            await api('/api/assistant', { method: 'PUT', body: Object.fromEntries(data.entries()) });
            config = await api('/api/assistant');
            toast('Assistant settings saved');
            renderLog();
          }
        }
      ]
    });
  });

  root.querySelector('#ai-clear').addEventListener('click', () => {
    messages = [];
    renderLog();
  });

  contextBtn.addEventListener('click', async () => {
    useContext = !useContext;
    localStorage.setItem('cc:assistantContext', useContext ? 'on' : 'off');
    paintContext();
    if (useContext) {
      const text = await loadContext();
      toast(text ? 'Workspace context will be shared with this chat' : 'Context is on, but nothing could be loaded');
    } else {
      contextText = '';
      toast('Workspace context is off');
    }
  });

  root.querySelector('#ai-prompts').addEventListener('click', () => {
    const prompts = readPrompts();
    openModal({
      title: 'Prompt library',
      sub: 'Reusable prompts stay in this browser.',
      body: `<div class="stack-2">${prompts
        .map(
          (prompt, index) => `<div class="version-row"><span class="file-ico">${icon('fa-regular fa-bookmark')}</span>
            <span class="grow" style="min-width:0"><span class="strong small">${esc(prompt.name)}</span>
            <span class="tiny dim" style="display:block">${esc(prompt.text.slice(0, 100))}</span></span>
            <button class="btn quiet sm" data-run-prompt="${index}">Use</button>
            ${index >= defaultPrompts.length ? `<button class="btn ghost icon sm" data-delete-prompt="${index - defaultPrompts.length}" aria-label="Delete">${icon('fa-solid fa-xmark')}</button>` : ''}</div>`
        )
        .join('')}</div>
        <div class="row" style="margin-top:12px;gap:8px"><input class="input grow" id="prompt-name" placeholder="Name" /><button class="btn sm" id="save-prompt">Save current message</button></div>`,
      actions: [{ label: 'Close', kind: 'ghost' }],
      onMount: (dialog) => {
        dialog.querySelectorAll('[data-run-prompt]').forEach((node) => {
          node.addEventListener('click', () => {
            input.value = prompts[Number(node.dataset.runPrompt)].text;
            dialog.closest('.modal-backdrop')?.remove();
            input.focus();
          });
        });
        dialog.querySelectorAll('[data-delete-prompt]').forEach((node) => {
          node.addEventListener('click', () => {
            const saved = JSON.parse(localStorage.getItem('cc:assistantPrompts') || '[]');
            saved.splice(Number(node.dataset.deletePrompt), 1);
            localStorage.setItem('cc:assistantPrompts', JSON.stringify(saved));
            dialog.closest('.modal-backdrop')?.remove();
          });
        });
        dialog.querySelector('#save-prompt').addEventListener('click', () => {
          const text = input.value.trim();
          const name = dialog.querySelector('#prompt-name').value.trim() || text.slice(0, 30);
          if (!text) return toast('Write a message first', 'error');
          const saved = JSON.parse(localStorage.getItem('cc:assistantPrompts') || '[]');
          saved.push({ name, text });
          localStorage.setItem('cc:assistantPrompts', JSON.stringify(saved.slice(-30)));
          toast('Prompt saved');
          dialog.closest('.modal-backdrop')?.remove();
        });
      }
    });
  });

  const prompt = sessionStorage.getItem('cc:assistantPrompt');
  if (prompt) {
    sessionStorage.removeItem('cc:assistantPrompt');
    input.value = prompt;
  }

  loadConfig().then(() => {
    renderLog();
    if (prompt && config?.configured) form.requestSubmit();
    else input.focus();
  });
}
