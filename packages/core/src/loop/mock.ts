// 层1-C 备注：V3 原生类型不在 `ai` 包的 export 里（`ai` 只再导出了 JSONSchema7），
// 得直接从 @ai-sdk/provider 取。它是 ai 的同级依赖，已显式写进 package.json。
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { nanoid } from "nanoid";
import { getDefaultJobStore } from "../jobs/store.js";
import { estimateTextTokens } from "./compact.js";
import type {
  MockScenario,
  ToolDefinition,
  ToolName,
  ToolResult,
} from "../types/index.js";

/**
 * 层1-C：mock 不再是"另一条循环"，而是"换一个模型"。
 *
 * 原来 run.ts 里 417 行的 runMockLoop 自己解析 scenario、自己调 execute、自己拼事件，
 * 等于把工具协议手写了一遍。现在改成：mock 产出一串**声明式剧本**，
 * 由一个 MockLanguageModelV3 把它当成模型的输出吐出来，
 * 真正的循环、工具派发、事件映射全走 run.ts 那一条真路径。
 *
 * 好处：mock 走的是真协议，所以"mock 能跑通"就等于"协议没问题"。
 */

/**
 * 内置工具名。剧本要靠它把「委派工具 / 插件工具」和内置工具区分开：
 * 不在这个集合里的工具，一定是运行时注入进来的。
 */
export const BUILTIN_TOOL_NAMES = new Set<string>([
  "list_dir",
  "read_file",
  "grep_files",
  "write_file",
  "fetch_url",
  "web_search",
  "run_safe_cmd",
  "todo_write",
  "job_list",
  "job_output",
  "job_kill",
]);

export type MockTurn = {
  /** 本轮先说一段话（会按 text_delta 分片发出去） */
  text?: string;
  /** 本轮要调的工具；不给则本轮是收尾 */
  tool?: {
    name: ToolName;
    args: Record<string, unknown>;
    /** 离线桩：不走真实 execute，直接把这个结果当工具返回 */
    stub?: ToolResult;
  };
  /** 收尾文本；函数形式可读到本轮之前的所有工具结果 */
  final?: string[] | ((ctx: MockScriptContext) => string[]);
  /** 需要额外抛一个 error 事件 */
  error?: string;
};

export type MockScriptContext = {
  scenario: MockScenario;
  goal: string;
  workspaceRoot: string;
  agentId: string;
  modelId: string;
  /** 到目前为止收集到的工具结果，按调用顺序 */
  results: ToolResult[];
  /** 某个工具被结果的命中数（grep_files 之类） */
  hitCount: (index: number) => number;
  step: number;
};

export type MockRuntime = {
  /** toolCallId -> 离线桩结果，run.ts 的工具包装器会查它 */
  stubs: Map<string, ToolResult>;
};

/**
 * 单次 mock 调用的 token 估算。
 *
 * 与真路径共用同一个估算器（`estimateTextTokens`）：窄字符 4 字符 ≈ 1 token，
 * 宽字符（汉字/假名/全角标点）1 字符 ≈ 1 token。离线 Demo 的计量不能比真模型虚低，
 * 否则中文剧本演示出来的 token 数是假的。
 */
export function estimateTokens(text: string): number {
  return estimateTextTokens(text);
}

/** 把整段答案拆成小块，模拟真模型的 token 级增量 */
export function chunkText(text: string, chunkSize = 24): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(text.slice(i, i + chunkSize));
  }
  return out;
}

/**
 * 声明式剧本：把原来的 if-else 大剧本整理成"每一步做什么"。
 * 不依赖真实文件系统内容（除了 grep 计数），因此离线确定性可复现。
 */
