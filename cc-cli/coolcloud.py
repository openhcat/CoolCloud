#!/usr/bin/env python3
"""
CoolCloud remote CLI — one file, standard library only.

    python3 coolcloud.py --login
    python3 coolcloud.py --status
    python3 coolcloud.py --install acme:notes
    python3 coolcloud.py --doc edit docs/plan.md
    python3 coolcloud.py --users add sam

It talks to a running CoolCloud server. Administrator commands need an
administrator account; the token is stored in ~/.coolcloud/cli.json.
"""
import argparse
import getpass
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"
HOME = os.path.join(os.path.expanduser("~"), ".coolcloud", "cli.json")
TIMEOUT = 60


def cli_config():
    try:
        with open(HOME, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def save_cli_config(data):
    os.makedirs(os.path.dirname(HOME), exist_ok=True)
    with open(HOME, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    try:
        os.chmod(HOME, 0o600)
    except OSError:
        pass


def need_config():
    config = cli_config()
    if not config or not config.get("token"):
        fail("Not signed in. Run: coolcloud --login")
    return config


def api(config, path, method="GET", body=None, timeout=TIMEOUT):
    url = config["server"].rstrip("/") + path
    headers = {"Authorization": "Bearer " + config["token"]}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(payload).get("error", payload)
        except ValueError:
            message = payload or error.reason
        raise SystemExit(f"\n  {message}\n")
    except urllib.error.URLError as error:
        raise SystemExit(f"\n  Cannot reach the server: {error.reason}\n")


def fail(message):
    print(f"\n  {message}\n", file=sys.stderr)
    sys.exit(1)


def choose_editor(explicit=None):
    candidates = [explicit, os.environ.get("VISUAL"), os.environ.get("EDITOR")]
    if os.name == "nt":
        candidates.append("notepad")
    candidates += ["nano", "vim", "vi", "notepad"]
    for candidate in candidates:
        if not candidate:
            continue
        if shutil.which(candidate.split()[0]):
            return candidate
    return "vi"


def open_editor(path, explicit=None):
    editor = choose_editor(explicit)
    parts = editor.split()
    result = subprocess.call(parts + [path])
    return editor, result == 0


def ask(prompt, default=""):
    suffix = f" ({default})" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        return default
    return answer or default


def cmd_login(args):
    config = cli_config() or {}
    server = (args.server or ask("Server URL", config.get("server", "http://localhost:8080"))).rstrip("/")
    username = args.user or ask("Username", (config.get("user") or {}).get("username", ""))
    password = args.password or getpass.getpass("Password: ")
    if not username or not password:
        fail("Username and password are required.")
    body = json.dumps({"username": username, "password": password}).encode("utf-8")
    request = urllib.request.Request(
        server + "/api/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(payload).get("error", payload)
        except ValueError:
            message = payload
        fail(message)
    except urllib.error.URLError as error:
        fail(f"Cannot reach {server}: {error.reason}")
    save_cli_config({"server": server, "token": data["token"], "user": data["user"]})
    user = data["user"]
    print(f"\n  Signed in as {user.get('name') or user.get('username')} ({user.get('role')}) on {server}\n")


def cmd_status(args):
    config = need_config()
    user = config.get("user") or {}
    if user.get("role") != "admin":
        data = api(config, "/api/auth/session")
        account = data["user"]
        print(f"\n  {account.get('name')} - {config['server']}")
        print(f"  Role: {account.get('role')}")
        print("  Apps: " + ", ".join(app["name"] for app in data.get("apps", [])) + "\n")
        return
    data = api(config, "/api/admin/overview")
    storage = data["storage"]
    limit = storage.get("limit")
    print(f"\n  {data['server']['name']} - {config['server']}\n")
    print(f"  Users     {data['counts']['users']} ({data['counts']['admins']} admin)")
    print(f"  Sessions  {data['counts']['sessions']}")
    print(f"  Storage   {bytes_human(storage['used'])} / {bytes_human(limit) if limit else 'unlimited'}")
    print(f"  Uptime    {int(data['server']['uptime'] // 60)} min")
    print(f"  Node      {data['server']['node']} on {data['server']['platform']}")
    print(f"  Apps      {data['counts']['enabledApps']} enabled of {data['counts']['apps']}\n")


def bytes_human(value):
    value = float(value or 0)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if value < 1024:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} PB"


def cmd_install(args):
    config = need_config()
    if (config.get("user") or {}).get("role") != "admin":
        fail("Only administrators can install apps.")
    if not args.app:
        fail("Usage: coolcloud --install developer:app [dir=./folder]")
    widget = str(getattr(args, "type", "") or "").lower() == "widget"
    kind = "widget" if widget else ""
    if args.dir:
        result = api(config, "/api/admin/apps/install", "POST", {"dir": os.path.abspath(args.dir), "type": kind})
        print(f"\n  Installed {result['app']['name']} ({result['app']['id']})\n")
        return
    installed = api(config, "/api/admin/apps")["apps"]
    found = next((app for app in installed if app["id"] in (args.app, "cc:" + args.app)), None)
    if found:
        print(f"\n  {found['name']} is already installed" + (" (core app)." if found.get("builtin") else ".") + "\n")
        return
    result = api(config, "/api/admin/store/install", "POST", {"id": args.app, "type": kind})
    label = "widget" if (result.get("app") or {}).get("type") == "widget" else "app"
    print(f"\n  Installed {result['app']['name']} ({label}) ({result['app']['id']})\n")


def cmd_users(args):
    config = need_config()
    if (config.get("user") or {}).get("role") != "admin":
        fail("Administrator access required.")
    action = args.action or "list"
    if action == "list":
        users = api(config, "/api/admin/users")["users"]
        if not users:
            print("\n  No users yet.\n")
            return
        print(f"\n  {'USERNAME':<18}{'ROLE':<9}{'ACTIVE':<8}NAME")
        for user in users:
            print(f"  {user['username']:<18}{user['role']:<9}{'yes' if user['active'] else 'no':<8}{user['name']}")
        print()
        return
    if action == "add":
        if not args.name:
            fail("Usage: coolcloud --users add <username> password=… name=\"Sam Lee\"")
        password = args.password or getpass.getpass("New password: ")
        api(
            config,
            "/api/admin/users",
            "POST",
            {
                "username": args.name,
                "password": password,
                "name": args.display_name or args.name,
                "email": args.email or "",
                "role": "admin" if args.role == "admin" else "user",
            },
        )
        print(f"\n  Created {args.name}\n")
        return
    users = api(config, "/api/admin/users")["users"]
    target = next((u for u in users if u["username"].lower() == (args.name or "").lower()), None)
    if not target:
        fail(f'No account named "{args.name or ""}"')
    if action == "remove":
        api(config, f"/api/admin/users/{target['id']}", "DELETE")
        print(f"\n  Removed {target['username']}\n")
    elif action == "passwd":
        password = args.password or getpass.getpass(f"New password for {target['username']}: ")
        api(config, f"/api/admin/users/{target['id']}", "PATCH", {"password": password})
        print(f"\n  Password changed for {target['username']}\n")
    elif action in ("disable", "enable"):
        api(config, f"/api/admin/users/{target['id']}", "PATCH", {"active": action == "enable"})
        print(f"\n  {target['username']} {action}d.\n")
    else:
        fail("Usage: coolcloud --users list|add|remove|passwd|disable|enable")


def cmd_doc(args):
    config = need_config()
    action = args.action or "list"
    target = args.name
    if action == "list":
        data = api(config, "/api/files?path=" + urllib.parse.quote(target or ""))
        print()
        for entry in data["entries"]:
            print(f"  {'[D]' if entry['dir'] else '   '} {entry['path']}{'/' if entry['dir'] else ''}")
        if not data["entries"]:
            print("  (empty folder)")
        print()
        return
    if not target:
        fail("Usage: coolcloud --doc new|edit|cat|rm <path>")
    if action == "new":
        api(config, "/api/files/text", "PUT", {"path": target, "content": ""})
        print(f"\n  Created {target}\n")
    elif action == "cat":
        print(api(config, "/api/files/text?path=" + urllib.parse.quote(target))["content"])
    elif action == "rm":
        api(config, "/api/files?path=" + urllib.parse.quote(target), "DELETE")
        print(f"\n  Deleted {target}\n")
    elif action == "edit":
        file = api(config, "/api/files/text?path=" + urllib.parse.quote(target))
        handle, temp = tempfile.mkstemp(prefix="coolcloud-", suffix="-" + os.path.basename(target))
        os.close(handle)
        with open(temp, "w", encoding="utf-8") as stream:
            stream.write(file["content"])
        editor, ok = open_editor(temp, args.editor)
        if not ok:
            os.unlink(temp)
            fail(f"{editor} exited with an error; nothing uploaded.")
        with open(temp, "r", encoding="utf-8") as stream:
            content = stream.read()
        os.unlink(temp)
        if content == file["content"]:
            print("\n  No changes.\n")
            return
        api(config, "/api/files/text", "PUT", {"path": target, "content": content})
        print(f"\n  Saved {target}\n")
    else:
        fail("Usage: coolcloud --doc new|edit|cat|rm <path>")


def cmd_config(args):
    action = args.action or "show"
    base = os.path.abspath(args.dir or os.getcwd())
    config_path = os.path.join(base, "config.json")
    if action == "path":
        print(config_path)
        return
    if not os.path.exists(config_path):
        fail(f"No config.json at {config_path}\n  Run this inside an instance, or pass --dir.")
    if action == "show":
        with open(config_path, "r", encoding="utf-8") as handle:
            print(handle.read())
    elif action == "edit":
        editor, ok = open_editor(config_path, args.editor)
        print(f"\n  Edited with {editor}" + ("" if ok else " (non-zero exit)") + "\n")
    else:
        fail('Unknown config action. Try "show", "edit" or "path".')


def print_help():
    print(
        f"""
  CoolCloud CLI {VERSION}

  Install and run (inside a CoolCloud checkout):
    coolcloud.py --install              prints how to run the full installer
    coolcloud.py --start                prints the start command

  Remote server:
    --login [--server=URL] [--user=NAME]
    --logout
    --status

  Apps (admin):
    --install developer:app [dir=./folder]

  Accounts (admin):
    --users list
    --users add sam password=... name="Sam Lee" [--role=admin] [--email=...]
    --users passwd sam
    --users disable sam
    --users remove sam

  Documents:
    --doc list [folder]
    --doc new notes.md
    --doc edit notes.md
    --doc cat notes.md
    --doc rm notes.md

  Configuration (local instance):
    --config show | edit | path [--dir=/path/to/instance]

  Examples:
    python3 coolcloud.py --login
    python3 coolcloud.py --status
    python3 coolcloud.py --install acme:notes
    python3 coolcloud.py --install acme:clock !type=widget
    python3 coolcloud.py --doc edit documents/plan.md
"""
    )


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--logout", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--install", nargs="?", const=True)
    parser.add_argument("--users", nargs="?", const="list")
    parser.add_argument("--doc", nargs="?", const="list")
    parser.add_argument("--config", nargs="?", const="show")
    parser.add_argument("--start", action="store_true")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--help", action="store_true")
    parser.add_argument("--server")
    parser.add_argument("--user")
    parser.add_argument("--password")
    parser.add_argument("--name")
    parser.add_argument("--display-name", dest="display_name")
    parser.add_argument("--email")
    parser.add_argument("--role")
    parser.add_argument("--dir")
    parser.add_argument("--editor")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("app", nargs="?")
    args, extra = parser.parse_known_args()

    def apply_modifier(item):
        key, _, value = item[1:].partition("=")
        if key:
            setattr(args, key.replace("-", "_"), value or True)

    # An argparse positional may swallow "!type=widget" when --install has a
    # value, so inspect both places the token can land.
    if args.app and str(args.app).startswith("!"):
        apply_modifier(str(args.app))
        args.app = None
    for item in extra:
        if item.startswith("!"):
            apply_modifier(item)
        elif item.startswith("dir="):
            args.dir = item[4:]
        elif item.startswith("editor="):
            args.editor = item[7:]
        elif item.startswith("--install="):
            args.install = item.split("=", 1)[1]
        elif not item.startswith("-") and not args.app:
            args.app = item
    if args.app and str(args.app).startswith("dir="):
        args.dir = args.app[4:]
        args.app = None

    if args.version:
        print(VERSION)
    elif args.help or len(sys.argv) == 1:
        print_help()
    elif args.logout:
        try:
            os.unlink(HOME)
            print("\n  CLI session cleared.\n")
        except OSError:
            print("\n  Nothing to clear.\n")
    elif args.login:
        cmd_login(args)
    elif args.status:
        cmd_status(args)
    elif args.start:
        print("\n  Start the instance with: cd <instance> && ./start.sh   (or start.cmd)\n")
    elif args.install is not None:
        if args.install is True:
            print("\n  Full installation needs the Node.js installer:\n"
                  "    git clone <repo> && cd coolcloud && node bin/coolcloud.js --install\n")
        else:
            args.app = args.install
            cmd_install(args)
    elif args.users is not None:
        args.action = args.users
        cmd_users(args)
    elif args.doc is not None:
        args.action = args.doc
        args.name = args.app or args.name
        cmd_doc(args)
    elif args.config is not None:
        args.action = args.config
        cmd_config(args)
    else:
        print_help()


if __name__ == "__main__":
    main()
