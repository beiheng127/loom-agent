/**
 * 假动作审计：找出 mock 剧本里「声称做了某事、却没有工具调用背书」的分支。
 *
 * 背景：`mock.ts` 的 `call()` 在工具没被注入时**静默返回 null**（这是为了不触发
 * SDK 的 NoSuchTool）。于是剧本很容易写成「结论里说做了 X，但那一轮根本没调 X」——
 * 离线演示看起来一切正常，实际是在表演。
 *
 * 判定规则（保守，宁少报不误报）：
 *   case 里有 call("...")，且结论文案里出现动作性措辞，但整块**没有任何 has() 守卫**
 *   → 这个分支的动作声称无法被保证，标记为疑似。
 *
 * 用法：node scripts/probes/audit-mock-claims.mjs
 * 退出码：0 = 无疑似；1 = 有疑似（可用于门禁）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// 可选第一个参数覆盖目标文件 —— 便于对「故意改坏的副本」跑一遍，
// 证明这个审计本身不是永远返回 0 的空壳。
const TARGET = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "packages/core/src/loop/mock.ts");

const src = fs.readFileSync(TARGET, "utf8");

// 动作性措辞：说了就等于宣称「我做过这件事」
const ACTION_CLAIMS = [
  "写入",
  "已写",
  "已提出",
  "已提议",
  "落盘",
  "待批准",
  "已派",
  "派出",
  "已调用",
  "已执行",
];

const caseRe = /case "([a-z_0-9]+)":([\s\S]*?)break;/g;
const suspects = [];
let total = 0;
let guarded = 0;

/**
 * 判「这一支有没有把工具缺失的情况处理掉」。
 *
 * 两种守卫星：
 *   1. `has("tool_name")` —— 直接用工具名问；
 *   2. 先 `const t = 找工具()`，再 `if (!t) { ... break; }` —— 间接守卫
 *      （`delegate_fanout` 用的就是这种：委派工具是动态挑出来的，
 *        没法用字面量调 has()）。
 * 缺了守卫，说明「工具没注入时结论文案不改口」——那就是假动作。
 */
function hasMissingToolBranch(body) {
  if (/has\(/.test(body)) return true;
  const declared = [...body.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=/g)].map((x) => x[1]);
  return declared.some((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`if\\s*\\(\\s*!\\s*${escaped}\\s*\\)`).test(body);
  });
}

let m;
while ((m = caseRe.exec(src))) {
  total++;
  const name = m[1];
  const body = m[2];

  const guardedHere = hasMissingToolBranch(body);
  if (guardedHere) guarded++;

  const callsTool = /call\("/.test(body);
  const claimed = ACTION_CLAIMS.filter((w) => body.includes(w));

  if (callsTool && claimed.length > 0 && !guardedHere) {
    suspects.push({ name, claims: claimed });
  }
}

console.log(`审计目标: ${path.relative(ROOT, TARGET)}`);
console.log(`case 总数 = ${total}，带缺失工具分支 = ${guarded}`);
console.log("");

if (suspects.length === 0) {
  console.log("✅ 未发现「声称做了但没守卫」的分支");
  process.exit(0);
}

console.log(`❌ 疑似假动作 ${suspects.length} 处：`);
for (const s of suspects) {
  console.log(`   - case "${s.name}"  声称: ${s.claims.join(" / ")}`);
}
console.log("");
console.log("修法：该分支的结论文案必须按 has(\"<工具名>\") 分叉，");
console.log("      没注入就如实说明「未注入，因此没有做」——不要演。");
process.exit(1);
