const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const {
  isCareerPilotRoot,
  resolveProjectRoot,
  saveRoot,
} = require("./lib/workspace.cjs");

const APP_NAME = "CareerPilot CN";
const START_TIMEOUT_MS = 45_000;
let mainWindow = null;
let serverProcess = null;
let serverOrigin = "";
let quitting = false;

app.setName(APP_NAME);
app.setAppUserModelId("cn.careerpilot.desktop");

function appAsset(relative) {
  if (app.isPackaged) return path.join(process.resourcesPath, relative);
  return path.join(__dirname, "..", relative);
}

function packagedConfigFile() {
  return path.join(__dirname, "build-config.json");
}

function standaloneServerFile() {
  return app.isPackaged
    ? appAsset(path.join("web", "server.js"))
    : path.join(__dirname, "..", "web", ".next", "standalone", "server.js");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForServer(url, child) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() - startedAt >= START_TIMEOUT_MS) {
        reject(new Error("本地服务启动超时。"));
        return;
      }
      setTimeout(attempt, 250);
    };
    const attempt = () => {
      if (!child || child.exitCode !== null) {
        reject(new Error("本地服务在启动完成前退出。"));
        return;
      }
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.setTimeout(1_500, () => request.destroy());
      request.on("error", retry);
    };
    attempt();
  });
}

function stopServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.exitCode !== null) return;
  child.kill();
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_000).unref();
}

async function chooseProjectRoot() {
  const selected = await dialog.showOpenDialog({
    title: "选择 CareerPilot CN 项目目录",
    properties: ["openDirectory"],
    buttonLabel: "使用此目录",
    message: "请选择包含 careerpilot.mjs 的 CareerPilot CN 项目目录。",
  });
  if (selected.canceled || !selected.filePaths[0]) return "";
  const root = selected.filePaths[0];
  if (!isCareerPilotRoot(root)) {
    await dialog.showMessageBox({
      type: "error",
      title: "目录不正确",
      message: "这里不是有效的 CareerPilot CN 项目目录。",
      detail: "请选择包含 careerpilot.mjs、package.json 和 config/cn-campus.defaults.yml 的目录。",
    });
    return chooseProjectRoot();
  }
  saveRoot(app.getPath("userData"), root);
  return root;
}

async function findProjectRoot() {
  const resolved = resolveProjectRoot({
    userDataDir: app.getPath("userData"),
    packagedConfigFile: packagedConfigFile(),
  });
  return resolved || chooseProjectRoot();
}

function createWindow() {
  const icon = path.join(__dirname, "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    backgroundColor: "#f4efe7",
    icon: fs.existsSync(icon) ? icon : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (serverOrigin && url.startsWith(serverOrigin)) {
      mainWindow?.loadURL(url);
      return { action: "deny" };
    }
    openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!serverOrigin || url.startsWith(serverOrigin)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  return mainWindow;
}

function openExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed or non-web protocols from rendered job content.
  }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "CareerPilot CN",
      submenu: [
        {
          label: "重新加载",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.reload(),
        },
        {
          label: "选择项目目录…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: async () => {
            const root = await chooseProjectRoot();
            if (!root) return;
            stopServer();
            await startApplication(root);
          },
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "查看",
      submenu: [
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "resetZoom", label: "重置缩放" },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
  ]));
}

async function startApplication(projectRoot) {
  const entry = standaloneServerFile();
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到桌面 Web 服务：${entry}`);
  }
  const port = await getFreePort();
  serverOrigin = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      CAREER_OPS_ROOT: projectRoot,
      NODE_PATH: path.join(path.dirname(entry), "runtime_modules"),
    },
  });
  serverProcess.stdout.on("data", (chunk) => process.stdout.write(`[web] ${chunk}`));
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(`[web] ${chunk}`));
  await waitForServer(`${serverOrigin}/api/doctor`, serverProcess);
  const window = mainWindow || createWindow();
  await window.loadURL(serverOrigin);
  window.show();
}

async function boot() {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    app.quit();
    return;
  }
  installMenu();
  try {
    await startApplication(projectRoot);
  } catch (error) {
    stopServer();
    await dialog.showMessageBox({
      type: "error",
      title: `${APP_NAME} 启动失败`,
      message: "桌面应用未能启动本地服务。",
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(boot);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  if (quitting) return;
  quitting = true;
  stopServer();
});
