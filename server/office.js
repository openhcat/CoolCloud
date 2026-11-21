import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COLLABORA = { port: 9980, image: 'collabora/code:latest' };
const ONLYOFFICE = { port: 8082, image: 'onlyoffice/documentserver:latest' };

export const OFFICE_PROVIDERS = {
  collabora: { label: 'Collabora Online', port: COLLABORA.port, image: COLLABORA.image },
  onlyoffice: { label: 'OnlyOffice Docs', port: ONLYOFFICE.port, image: ONLYOFFICE.image },
  microsoft: { label: 'Microsoft 365 online', port: null, image: null }
};

export function officeUrlFor(provider, customUrl = '') {
  if (customUrl) return customUrl.replace(/\/+$/, '');
  const info = OFFICE_PROVIDERS[provider];
  if (!info || !info.port) return '';
  return `http://localhost:${info.port}`;
}

/** Origin Collabora is allowed to frame, built from the public URL or the instance port. */
export function frameAncestor(cfg) {
  try {
    const origin = new URL(cfg.publicUrl || `http://localhost:${cfg.port}`);
    return origin.host;
  } catch {
    return `localhost:${cfg.port}`;
  }
}

/** Where the office container reaches CoolCloud's WOPI endpoints. */
export function wopiHostFor(cfg) {
  if (cfg.editor?.wopiHost) return cfg.editor.wopiHost;
  return 'host.docker.internal';
}

function collaboraCompose(name, cfg) {
  const alias = `${wopiHostFor(cfg)}:${cfg.port}`;
  const frame = frameAncestor(cfg);
  return `services:
  ${name}:
    image: ${COLLABORA.image}
    container_name: ${name}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${COLLABORA.port}:9980"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - "DONT_GEN_SSL_CERT=YES"
      - "aliasgroup1=${alias}"
      - "extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:welcome.enable=false --o:net.frame_ancestors=${frame}"
    shm_size: "512m"
`;
}

function onlyofficeCompose(name) {
  return `services:
  ${name}:
    image: ${ONLYOFFICE.image}
    container_name: ${name}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${ONLYOFFICE.port}:80"
    environment:
      - JWT_ENABLED=false
    shm_size: "1g"
`;
}

function run(command, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ status: 1, output: err.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      output += '\n(timed out)';
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 1, output: `${output}${err.message}` });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, output: output.trim() });
    });
  });
}

export async function dockerAvailable() {
  const result = await run('docker', ['--version'], 15000);
  return result.status === 0;
}

export async function officeRunning(name = 'coolcloud-office') {
  const result = await run('docker', ['inspect', '--format', '{{.State.Running}}', name], 20000);
  return result.status === 0 && result.output.trim() === 'true';
}

/** True when coolwsd answers its discovery endpoint. */
export async function officeAnswers(url, timeoutMs = 2500) {
  if (!url) return false;
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/hosting/discovery`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function writeCompose(paths, provider, name, cfg) {
  fs.mkdirSync(paths.officeDir, { recursive: true });
  const file = path.join(paths.officeDir, 'docker-compose.yml');
  const body = provider === 'collabora' ? collaboraCompose(name, cfg) : onlyofficeCompose(name);
  fs.writeFileSync(file, body);
  return file;
}

export async function provisionOffice(paths, provider, containerName = 'coolcloud-office', cfg = { port: 8080 }) {
  if (!OFFICE_PROVIDERS[provider] || !OFFICE_PROVIDERS[provider].image) {
    throw Object.assign(new Error('Choose Collabora or OnlyOffice to provision a local office server'), { status: 400 });
  }
  const port = OFFICE_PROVIDERS[provider].port;
  const file = writeCompose(paths, provider, containerName, cfg);
  const url = `http://localhost:${port}`;

  if (!(await dockerAvailable())) {
    return {
      ok: false,
      needsDocker: true,
      port,
      url,
      composeFile: file,
      output:
        'Docker is not available on this machine. The compose file has been written; install Docker and run:\n  docker compose -f ' +
        file +
        ' up -d'
    };
  }

  const result = await run('docker', ['compose', '-f', file, 'up', '-d'], 600000);
  const up = result.status === 0;
  let ready = false;
  if (up) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await officeAnswers(url)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return {
    ok: up,
    ready,
    port,
    url,
    composeFile: file,
    output: `${result.output}${up && !ready ? '\nThe container started but the office server is not answering yet.' : ''}`.trim().slice(-4000)
  };
}

let ensureCache = { at: 0, promise: null };

/**
 * Make sure the locally hosted office server is running. Shared by boot and
 * the first office document open, so a slow first pull only happens once.
 */
export function ensureOffice(paths, cfg, log = () => {}) {
  if (cfg.editor?.officeProvider !== 'collabora') {
    return Promise.resolve({ ready: false, reason: 'provider-not-collabora' });
  }
  if (cfg.editor?.autoHost === false) {
    const url = officeUrlFor('collabora', cfg.editor?.officeUrl);
    return officeAnswers(url).then((ready) => ({ ready, url, managed: false }));
  }
  if (ensureCache.promise && Date.now() - ensureCache.at < 30000) return ensureCache.promise;
  const name = cfg.editor?.officeContainer || 'coolcloud-office';
  const url = officeUrlFor('collabora', cfg.editor?.officeUrl);

  const promise = (async () => {
    if ((await officeRunning(name)) && (await officeAnswers(url))) {
      return { ready: true, url, managed: true, alreadyRunning: true };
    }
    log(`office: starting ${name} (first run downloads the image)`);
    const result = await provisionOffice(paths, 'collabora', name, cfg);
    if (!result.ok) {
      log(`office: could not start — ${result.output.split('\n').slice(-3).join(' ')}`);
      return { ready: false, url, managed: true, needsDocker: result.needsDocker, output: result.output };
    }
    log(`office: ${result.ready ? 'ready' : 'container started'} at ${result.url}`);
    return { ready: result.ready, url: result.url, managed: true, output: result.output };
  })().finally(() => {
    setTimeout(() => {
      ensureCache = { at: 0, promise: null };
    }, 5000).unref?.();
  });

  ensureCache = { at: Date.now(), promise };
  return promise;
}

/** Stop and delete the locally hosted office server and its compose file. */
export async function removeOffice(paths, cfg, containerName = 'coolcloud-office') {
  const file = path.join(paths.officeDir, 'docker-compose.yml');
  let output = '';
  let ok = true;
  if (await dockerAvailable()) {
    if (fs.existsSync(file)) {
      const down = await run('docker', ['compose', '-f', file, 'down', '-v', '--remove-orphans'], 180000);
      output += down.output;
      ok = ok && down.status === 0;
    } else {
      const stop = await run('docker', ['rm', '-f', containerName], 60000);
      output += stop.output;
    }
  } else {
    ok = false;
    output = 'Docker is not available; removed the compose file only.';
  }
  try {
    fs.rmSync(paths.officeDir, { recursive: true, force: true });
    fs.mkdirSync(paths.officeDir, { recursive: true });
  } catch {
    /* deleting the folder is best effort */
  }
  ensureCache = { at: 0, promise: null };
  return { ok, output: output.trim().slice(-4000) };
}
