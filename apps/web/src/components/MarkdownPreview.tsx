"use client";

import { Fragment, useMemo, type ReactNode } from "react";

function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const token = match[0]!;
    if (token.startsWith("`")) {
      parts.push(
        <code key={`${keyPrefix}-c-${i++}`}>{token.slice(1, -1)}</code>,
      );
    } else if (token.startsWith("**")) {
      parts.push(
        <strong key={`${keyPrefix}-b-${i++}`}>{token.slice(2, -2)}</strong>,
      );
    } else if (token.startsWith("*")) {
      parts.push(<em key={`${keyPrefix}-e-${i++}`}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

function parseBlocks(source: string, maxLines?: number): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const limited = maxLines ? lines.slice(0, maxLines) : lines;
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < limited.length) {
    const line = limited[i] ?? "";

    if (line.startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < limited.length && !(limited[i] ?? "").startsWith("```")) {
        code.push(limited[i] ?? "");
        i += 1;
      }
      if (i < limited.length) i += 1;
      blocks.push(
        <pre key={`b-${key++}`} className="md-code">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      const Tag = (`h${Math.min(level + 2, 6)}` as "h3" | "h4" | "h5" | "h6");
      blocks.push(
        <Tag key={`b-${key++}`} className="md-heading">
          {inlineNodes(text, `h-${key}`)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < limited.length && /^[-*]\s+/.test(limited[i] ?? "")) {
        const item = (limited[i] ?? "").replace(/^[-*]\s+/, "");
        items.push(<li key={`li-${key}-${items.length}`}>{inlineNodes(item, `ul-${key}-${items.length}`)}</li>);
        i += 1;
      }
      blocks.push(
        <ul key={`b-${key++}`} className="md-list">
          {items}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < limited.length && /^\d+\.\s+/.test(limited[i] ?? "")) {
        const item = (limited[i] ?? "").replace(/^\d+\.\s+/, "");
        items.push(<li key={`li-${key}-${items.length}`}>{inlineNodes(item, `ol-${key}-${items.length}`)}</li>);
        i += 1;
      }
      blocks.push(
        <ol key={`b-${key++}`} className="md-list ordered">
          {items}
        </ol>,
      );
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (
      i < limited.length &&
      (limited[i] ?? "").trim() &&
      !(limited[i] ?? "").startsWith("#") &&
      !(limited[i] ?? "").startsWith("```") &&
      !/^[-*]\s+/.test(limited[i] ?? "") &&
      !/^\d+\.\s+/.test(limited[i] ?? "")
    ) {
      para.push(limited[i] ?? "");
      i += 1;
    }
    blocks.push(
      <p key={`b-${key++}`} className="md-para">
        {inlineNodes(para.join(" "), `p-${key}`)}
      </p>,
    );
  }

  return blocks;
}

export function MarkdownPreview({
  source,
  className = "",
  maxLines,
  compact = false,
  truncated,
}: {
  source: string;
  className?: string;
  maxLines?: number;
  compact?: boolean;
  truncated?: boolean;
}) {
  const blocks = useMemo(
    () => parseBlocks(source, maxLines),
    [source, maxLines],
  );

  return (
    <div
      className={`md-preview ${compact ? "compact" : ""} ${className}`.trim()}
    >
      {blocks.map((block, idx) => (
        <Fragment key={idx}>{block}</Fragment>
      ))}
      {truncated ? <span className="md-truncated">…</span> : null}
    </div>
  );
}
