/**
 * 层5：todo 日志放哪 —— 单独一个模块，因为「谁来决定路径」这件事
 * 在 monorepo 里其实不显然：
 *
 * - `node packages/core/dist/demo.js` 的 cwd 是仓库根；
 * - Next dev server 的 cwd 是 `apps/web`；
 * - 单测的 cwd 是仓库根，但测试自己要临时目录。
 *
 * 所以默认路径不跟 cwd 硬绑定：从 cwd 往上找 **第一个带 `workspaces` 的 package.json**
 * 当仓库根，日志落在 `<仓库根>/data/loom-store/todos`。找不到就退化成
 * `<cwd>/data/loom-store/todos`。`LOOM_TODO_DIR` 环境变量优先级最高
 * （测完想清空就 `rm -rf data/loom-store`，或指到 tmp）。
 *
 * 想退回纯内存（比如 CI 里不想落任何文件）：`LOOM_TODO_STORE=memory`。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 从 start 往上找带 workspaces 的 package.json，返回它所在目录 */
export function findWorkspaceRoot(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown };
        if (parsed.workspaces !== undefined) return current;
      } catch {
        // 坏 JSON 当没看见，继续往上
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 默认 todo 日志目录：`LOOM_TODO_DIR` > 仓库根 > cwd */
export function resolveTodoStoreDir(cwd: string = process.cwd()): string {
  const explicit = process.env.LOOM_TODO_DIR;
  if (explicit && explicit.trim() !== "") return resolve(explicit);
  const root = findWorkspaceRoot(cwd) ?? resolve(cwd);
  return join(root, "data", "loom-store", "todos");
}

/** 是否要用落盘 store（`LOOM_TODO_STORE=memory` 可关掉） */
export function todoStoreIsPersistent(): boolean {
  const mode = (process.env.LOOM_TODO_STORE ?? "").trim().toLowerCase();
  return mode !== "memory" && mode !== "off" && mode !== "0";
}
