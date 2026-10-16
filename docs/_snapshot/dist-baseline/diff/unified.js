/**
 * 轻量 unified diff（HITL 预览用，对齐 Cursor/Claude 的「先看 diff 再接受」）
 */
export function unifiedDiff(filePath, before, after) {
    const a = before.replace(/\r\n/g, "\n").split("\n");
    const b = after.replace(/\r\n/g, "\n").split("\n");
    const header = [
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -1,${Math.max(a.length, 1)} +1,${Math.max(b.length, 1)} @@`,
    ];
    // 简单 LCS 太重；MVP 用「整段替换」可视化 + 逐行标记增删
    const lines = [...header];
    const max = Math.max(a.length, b.length);
    if (before === "" && after) {
        for (const line of b)
            lines.push(`+${line}`);
        return lines.join("\n");
    }
    if (after === "" && before) {
        for (const line of a)
            lines.push(`-${line}`);
        return lines.join("\n");
    }
    // Myers-lite：按行对齐，相同保留，不同先删后增
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            lines.push(` ${a[i]}`);
            i++;
            j++;
            continue;
        }
        // 向前看是否能再对齐
        let found = false;
        for (let k = 1; k <= 8 && !found; k++) {
            if (i + k < a.length && j < b.length && a[i + k] === b[j]) {
                for (let t = 0; t < k; t++)
                    lines.push(`-${a[i + t]}`);
                i += k;
                found = true;
            }
            else if (j + k < b.length && i < a.length && a[i] === b[j + k]) {
                for (let t = 0; t < k; t++)
                    lines.push(`+${b[j + t]}`);
                j += k;
                found = true;
            }
        }
        if (found)
            continue;
        if (i < a.length) {
            lines.push(`-${a[i++]}`);
        }
        if (j < b.length) {
            lines.push(`+${b[j++]}`);
        }
        if (lines.length > max + 40) {
            lines.push(" …(diff truncated)");
            break;
        }
    }
    return lines.join("\n");
}
export function summarizeDiff(diff) {
    let additions = 0;
    let deletions = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++"))
            additions++;
        if (line.startsWith("-") && !line.startsWith("---"))
            deletions++;
    }
    return { additions, deletions };
}
