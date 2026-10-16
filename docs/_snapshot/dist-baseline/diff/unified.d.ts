/**
 * 轻量 unified diff（HITL 预览用，对齐 Cursor/Claude 的「先看 diff 再接受」）
 */
export declare function unifiedDiff(filePath: string, before: string, after: string): string;
export declare function summarizeDiff(diff: string): {
    additions: number;
    deletions: number;
};
