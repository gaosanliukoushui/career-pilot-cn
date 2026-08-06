# CareerPilot CN Desktop

This package turns the existing local-first Next.js workbench into a Windows
desktop application. It starts the bundled production web server on an unused
loopback port, opens it in a hardened Electron window, and stops the server when
the app exits.

The application does not create a second data store. It reads and writes the
same CareerPilot CN project directory as the CLI, selected in this order:

1. `CAREER_OPS_ROOT` environment variable;
2. the workspace previously selected in the app;
3. the project directory captured when the installer was built.

Use **CareerPilot CN → 选择项目目录…** if the checkout is moved.

## Build on Windows

```powershell
npm run desktop:install
npm run desktop:dist
```

The NSIS installer is written to `desktop/dist/`. It installs per user and
creates Desktop and Start Menu shortcuts.
