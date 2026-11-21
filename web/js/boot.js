import { init } from './shell.js';

init().catch((err) => {
  console.error(err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div class="empty" style="min-height:100vh"><i class="fa-solid fa-triangle-exclamation"></i><p>CoolCloud could not start: ${String(
      err.message || err
    ).replace(/</g, '&lt;')}</p></div>`;
  }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
