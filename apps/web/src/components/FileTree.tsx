"use client";

import { useEffect, useState } from "react";

export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
};

function Node({
  node,
  depth,
  selected,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  selected?: string;
  onOpen: (path: string, type: "file" | "dir") => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isDir = node.type === "dir";
  const active = selected === node.path;

  return (
    <div>
      <button
        type="button"
        className={`tree-row ${active ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => {
          if (isDir) setOpen((v) => !v);
          onOpen(node.path, node.type);
        }}
      >
        <span className="tree-mark">{isDir ? (open ? "▾" : "▸") : "·"}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {isDir && open
        ? (node.children ?? []).map((c) => (
            <Node
              key={c.path}
              node={c}
              depth={depth + 1}
              selected={selected}
              onOpen={onOpen}
            />
          ))
        : null}
    </div>
  );
}

export function FileTree({
  workspace,
  selected,
  onPickFile,
}: {
  workspace: string;
  selected?: string;
  onPickFile: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    void fetch(
      `/api/workspace/tree?workspace=${encodeURIComponent(workspace)}&depth=3`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setNodes(d.nodes ?? []);
      })
      .catch((e) => setError(String(e)));
  }, [workspace]);

  return (
    <div className="file-tree">
      <div className="col-hd">Explorer</div>
      <div className="col-bd tree-scroll">
        {error ? <div className="empty">{error}</div> : null}
        {nodes.length === 0 && !error ? (
          <div className="empty">空工作区或加载中…</div>
        ) : null}
        {nodes.map((n) => (
          <Node
            key={n.path}
            node={n}
            depth={0}
            selected={selected}
            onOpen={(p, t) => {
              if (t === "file") onPickFile(p);
            }}
          />
        ))}
      </div>
    </div>
  );
}