export function buildMockScript(input: {
  scenario: MockScenario;
  goal: string;
  workspaceRoot: string;
  agentId: string;
  modelId: string;
  tools: ToolDefinition[];
}): MockTurn[] {
  const { scenario, goal, tools } = input;
  const has = (n: ToolName): boolean => tools.some((t) => t.name === n);
  const turns: MockTurn[] = [];

  /**
   * 找一个委派工具：工具集里的非内置工具，就是委派工具或插件工具。
   *
   * 得先排掉 3 个控制工具（list_agents / send_message / interrupt_agent）——
   * 它们的描述里也写着「子 agent」，直接按关键词找会挑中它们，
   * 剧本就会演成「派活却调了 list_agents」这种假动作。
   */
  const SUBAGENT_CONTROL_TOOLS = new Set([
    "list_agents",
    "send_message",
    "interrupt_agent",
  ]);
  const delegationTool = (): ToolName | null => {
    const foreign = tools.filter(
      (t) => !BUILTIN_TOOL_NAMES.has(t.name) && !SUBAGENT_CONTROL_TOOLS.has(t.name),
    );
    const preferred = foreign.find((t) =>
      /子 agent|subagent|委派/i.test(t.description),
    );
    return (preferred ?? foreign[0])?.name ?? null;
  };

  /** 只在工具真的注入时才排队，避免 SDK 报 NoSuchTool */
  const call = (
    name: ToolName,
    args: Record<string, unknown>,
    stub?: ToolResult,
  ): MockTurn | null =>
    has(name) ? { tool: { name, args, ...(stub ? { stub } : {}) } } : null;

  const push = (...items: Array<MockTurn | null>): void => {
    for (const it of items) if (it) turns.push(it);
  };

  const FINAL = (lines: string[]): (ctx: MockScriptContext) => string[] =>
    lines.length ? () => lines : () => [];

  switch (scenario) {
    case "jobs_tour": {
      /**
       * 后台 job 的离线演示。演哪一出取决于**当前有没有 job**：
       *   没有 → 提一个待批准的后台命令（批准之后才真的起）；
       *   有了 → 去读它的输出。
       * 所以这个剧本可以连问两次：第一次批准，第二次看游标读出来的新增输出。
       * 这不算「同一剧本每次不一样」的侥幸——分支条件是真实状态，不是随机数。
       */
      push(call("list_dir", { path: "." }));
      const jobStore = getDefaultJobStore();
      const existing =
        jobStore.list().find((j) => j.status === "running") ?? jobStore.latest() ?? null;
      if (!has("run_safe_cmd") && !has("job_output")) {
        turns.push({
          final: ["当前 Agent 既没有 run_safe_cmd 也没有 job_output，演示不了后台 job"],
        });
      } else if (!existing) {
        if (!has("run_safe_cmd")) {
          turns.push({ final: ["当前 Agent 没有 run_safe_cmd，起不了后台 job"] });
        } else {
          push(call("run_safe_cmd", { command: "git log --oneline -n 5", background: true }));
          turns.push({
            // 结论必须看真结果：命令被白名单拒了就不许说「已提出待批准」
            // （写这个剧本时第一版用的 `git log --oneline -5` 就不在白名单里，被自己的单测抓住）
            final: (ctx) => {
              if (ctx.results.some((r) => r.pendingCmd)) {
                return [
                  "[mock jobs_tour] 已提出一个待批准的后台命令：git log --oneline -n 5",
                  "批准后右侧 Jobs 面板会出现它（不用在终端等）；再问一次这句话，我就去读它的输出。",
                ];
              }
              const why = ctx.results.find((r) => r.ok === false)?.error ?? "命令没被接受";
              return [
                `[mock jobs_tour] 后台命令没提上：${why}`,
                "换成白名单里的再来：git log --oneline -n 5 / git status / git diff。",
              ];
            },
          });
        }
      } else if (!has("job_output")) {
        turns.push({ final: ["当前 Agent 没有 job_output，读不了后台 job 的输出"] });
      } else {
        push(
          call("job_list", {}),
          call("job_output", { jobId: existing.id, wait: true, timeoutMs: 3000 }),
        );
        turns.push({
          final: [
            `[mock jobs_tour] 后台 job ${existing.id}（${existing.status}）的输出已读，见上面的工具结果`,
            "读过的不会重复吐：游标推一次就前进一次。",
          ],
        });
      }
      break;
    }

    case "list_only":
      push(call("list_dir", { path: "." }));
      turns.push({
        final: FINAL(["[mock list_only] 仅列根目录", `目标：${goal}`]),
      });
      break;

    case "cmd_hitl":
      push(call("list_dir", { path: "." }));
      if (!has("run_safe_cmd")) {
        turns.push({ final: ["当前 Agent 无 run_safe_cmd，无法演示命令 HITL"] });
      } else {
        push(call("run_safe_cmd", { command: "git status" }));
        turns.push({
          final: [
            "[mock cmd_hitl] 已提出待批准命令：git status",
            "请在 HITL 卡片批准或拒绝。",
          ],
        });
      }
      break;

    case "fetch_url_stub":
      push(
        call("fetch_url", { url: "https://example.com" }, {
          ok: true,
          data: {
            url: "https://example.com",
            excerpt:
              "Example Domain — 离线 stub：未发起真实 HTTP（fixture 模式）。",
            stub: true,
          },
        }),
      );
      turns.push({
        final: [
          "[mock fetch_url_stub] 已返回示例摘录（无外网）",
          "接入真模型后将走真实 fetch_url（含 SSRF 防护）。",
        ],
      });
      break;

    case "ask_readonly":
      push(
        call("list_dir", { path: "." }),
        call("read_file", { path: "README.md" }),
      );
      turns.push({
        final: [
          "[mock ask_readonly] Ask 模式：只读探索完成",
          "未调用 write_file / run_safe_cmd。",
          `目标：${goal}`,
        ],
      });
      break;

    case "rules_focus":
      push(call("read_file", { path: ".loom/RULES.md" }));
      turns.push({
        final: [
          "[mock rules_focus] 已阅读工作区 RULES",
          "写文件前应遵守沙箱与审批约定。",
        ],
      });
      break;

    case "todo_focus":
      push(call("read_file", { path: "TODO.md" }), call("grep_files", { query: "TODO" }));
      // 层5 的离线演示入口：只读 TODO 不算验过 todo_write。这里真调一次整表替换，
      // 让「离线也能看见 todo 投影」成立 —— 没有这一步，todo_write 在 mock 下
      // 永远走不到，只能靠单测证明它存在。
      //
      // todo_write 比别的工具多一道门槛：它需要会话归属（RunLoopInput.todo.sessionId）。
      // 没传 sessionId 时 run.ts 不会注入它，call() 会静默返回 null。所以这里的结论文案
      // 必须跟着分支走 —— 声称「已写入」但实际没调用，就是假动作（和当初把 list_agents
      // 当成委派工具是同一类问题：**话说了，事没做**）。
      if (has("todo_write")) {
        push(
          call("todo_write", {
            todos: [
              { content: "汇总 TODO.md 待办", status: "completed" },
              { content: "按优先级重排未完成项", status: "in_progress" },
              { content: "输出下一步建议", status: "pending" },
            ],
          }),
        );
        turns.push({
          final: [
            "[mock todo_focus] 已汇总 TODO.md 与 grep TODO 命中",
            "并写入 todo 列表（整表替换：1 完成 / 1 进行中 / 1 待办）。",
          ],
        });
      } else {
        turns.push({
          final: [
            "[mock todo_focus] 已汇总 TODO.md 与 grep TODO 命中。",
            "本次没有会话归属（未传 sessionId），todo_write 未注入，因此没有写入待办列表。",
          ],
        });
      }
      break;

    case "package_focus":
      push(call("read_file", { path: "package.json" }));
      turns.push({ final: ["[mock package_focus] 已阅读 package.json 依赖与脚本"] });
      break;

    case "utils_focus":
      push(
        call("read_file", { path: "src/utils.ts" }),
        call("read_file", { path: "src/index.ts" }),
      );
      turns.push({ final: ["[mock utils_focus] 已阅读 src 入口与工具函数"] });
      break;

    case "api_docs":
      push(call("read_file", { path: "docs/API.md" }));
      turns.push({ final: ["[mock api_docs] 已阅读 docs/API.md"] });
      break;

    case "env_audit":
      push(
        call("grep_files", { query: "sk-" }),
        call("grep_files", { query: "password" }),
        call("read_file", { path: ".env.example" }),
      );
      turns.push({
        final: [
          "[mock env_audit] 已扫描疑似密钥痕迹并阅读 .env.example",
          "假密钥仅作演示，勿提交真凭证。",
        ],
      });
      break;

    case "multi_grep":
      push(
        call("grep_files", { query: "export" }),
        call("grep_files", { query: "function" }),
        call("grep_files", { query: "TODO" }),
      );
      turns.push({ final: ["[mock multi_grep] 多关键词扫描完成"] });
      break;

    case "skill_tour":
      push(
        call("list_dir", { path: "." }),
        call("read_file", { path: "README.md" }),
        call("list_dir", { path: "docs" }),
        call("list_dir", { path: "src" }),
      );
      turns.push({
        final: [
          "[mock skill_tour] 5 分钟导览",
          "入口：README → docs/ → src/",
          `目标：${goal}`,
        ],
      });
      break;

    case "workflow_requirements":
    case "workflow_design":
    case "workflow_code":
    case "workflow_verify": {
      push(
        call("list_dir", { path: "." }),
        call("read_file", { path: "README.md" }),
      );
      if (scenario === "workflow_code") {
        push(
          call("write_file", {
            path: "notes/workflow-stage-draft.md",
            content: `# 多步任务草案\n\ngoal: ${goal}\n\n（mock workflow_code · 需批准）\n`,
          }),
        );
      }
      if (scenario === "workflow_verify") {
        push(call("run_safe_cmd", { command: "git status" }));
      }
      const label =
        scenario === "workflow_requirements"
          ? "摸清现状"
          : scenario === "workflow_design"
            ? "拟定改法"
            : scenario === "workflow_code"
              ? "动手改码"
              : "核对结果";
      // 结论文案跟着「这一步有没有真排上写操作」走：write_file 被 readOnly 摘掉或
      // 该 Agent 没配它时，call() 会静默返回 null，不能说「已提出待批准」。
      const proposedWrite = scenario === "workflow_code" && has("write_file");
      turns.push({
        final: [
          `[mock ${scenario}] 多步任务「${label}」产出`,
          `1) 理解：${goal}`,
          "2) 涉及：README / sample 工作区",
          "3) 验收：摘要可回写任务并确认下一步",
          proposedWrite
            ? "4) 已提出 notes/workflow-stage-draft.md 待批准"
            : "4) 本步未强制写盘",
        ],
      });
      break;
    }

    case "changelog_write":
      if (!has("write_file")) {
        turns.push({ final: ["无 write_file，无法演示 changelog"] });
      } else {
        push(
          call("write_file", {
            path: "notes/CHANGELOG-draft.md",
            content: `# Changelog\n\n- chore: mock changelog_write\n- note: ${goal}\n`,
          }),
        );
        turns.push({
          final: ["[mock changelog_write] 已提出 CHANGELOG 草稿，待批准"],
        });
      }
      break;

    case "write_hitl":
    case "multi_write": {
      if (!has("write_file")) {
        const msg = "当前 Agent 无 write_file，无法演示 HITL 写入";
        turns.push({ error: msg, final: [msg] });
        break;
      }
      push(call("list_dir", { path: "." }));
      const files =
        scenario === "multi_write"
          ? [
              {
                path: "notes/session-brief.md",
                content: [
                  "# Session brief",
                  "",
                  `goal: ${goal}`,
                  `at: ${new Date().toISOString()}`,
                  "",
                  "（mock multi_write · 批准后落盘）",
                ].join("\n"),
              },
              {
                path: "notes/CHANGELOG-draft.md",
                content: [
                  "# Changelog draft",
                  "",
                  "- feat: Loom mock multi_write demo",
                  `- note: ${goal}`,
                ].join("\n"),
              },
            ]
          : [
              {
                path: "notes/session-brief.md",
                content: [
                  "# Loom session brief",
                  "",
                  `生成于 mock write_hitl · ${new Date().toISOString()}`,
                  "",
                  `目标：${goal}`,
                  "",
                  "仅在 Studio 批准后才会写入磁盘。",
                ].join("\n"),
              },
            ];
      for (const f of files) push(call("write_file", f));
      turns.push({
        final: [
          `[mock ${scenario}] 已提出 ${files.length} 个待批准写入：`,
          ...files.map((f) => `  · ${f.path}`),
          "请在「写操作审批」批准或拒绝。",
        ],
      });
      break;
    }

    case "grep_audit":
      push(
        call("list_dir", { path: "." }),
        call("grep_files", { query: "TODO" }),
        call("grep_files", { query: "FIXME" }),
        call("grep_files", { query: "sk-" }),
        call("grep_files", { query: "password" }),
      );
      turns.push({
        final: (ctx) => {
          // 前 4 个结果里，第 0 个是 list_dir，其后按顺序是 4 次 grep
          const at = (i: number): number => ctx.hitCount(i);
          return [
            "[mock grep_audit] 审计摘要",
            `TODO 命中：${at(0)}`,
            `FIXME 命中：${at(1)}`,
            `sk- 命中：${at(2)}`,
            `password 命中：${at(3)}`,
            "建议：假密钥仅存在于 .env.example / 注释，勿提交真凭证。",
          ];
        },
      });
      break;

    case "docs_focus":
      push(
        call("list_dir", { path: "docs" }),
        call("read_file", { path: "docs/ARCHITECTURE.md" }),
        call("read_file", { path: "docs/API.md" }),
      );
      turns.push({
        final: [
          "[mock docs_focus] 已阅读 docs/ARCHITECTURE + API",
          "要点：Tools → Agents → Orchestrator；写操作 HITL。",
          `目标：${goal}`,
        ],
      });
      break;

    case "readme_focus":
      push(call("read_file", { path: "README.md" }));
      turns.push({
        final: [
          "[mock:readme_focus 完成] 侧重 README",
          `工作区：${input.workspaceRoot}`,
          `目标：${goal}`,
          "确定性工具脚本。有云端 API Key 且选用真模型时不走本路径。",
        ],
      });
      break;

    case "structure_focus":
      push(
        call("list_dir", { path: "." }),
        call("read_file", { path: "src/index.ts" }),
        call("read_file", { path: "package.json" }),
      );
      turns.push({
        final: [
          "[mock:structure_focus 完成] 侧重目录与入口",
          `工作区：${input.workspaceRoot}`,
          `目标：${goal}`,
          "确定性工具脚本。有云端 API Key 且选用真模型时不走本路径。",
        ],
      });
      break;

    case "delegate_fanout": {
      // 层4 离线演示：把两份互相独立的工作一次性派出去，再自己收口。
      // 真模型下由模型决定派谁、派什么；mock 下由这段剧本演同一件事。
      const delegate = delegationTool();
      if (!delegate) {
        // 没有委派工具就退回单 agent 探索，别演一个不存在的工具
        push(
          call("list_dir", { path: "." }),
          call("read_file", { path: "README.md" }),
        );
        turns.push({
          final: [
            "[mock delegate_fanout] 当前 Agent 未配置子 agent，退回单 agent 探索",
            `目标：${goal}`,
          ],
        });
        break;
      }
      push(
        call(delegate, {
          goal: `盘点 packages/core/src 的结构与职责边界，产出要点清单。\n（父级任务：${goal}）`,
        }),
        call(delegate, {
          goal: `盘点 README 与 docs 的现存描述，指出与代码不一致之处。\n（父级任务：${goal}）`,
        }),
      );
      turns.push({
        final: (ctx) => {
          const produced = ctx.results.filter((r) => r.ok !== false).length;
          return [
            "[mock delegate_fanout] 已并行派出 2 个子 agent 并收口",
            `子任务返回 ${produced} 份结果；子 agent 的中间步骤没有回流到父级事件流。`,
            "父级只拿到每个子 agent 的最终文本。",
            `目标：${goal}`,
          ];
        },
      });
      break;
    }

    default:
      // explore
      push(
        call("list_dir", { path: "." }),
        call("read_file", { path: "README.md" }),
      );
      turns.push({
        final: [
          "[mock:explore 完成] 综合探索",
          `工作区：${input.workspaceRoot}`,
          `目标：${goal}`,
          "确定性工具脚本。有云端 API Key 且选用真模型时不走本路径。",
        ],
      });
      break;
  }

  return turns;
}

