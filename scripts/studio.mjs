#!/usr/bin/env node
/**
 * Loom Studio 启动器：强制 Node ≥20，避免 nvm 旧 Node/npm6 导致
 * `npm exec --workspace` 不可用或 build 套娃。
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BREW_NODE = "/opt/homebrew/opt/node@20/bin/node";
const BREW_NPM = "/opt/homebrew/opt/node@20/bin/npm";
const NVM_NODE20 = path.join(
  os.homedir(),
  ".nvm/versions/node/v20.20.2/bin/node",
);
const NVM_NPM20 = path.join(
  os.homedir(),
  ".nvm/versions/node/v20.20.2/bin/npm",
);
const PORT = process.env.PORT || "3010";

function log(msg) {
  console.log(`[loom] ${msg}`);
}

function fail(msg) {
  console.error(`[loom] ✗ ${msg}`);
  process.exit(1);
}

function isElectronBin(p) {
  // macOS: Electron.app/Contents/MacOS/Electron；Windows: electron\\dist\\electron.exe
  return /electron/i.test(p);
}

function runtimeEnv(node) {
  // 用 electron 二进制充当 node 时，必须设 ELECTRON_RUN_AS_NODE，
  // 否则 electron 会把传入的脚本当成 GUI 应用启动、且不支持 -p 等 node 参数
  return {
    ...process.env,
    ...(isElectronBin(node) ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
}

function pickRuntime() {
  if (fs.existsSync(BREW_NODE) && os.arch() === "arm64") {
    return { node: BREW_NODE, npm: BREW_NPM, label: "homebrew node@20" };
  }
  if (fs.existsSync(NVM_NODE20)) {
    return { node: NVM_NODE20, npm: NVM_NPM20, label: "nvm node v20.20.2" };
  }
  if (isElectronBin(process.execPath)) {
    // 由 Electron（npm run desktop）间启动：优先用 PATH 上的真实 node
    return { node: "node", npm: "npm", label: "PATH node" };
  }
  return {
    node: process.execPath,
    npm: "npm",
    label: "current PATH node",
  };
}

function runNode(node, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, {
      cwd: opts.cwd ?? ROOT,
      stdio: "inherit",
      env: {
        ...runtimeEnv(node),
        PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}`));
    });
    child.on("error", reject);
  });
}

function killPort(port) {
  try {
    if (process.platform === "win32") {
      // Windows 没有 lsof：用 netstat 找 LISTENING 的 PID，再 taskkill
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split("\n")) {
        const m = line
          .trim()
          .match(/^TCP\s+\S*?:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === Number(port)) pids.add(m[2]);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          log(`已结束占用 ${port} 的进程 PID ${pid}`);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
    }).trim();
    if (!out) return;
    for (const pid of out.split("\n")) {
      try {
        process.kill(Number(pid), "SIGTERM");
        log(`已结束占用 ${port} 的进程 PID ${pid}`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* nothing listening */
  }
}

async function main() {
  process.chdir(ROOT);
  let { node, label } = pickRuntime();
  let ver;
  try {
    ver = execSync(`"${node}" -p "process.version"`, {
      encoding: "utf8",
      env: runtimeEnv(node),
    }).trim();
  } catch (e) {
    // PATH 上找不到 node（如打包后的 Electron 环境）：
    // 退回 electron 本体，以 ELECTRON_RUN_AS_NODE 模式当 node 用
    if (node === "node" && isElectronBin(process.execPath)) {
      node = process.execPath;
      label = "electron (RUN_AS_NODE)";
      ver = execSync(`"${node}" -p "process.version"`, {
        encoding: "utf8",
        env: runtimeEnv(node),
      }).trim();
    } else {
      throw e;
    }
  }
  const major = Number(ver.replace(/^v/, "").split(".")[0]);
  log(`使用 ${label}: ${ver}`);

  if (major < 20) {
    fail(
      `需要 Node ≥ 20，当前 ${ver}。\n` +
      `  请执行其一：\n` +
      `  export PATH="/opt/homebrew/opt/node@20/bin:$PATH"\n` +
      `  或 nvm use 20\n` +
      `然后再 npm run studio`,
    );
  }

  const tscJs = path.join(
    ROOT,
    "node_modules/typescript/bin/tsc",
  );
  const nextBin = path.join(ROOT, "node_modules/next/dist/bin/next");
  if (!fs.existsSync(tscJs)) {
    fail("未找到 typescript。请先在 agent 目录执行: npm install");
  }
  if (!fs.existsSync(nextBin)) {
    fail("未找到 next。请先在 agent 目录执行: npm install");
  }

  killPort(PORT);

  log("编译 @loom/core …");
  await runNode(node, [tscJs, "-p", "packages/core/tsconfig.json"]);

  log(`启动 Web Studio → http://localhost:${PORT}`);
  await runNode(node, [nextBin, "dev", "-p", PORT], {
    cwd: path.join(ROOT, "apps/web"),
  });
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
