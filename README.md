# CoolCloud
<img width="1904" height="928" alt="image" src="https://github.com/user-attachments/assets/bfd25aa3-6dd7-4d6b-b242-56b1ceca3c76" />

**Your own cloud. One install, every tool your team needs.**

CoolCloud is a self-hosted collaboration suite: files, calendar, mail, contacts, an editor and tasks in one place, on your own hardware, under your own accounts. No seat licensing, no outsourced storage, no surprise.

```bash
git clone https://github.com/openhcat/coolcloud/coolcloud.git
cd coolcloud
chmod +x coolcloud            # Linux; on Windows use coolcloud.cmd
node bin/coolcloud.js --install

# after the wizard, start the instance you created
cd ~/coolcloud && ./start.sh  # Windows: start.cmd
```

Then open `http://localhost:8080`.

---

## What's inside

| App | What it does |
| --- | --- |
| **Files** | Folder tree, uploads, downloads, versions of your own text files, previews, streaming playback |
| **Calendar** | Multiple calendars, all-day events, month/week/day views |
| **Mail** | Connect any SMTP server to send, and any IMAP server to read your inbox |
| **Contacts** | People, organisations, notes, quick actions |
| **Editor** | Built-in text/Markdown editing, and office documents edited in place by a Collabora server CoolCloud hosts for you |
| **Tasks** | The base app: lists, due dates, priorities, done state |
| **Search** | One box over your files, apps, people, events and tasks — plus server config for admins |
| **Admin** | Users, quotas, storage, server health, error log, app toggles, app store, and Personalization for the name, mark, logo and accent |

### Essentials Pack (optional at install)

| App | What it does |
| --- | --- |
| **Connect** | A real workspace: channels, direct messages, invites with Activity alerts, peer-to-peer voice/video and a private test call |
| **Media** | Photo and video library with a real player, straight from your Files |
| **Assistant** *(BETA)* | An assistant that can see your CoolCloud. Bring your own key |

---

## Install

**Requirements:** Linux or Windows with Node.js 24+ (and Python 3.8+ only if you want the standalone remote CLI).

```bash
git clone https://github.com/yourname/coolcloud.git
cd coolcloud
node bin/coolcloud.js --install
```

`--install` walks you through:

1. **Where to install** — a directory that will hold config, data and apps
2. **Storage** — a cap in GB, or `Unlimited` (uses whatever the machine gives it)
3. **Accounts** — how many users the server may hold, or Unlimited
4. **The first admin account**
5. **Essentials Pack** — Connect, Media and Assistant, if you want them
6. **The optional CLI** — a launcher for the standalone remote CLI, if you want one

It then draws the CoolCloud boot animation, writes the config, creates the admin and prints:

```
  Welcome to CoolCloud

  [x] Delete unnecessary setup files (RECOMMENDED)
  [ ] Start CoolCloud now (OPTIONAL)
```

On Windows, use `node bin\coolcloud.js --install` or the `coolcloud.cmd` shim.

### After install

```bash
cd /path/you/chose
./start.sh                  # Linux
start.cmd                   # Windows
```

Or run the CLI directly: `./coolcloud --start`.

CoolCloud listens on `0.0.0.0:8080` by default. Put it behind a reverse proxy with TLS for anything beyond your LAN — see [`docs/HOSTING.txt`](docs/HOSTING.txt) and [`docs/DOMAIN-TLS-DDNS.txt`](docs/DOMAIN-TLS-DDNS.txt), which covers custom domains and dynamic DNS step by step.

---

## The CLI

The CLI is available in two flavours: the bundled Node CLI (inside the repo, no install step) and a single-file Python CLI that talks to a running server from anywhere.

```bash
coolcloud --login                       # enter server URL, username, password
coolcloud --status                      # server health
coolcloud --install cc:files            # core app (already installed)
coolcloud --install acme:notes          # a store app by developer:name
coolcloud --install acme:notes dir=./notes   # install from a local folder
coolcloud --config edit                 # opens config.json in nano / vim / notepad
coolcloud --config show
coolcloud --users list --add sam
```

Standalone (no repo needed):

```bash
python3 cc-cli/coolcloud.py --login
python3 cc-cli/coolcloud.py --install acme:notes
```