function streamOf(
  parts: LanguageModelV3StreamPart[],
  delayMs = 0,
): ReadableStream<LanguageModelV3StreamPart> {
  let i = 0;
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(parts[i++]);
    },
  });
}

/**
 * 离线摘要桩：compact.ts 的摘要提示词要求「要点式、保留文件路径、不臆造」，
 * 这里就给一份结构对得上的假摘要 —— 字段齐全，好让压缩路径在 mock 上也能走通，
 * 至于摘得好不好不是 mock 该负责的事。
 */
function buildMockSummary(promptText: string): string {
  const paths = new Set<string>();
  for (const m of promptText.matchAll(/[\w./-]+\.(?:ts|tsx|js|mjs|json|md)/g)) {
    if (paths.size >= 6) break;
    paths.add(m[0]);
  }
  const mentioned = [...paths].map((p) => `- 涉及文件：${p}`).join("\n");
  return [
    "<mock 摘要>",
    "1) 任务目标：沿用压缩前旧消息里的原目标。",
    "2) 已确认结论：旧消息中的事实性结论保留，未臆造新内容。",
    "3) 已改动文件路径：",
    mentioned || "- （旧消息中未出现具体文件路径）",
    "4) 未完成待办：见旧消息中最后一个用户请求。",
  ].join("\n");
}

