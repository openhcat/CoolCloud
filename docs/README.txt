COOLCLOUD DOCUMENTATION
=======================

CoolCloud is a self-hosted collaboration suite: Files, Calendar, Mail, Contacts,
Editor and Tasks, plus an optional Essentials Pack (Connect, Media, Assistant).

Read in this order
------------------
1. HOSTING.txt          How to run it properly: Linux, Windows, TLS, backups.
2. CONFIG.txt           Every key in config.json.
3. CLI.txt              The bundled CLI and the standalone remote CLI.
4. SECURITY.txt         What is protected, what is not, and how to harden it.
5. BUILDING-APPS.txt    Write an app for CoolCloud.
6. APP-MANIFEST.txt     Manifest field reference.
7. APPSTORE-REGISTRY.txt Decentralised registry format.
8. DESIGN-SYSTEM.txt    Tokens, components and the rules behind the UI.
9. API.txt              HTTP endpoints, auth and examples.
10. EDITOR-OFFICE.txt   Hosted Collabora, embedded office editing and WOPI.
11. DOMAIN-TLS-DDNS.txt Custom domain, HTTPS, Cloudflare Tunnel, DDNS hosts.

What is where
-------------
bin/coolcloud.js        Installer, local server control, remote CLI
server/                 Zero-dependency Node HTTP server
  index.js              Entrypoint: routing, static files, WebSocket
  api/                  Route modules (auth, files, workspace, mail, admin, extras)
  db.js                 SQLite schema and helpers (node:sqlite)
  auth.js               scrypt hashes, sessions, roles
  mailer.js             SMTP send, IMAP read
  office.js             Docker provisioning for office servers
  ws.js                 Minimal RFC 6455 WebSocket server
web/                    The interface (no build step, ES modules)
  css/tokens.css        Design tokens
  css/components.css    Buttons, inputs, cards, modals, tables
  js/shell.js           Sidebar, tabs, app drawer, routing
  js/apps/              One module per app
apps/                   Bundled app manifests
cc-cli/coolcloud.py     Standalone CLI, standard library only
examples/hello-app/     A complete minimal third-party app
appstore/registry.json  Example registry
scripts/sync-assets.js  Vendors Font Awesome and Inter into web/vendor

Design constraints
------------------
* Node.js 24 or newer. No npm packages are needed at runtime.
* Linux and Windows are supported. macOS is not a supported target.
* Data lives in <instance>/data. Back that folder up.
* Files is a shared team drive; calendar, contacts, tasks and mail are per user.

Quick start
-----------
    git clone <your-fork> coolcloud
    cd coolcloud
    node bin/coolcloud.js --install
    cd ~/coolcloud && ./start.sh        (Windows: start.cmd)

Then open http://localhost:8080 and sign in with the admin account.

Where to get help
-----------------
The admin panel has a Logs tab (data/logs/error.log and access.log). Most
problems are visible there first.
