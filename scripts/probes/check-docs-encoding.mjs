import fs from "node:fs";

const ROOT = "C:/Users/ruia3/Desktop/test/agent";
const marks = ["鏈湴", "鈥", "锛", "涓?", "鐨?", "鏇存柊", "鈹?", "鎺?", "寰堝"];

for (const rel of ["README.md", "docs/PROGRESS.md", "docs/HARNESS-P1.md"]) {
  const p = `${ROOT}/${rel}`;
  const s = fs.readFileSync(p, "utf8");
  const hit = marks.filter((m) => s.includes(m));
  console.log(
    `${rel.padEnd(20)} bytes=${Buffer.byteLength(s)} FFFD=${(s.match(/\uFFFD/g) || []).length} lines=${s.split("\n").length} mojibake=${JSON.stringify(hit)}`,
  );
}

// 还要确认没有别的 md 被顺手改坏（对比 mtime 与 BOM）
const all = [];
function walk(d, depth = 0) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", ".git"].includes(e.name)) continue;
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name.endsWith(".md")) all.push(p);
  }
}
walk(ROOT);
console.log(`\n=== 全仓 .md（${all.length} 个）BOM 抽查 ===`);
for (const p of all) {
  const b = fs.readFileSync(p);
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const s = b.toString("utf8");
  const fffd = (s.match(/\uFFFD/g) || []).length;
  const bad = marks.filter((m) => s.includes(m));
  if (bom || fffd > 0 || bad.length) {
    console.log(`  ⚠ ${p.replace(ROOT + "/", "")} bom=${bom} fffd=${fffd} mojibake=${JSON.stringify(bad)}`);
  }
}
console.log("（上面没有 ⚠ 行即全部干净）");