function mockUsage(promptTokens: number, outputText: string): LanguageModelV3Usage {
  const out = estimateTokens(outputText);
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: { total: out, text: out, reasoning: 0 },
  };
}

/**
 * 造一个"照剧本演"的模型。它对外就是 LanguageModelV3，
 * streamText 完全不知道自己在跟 mock 说话——这正是要的效果。
 */
export function createMockLanguageModel(input: {
  scenario: MockScenario;
  goal: string;
  workspaceRoot: string;
  agentId: string;
  modelId: string;
  tools: ToolDefinition[];
  /** 首行旁白，默认按 scenario 生成 */
  narrate?: string;
}): { model: LanguageModelV3; runtime: MockRuntime } {
  const runtime: MockRuntime = { stubs: new Map() };
  const turns = buildMockScript(input);
  let cursor = 0;
  const results: ToolResult[] = [];
  const grepCounts: number[] = [];

  const head =
    input.narrate ??
    `[mock:${input.scenario}] agent=${input.agentId} model=${input.modelId}\n目标：${input.goal}`;

  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "loom-mock",
    modelId: `mock:${input.modelId}`,
    supportedUrls: {},
    doGenerate: async (options) => {
      // 层3 的摘要走 generateText（非流式）。mock 也得答，否则「有 Key 才压缩」
      // 会变成一条隐形的能力边界：离线演示永远看不到压缩。
      const promptText = JSON.stringify(options.prompt ?? "");
      const summary = buildMockSummary(promptText);
      const out = estimateTokens(summary);
      return {
        content: [{ type: "text", text: summary }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: estimateTokens(promptText),
            noCache: estimateTokens(promptText),
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: out, text: out, reasoning: 0 },
        },
        warnings: [],
      };
    },
    doStream: async (options) => {
      const promptTokens = estimateTokens(JSON.stringify(options.prompt ?? ""));
      const turn = turns[cursor];
      cursor += 1;

      if (!turn) {
        // 剧本演完了，给一个空收尾，让 SDK 正常结束
        return {
          stream: streamOf([
            {
              type: "finish",
              usage: mockUsage(promptTokens, ""),
              finishReason: { unified: "stop", raw: "stop" },
            },
          ]),
        };
      }

      const parts: LanguageModelV3StreamPart[] = [];

      // 只有第一轮补旁白，且只在剧本还有后续时发（否则会打断收尾）
      if (cursor === 1 && head) {
        const id = "mock-head";
        parts.push({ type: "text-start", id });
        for (const c of chunkText(head)) {
          parts.push({ type: "text-delta", id, delta: c });
        }
        parts.push({ type: "text-end", id });
      }

      if (turn.text) {
        const id = `mock-text-${cursor}`;
        parts.push({ type: "text-start", id });
        for (const c of chunkText(turn.text)) {
          parts.push({ type: "text-delta", id, delta: c });
        }
        parts.push({ type: "text-end", id });
      }

      if (turn.tool) {
        const id = `mock-tc-${cursor}`;
        const payload = JSON.stringify(turn.tool.args);
        parts.push({
          type: "tool-input-start",
          id,
          toolName: turn.tool.name,
        });
        for (const c of chunkText(payload, 16)) {
          parts.push({ type: "tool-input-delta", id, delta: c });
        }
        parts.push({ type: "tool-input-end", id });
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: turn.tool.name,
          input: payload,
        });
        if (turn.tool.stub) {
          runtime.stubs.set(id, turn.tool.stub);
        }
      }

      if (turn.error) {
        // 先把 error 发出去，再给收尾文本
        parts.push({ type: "error", error: new Error(turn.error) });
      }

      let finalText = "";
      if (turn.final) {
        const ctx: MockScriptContext = {
          scenario: input.scenario,
          goal: input.goal,
          workspaceRoot: input.workspaceRoot,
          agentId: input.agentId,
          modelId: input.modelId,
          results,
          hitCount: (i) => grepCounts[i] ?? 0,
          step: cursor,
        };
        const lines = typeof turn.final === "function" ? turn.final(ctx) : turn.final;
        finalText = [...lines, `trace: ${nanoid(8)}`].join("\n");
        const id = `mock-final-${cursor}`;
        parts.push({ type: "text-start", id });
        for (const c of chunkText(finalText)) {
          parts.push({ type: "text-delta", id, delta: c });
        }
        parts.push({ type: "text-end", id });
      }

      parts.push({
        type: "finish",
        usage: mockUsage(promptTokens, finalText),
        finishReason: {
          unified: turn.tool ? "tool-calls" : "stop",
          raw: turn.tool ? "tool_calls" : "stop",
        },
      });

      // 之前发出去的工具结果在这里被"模型读到"，供 final 的计算回调用
      void grepCounts;
      return { stream: streamOf(parts, turn.tool ? 0 : 8) };
    },
  };

  return {
    model: Object.assign(model, {
      /** 由 run.ts 在每次工具执行后调用，mock 剧本靠它算 grep 命中数 */
      __loomRecord: (r: ToolResult) => {
        results.push(r);
        const hits = (r?.data as { hits?: unknown[] } | undefined)?.hits;
        grepCounts.push(Array.isArray(hits) ? hits.length : -1);
      },
    }) as LanguageModelV3,
    runtime,
  };
}

/** 取回 mock 记住的工具结果（run.ts 用） */
export function recordMockResult(model: unknown, result: ToolResult): void {
  const fn = (model as { __loomRecord?: (r: ToolResult) => void }).__loomRecord;
  if (typeof fn === "function") fn(result);
}
