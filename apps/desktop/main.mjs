import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(__dirname, "../..");
const LOOM_URL = process.env.LOOM_URL || "http://127.0.0.1:3010";
const LOOM_AUTO_STUDIO = process.env.LOOM_AUTO_STUDIO !== "0";

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let studioChild = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isStudioUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(LOOM_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok || res.status === 404 || res.status === 200;
  } catch {
    return false;
  }
}

function pickNodeBin() {
  const brew = "/opt/homebrew/opt/node@20/bin/node";
  if (fs.existsSync(brew)) return brew;
  // macOS 路径含 "Electron.app"，Windows 是小写 "electron.exe"，必须忽略大小写
  return /electron/i.test(process.execPath) ? "node" : process.execPath;
}

function startStudioProcess() {
  if (studioChild && !studioChild.killed) return;
  const node = pickNodeBin();
  const studioScript = path.join(AGENT_ROOT, "scripts/studio.mjs");
  if (!fs.existsSync(studioScript)) {
    console.error("[loom-desktop] studio.mjs not found:", studioScript);
    return;
  }
  console.log("[loom-desktop] spawning studio…", node, studioScript);
  studioChild = spawn(node, [studioScript], {
    cwd: AGENT_ROOT,
    env: { ...process.env, PORT: process.env.PORT || "3010" },
    stdio: "inherit",
    detached: false,
  });
  studioChild.on("exit", (code) => {
    console.log("[loom-desktop] studio exited", code);
    studioChild = null;
  });
}

async function ensureStudioAndLoad() {
  if (await isStudioUp()) {
    await mainWindow?.loadURL(LOOM_URL);
    return;
  }
  if (!LOOM_AUTO_STUDIO) {
    await mainWindow?.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<h2 style="font-family:system-ui;padding:28px">无法连接 ${LOOM_URL}<br/>请先运行 npm run studio<br/><small>或设置 LOOM_AUTO_STUDIO=1</small></h2>`,
      )}`,
    );
    return;
  }
  await mainWindow?.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<h2 style="font-family:system-ui;padding:28px">正在启动 Loom Studio…<br/><small>${LOOM_URL}</small></h2>`,
    )}`,
  );
  startStudioProcess();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await isStudioUp()) {
      await mainWindow?.loadURL(LOOM_URL);
      return;
    }
  }
  await mainWindow?.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<h2 style="font-family:system-ui;padding:28px">启动超时<br/>请手动在仓库运行 npm run studio<br/>再重开 Desktop</h2>`,
    )}`,
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "Loom Agent",
    backgroundColor: "#12141a",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void ensureStudioAndLoad();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.handle("loom:openDirectory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (studioChild && !studioChild.killed) {
    try {
      studioChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== "darwin") app.quit();
});
