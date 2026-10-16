import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";

/**
 * 直接用 next dev（npm run dev:web）时，studio.mjs 的加载器不会执行；
 * Next 只自动读取 apps/web 下的 .env*，这里补加载仓库根 .env，
 * 保证 DEEPSEEK_API_KEY / OPENAI_API_KEY 等在服务端路由中可见。
 */
function loadRootEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "..", "..", ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const cleaned = line.startsWith("export ")
        ? line.slice("export ".length).trim()
        : line;
      const eq = cleaned.indexOf("=");
      if (eq === -1) continue;
      const key = cleaned.slice(0, eq).trim();
      let val = cleaned.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && (process.env[key] === undefined || process.env[key] === "")) {
        process.env[key] = val;
      }
    }
  }
}
loadRootEnv();

const nextConfig: NextConfig = {
  transpilePackages: ["@loom/core"],
  serverExternalPackages: ["ai", "@ai-sdk/openai"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
