# Vercel Menubar Status App

A tiny macOS menu bar app that shows the status of your Vercel deployments as a
traffic light. Built with [tinyjs](https://tinyjs.app): a JavaScript backend and a
native webview, shipping as a ~6 MB `.app`.

| Light | Meaning |
| ----- | ------- |
| 🟢 | The latest deployment of every followed project is ready |
| 🟡 | A deployment is building or queued |
| 🔴 | A followed project's latest deployment failed |
| ⚪️ | Signed out, no deployments, or Vercel can't be reached |

## Features

- **Menu bar light.** Lives in the menu bar only, with no Dock icon.
- **Per-project menu.** Click the dot to see each project's latest deployment and how long ago it
  ran. Click a project to open it in Vercel.
- **Choose what the light follows.** Pick all projects, one project, or any mix, either from
  **Light follows ▸** in the menu or with the checkboxes in the settings window.
- **Team scopes.** Switch between your personal account and any team.
- **Production only.** Optionally ignore preview deployments.
- **Notifications.** Get a macOS notification when a deployment the app saw building
  finishes or fails.
- **Adaptive polling.** Checks every 10s while something is building and every 60s otherwise,
  and refreshes after the Mac wakes from sleep.

## Signing in

The app authenticates with a Vercel **personal access token**:

1. Create a token at <https://vercel.com/account/tokens>. Scoping it to the team you want to
   watch is enough.
2. Paste it into the window that opens on first launch.

The token is stored in the **macOS Keychain**, never written to disk in plain text, and is only
ever sent to `api.vercel.com`. Use **Sign out** to remove it from the Keychain.

## Requirements

- macOS
- [tinyjs](https://tinyjs.app) 0.41.0 or newer:

  ```sh
  curl -fsSL https://tinyjs.app/install | sh
  ```

## Run in development

```sh
git clone https://github.com/agustind/vercel-menubar-status-app.git
cd vercel-menubar-status-app
tinyjs dev
```

`tinyjs dev` launches the app with hot reload. Edit files in `src/` and it restarts itself.
Set `TINYJS_DEBUG=1` to log the traffic between the backend and the native side.

## Build the app

```sh
tinyjs build
```

This produces `dist/Vercel Menubar Status App.app` (ad-hoc signed). Drag it into
`/Applications` and open it. To start it at login, add it under
**System Settings → General → Login Items**.

The first time the built app runs, macOS asks for Keychain access, because it's a different
binary from the dev build.

## Project layout

```
tinyjs.json          app config (name, bundle id, menu-bar-only "accessory" activation)
src/main.js          backend: Keychain token, Vercel API polling, tray icon + menu
src/icons.js         the four tray dots as base64 PNGs
src/frontend/        sign-in / settings window (HTML, CSS, JS)
types/               editor type definitions for the tinyjs APIs
```

## How the status is computed

The app fetches the 100 most recent deployments in the selected scope (`GET /v6/deployments`)
and keeps the newest non-cancelled deployment per project. From the projects the light
follows:

- any `ERROR` gives red
- otherwise any `BUILDING`, `QUEUED` or `INITIALIZING` gives yellow
- otherwise green, or gray if there's nothing to show
