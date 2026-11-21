HELLO — A MINIMAL COOLCLOUD APP
===============================

This folder is a complete third-party app.

Install it locally:

    coolcloud --install example:hello dir=./examples/hello-app

Or copy the folder into your instance and install by name:

    cp -r examples/hello-app <instance>/data/apps/example/hello
    coolcloud --install example:hello

What it demonstrates
--------------------
* manifest.json with id, icon, entry and permissions
* a web entry point that reuses the CoolCloud design system
* calling the normal HTTP API with the signed-in session cookie
* no build step, no bundler, no framework required

Extend it
---------
The app is served at /app-assets/<developer>/<name>/web/index.html inside a
tab iframe. Everything on the same origin, including /api/*, works with
fetch(). Read docs/BUILDING-APPS.txt for the full walkthrough and
docs/DESIGN-SYSTEM.txt for tokens and components.

Security
--------
Third-party apps run with the signed-in user's permissions. Only install code
you trust; review the repository before an admin clicks Install.