See [`docs/CLI.txt`](docs/CLI.txt).

---

## Building apps

Apps are plain directories with a `manifest.json` and a web entry point. They reuse the CoolCloud design system, so everything matches out of the box.

```
apps/my-notes/
├── manifest.json
├── web/
│   ├── app.js
│   └── app.css
├── README.txt
└── screenshot.png
```

```json
{
  "id": "acme:notes",
  "name": "Notes",
  "developer": "acme",
  "version": "1.0.0",
  "description": "Shared notes for the team.",
  "icon": "fa-solid fa-note-sticky",
  "entry": "web/index.html",
  "permissions": ["files:read", "files:write"]
}
```

Install it locally with `coolcloud --install acme:notes dir=./my-notes`, or drop the folder in your instance's `apps/` directory and run `coolcloud --install acme:notes`. Read [`docs/BUILDING-APPS.txt`](docs/BUILDING-APPS.txt) and [`docs/DESIGN-SYSTEM.txt`](docs/DESIGN-SYSTEM.txt).

---

## App store

Admins can point CoolCloud at any JSON registry — yours, your company's, or a community one. Registries are just a list of repos; nothing central to depend on.

```json
{
  "schema": "coolcloud.registry/1",
  "name": "Acme Apps",
  "apps": [
    {
      "id": "acme:notes",
      "name": "Notes",
      "developer": "acme",
      "version": "1.0.0",
      "description": "Shared notes for the team.",
      "icon": "fa-solid fa-note-sticky",
      "repo": "https://github.com/acme/coolcloud-notes.git"
    }
  ]
}
```

Add it under **Admin → Store**, then install with one click or `coolcloud --install acme:notes`. Format details in [`docs/APPSTORE-REGISTRY.txt`](docs/APPSTORE-REGISTRY.txt).

---

## Architecture

```
bin/coolcloud.js      CLI: install, start, login, install apps, config
cc-cli/coolcloud.py   standalone remote CLI (stdlib only)
server/               zero-dependency HTTP server (node:http, node:sqlite)
  api/                route modules
web/                  the UI: design system + ES-module apps, no build step
apps/                 installed apps, one directory each
docs/                 everything you need in .txt form
```

- **Storage:** SQLite for metadata (`data/db.sqlite`), plain files on disk for content (`data/files/`)
- **Auth:** scrypt password hashes, HttpOnly session cookies, `Authorization: Bearer` for the CLI
- **Realtime:** a small RFC 6455 WebSocket implementation, used by Connect
- **Dependencies:** none outside the Node standard library

---

## Security

- Self-hosted: data never leaves your machine unless you point an integration at it
- Passwords hashed with scrypt (N=16384) and per-user salts
- Sessions are random 256-bit tokens, hashed at rest, revocable from Admin
- File APIs are path-normalised and scoped to the data directory; no traversal
- Admin-only surfaces (server config, error log, app store, user management) are enforced server-side
- Mail credentials are stored server-side and never returned to the browser

See [`docs/SECURITY.txt`](docs/SECURITY.txt).

---

## Docs

- [`docs/HOSTING.txt`](docs/HOSTING.txt) — TLS, reverse proxy, systemd, backups
- [`docs/DOMAIN-TLS-DDNS.txt`](docs/DOMAIN-TLS-DDNS.txt) — your own domain, HTTPS, Cloudflare Tunnel, DDNS hosts
- [`docs/CLI.txt`](docs/CLI.txt) — every command
- [`docs/CONFIG.txt`](docs/CONFIG.txt) — config keys
- [`docs/API.txt`](docs/API.txt) — HTTP API
- [`docs/BUILDING-APPS.txt`](docs/BUILDING-APPS.txt) — write your own app
- [`docs/APP-MANIFEST.txt`](docs/APP-MANIFEST.txt) — manifest reference
- [`docs/DESIGN-SYSTEM.txt`](docs/DESIGN-SYSTEM.txt) — tokens and components
- [`docs/EDITOR-OFFICE.txt`](docs/EDITOR-OFFICE.txt) — Collabora / OnlyOffice via Docker
- [`docs/SECURITY.txt`](docs/SECURITY.txt) — the security model and its limits

## License

MIT. Do what you want with it; keep the notice.
