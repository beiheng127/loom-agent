"use client";

export function DiffBlock({
  path,
  diff,
  additions,
  deletions,
}: {
  path: string;
  diff?: string;
  additions?: number;
  deletions?: number;
}) {
  if (!diff) return null;
  return (
    <div className="diff-block">
      <div className="diff-hd">
        <span className="mono">{path}</span>
        <span className="badge">
          +{additions ?? 0} / -{deletions ?? 0}
        </span>
      </div>
      <pre className="diff-body">
        {diff.split("\n").map((line, i) => {
          let cls = "diff-ctx";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
          else if (line.startsWith("-") && !line.startsWith("---"))
            cls = "diff-del";
          else if (line.startsWith("@@")) cls = "diff-hunk";
          return (
            <div key={i} className={cls}>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
