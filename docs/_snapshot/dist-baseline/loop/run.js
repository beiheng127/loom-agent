import { streamText } from "ai";
import { nanoid } from "nanoid";
import { skillsToSystemBlock } from "../skills/loader.js";
import { formatToolsForPrompt, toolsForAgent } from "../tools/catalog.js";
import { resolveLanguageModel } from "../models/registry.js";
/**
 * 单 Agent ReAct 循环。
 * - 有真实模型：用 AI SDK streamText + 手工工具协议（token 级 text_delta）
 * - mock：按 scenario 跑确定性脚本（可选分片 text_delta）
 */
export async function runAgentLoop(input) {
    const { workspaceRoot, agent, model, skills, goal, maxSteps = 6, signal, onEvent, mockScenario, temperature, history = [], readOnly = false, } = input;
    const allowed = readOnly
        ? agent.allowedTools.filter((t) => t !== "write_file" && t !== "run_safe_cmd")
        : agent.allowedTools;
    const tools = toolsForAgent(allowed);
    const skillBlock = skillsToSystemBlock(skills.filter((s) => agent.skillIds.includes(s.id)));
    const system = [
        agent.systemPrompt,
        readOnly ? "\n【Ask 模式】只读，禁止提出写文件或执行本地命令。" : "",
        "",
        "工作区根目录已沙箱隔离。你只能使用下列工具：",
        formatToolsForPrompt(tools),
        "",
        "当你需要调用工具时，只输出一行 JSON（不要 markdown）：",
        `{"tool":"<name>","args":{...}}`,
        "当你已完成任务，输出：",
        `{"done":true,"answer":"..."}`,
        skillBlock ? `\n已加载 Skills：\n${skillBlock}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    onEvent?.({ type: "phase", phase: "thinking" });
    const languageModel = resolveLanguageModel(model);
    if (!languageModel) {
        return runMockLoop({
            workspaceRoot,
            goal,
            agentId: agent.id,
            modelId: model.id,
            tools,
            scenario: resolveMockScenario({
                explicit: mockScenario,
                agentId: agent.id,
                modelId: model.id,
                goal,
                allowedTools: allowed,
            }),
            onEvent,
            signal,
        });
    }
    const messages = [{ role: "system", content: system }];
    for (const h of history.slice(-12)) {
        messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: "user", content: goal });
    let finalAnswer = "";
    for (let step = 0; step < maxSteps; step++) {
        if (signal?.aborted) {
            onEvent?.({ type: "error", message: "已中止" });
            break;
        }
        onEvent?.({ type: "phase", phase: "thinking" });
        const stream = streamText({
            model: languageModel,
            messages,
            abortSignal: signal,
            maxRetries: 1,
            temperature: temperature ?? model.temperature ?? 0.3,
        });
        let text = "";
        for await (const delta of stream.textStream) {
            if (signal?.aborted)
                break;
            text += delta;
            onEvent?.({ type: "text_delta", delta });
        }
        onEvent?.({ type: "text", text });
        messages.push({ role: "assistant", content: text });
        const action = parseAction(text);
        if (!action) {
            finalAnswer = text;
            onEvent?.({ type: "phase", phase: "done" });
            onEvent?.({ type: "done", text: finalAnswer });
            break;
        }
        if ("done" in action && action.done) {
            finalAnswer = action.answer || text;
            onEvent?.({ type: "phase", phase: "done" });
            onEvent?.({ type: "done", text: finalAnswer });
            break;
        }
        if (!("tool" in action) || !action.tool) {
            finalAnswer = text;
            onEvent?.({ type: "phase", phase: "done" });
            onEvent?.({ type: "done", text: finalAnswer });
            break;
        }
        const toolName = action.tool;
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
            messages.push({ role: "user", content: `工具错误: 未知工具 ${toolName}` });
            continue;
        }
        const args = (action.args ?? {});
        onEvent?.({
            type: "phase",
            phase: toolName === "write_file" || toolName === "run_safe_cmd"
                ? "writing"
                : "tooling",
        });
        onEvent?.({ type: "tool_call", name: toolName, args });
        const result = await tool.execute(args, { workspaceRoot, signal });
        onEvent?.({ type: "tool_result", name: toolName, result });
        if (result.requiresApproval && result.pendingWrite) {
            onEvent?.({
                type: "approval_needed",
                kind: "write",
                path: result.pendingWrite.path,
                content: result.pendingWrite.content,
            });
        }
        if (result.requiresApproval && result.pendingCmd) {
            onEvent?.({
                type: "approval_needed",
                kind: "cmd",
                path: result.pendingCmd.command,
                content: "",
                command: result.pendingCmd.command,
            });
        }
        messages.push({
            role: "user",
            content: `工具 ${toolName} 结果：\n${JSON.stringify(result, null, 2)}`,
        });
    }
    if (!finalAnswer) {
        finalAnswer = "（达到步数上限，未显式 done）";
        onEvent?.({ type: "phase", phase: "done" });
        onEvent?.({ type: "done", text: finalAnswer });
    }
    return finalAnswer;
}
export function resolveMockScenario(input) {
    if (input.explicit)
        return input.explicit;
    if (input.modelId === "mock-editor") {
        if (/两个|多文件|changelog/i.test(input.goal))
            return "multi_write";
        if (/命令|git status|run_safe/i.test(input.goal))
            return "cmd_hitl";
        return "write_hitl";
    }
    if (input.agentId === "auditor" || /审计|TODO|密钥|grep/i.test(input.goal)) {
        if (/env|\.env|password/i.test(input.goal))
            return "env_audit";
        return "grep_audit";
    }
    if ((input.agentId === "editor" || input.allowedTools.includes("write_file")) &&
        /写|保存|创建|改|HITL|审批/i.test(input.goal)) {
        if (/changelog/i.test(input.goal))
            return "changelog_write";
        return "write_hitl";
    }
    if (/动手改码|代码研发/i.test(input.goal))
        return "workflow_code";
    if (/核对结果|验证收尾/i.test(input.goal))
        return "workflow_verify";
    if (/拟定改法|方案设计/i.test(input.goal))
        return "workflow_design";
    if (/摸清现状|需求理解|多步任务/i.test(input.goal))
        return "workflow_requirements";
    if (/RULES|规则|\.loom/i.test(input.goal))
        return "rules_focus";
    if (/TODO\.md|待办清单/i.test(input.goal))
        return "todo_focus";
    if (/package\.json|依赖/i.test(input.goal))
        return "package_focus";
    if (/utils|工具函数/i.test(input.goal))
        return "utils_focus";
    if (/API\.md|接口文档/i.test(input.goal))
        return "api_docs";
    if (/fetch_url|抓取|http/i.test(input.goal))
        return "fetch_url_stub";
    if (/只读|Ask 模式|不要写/i.test(input.goal))
        return "ask_readonly";
    if (/导览|5 分钟|新人/i.test(input.goal))
        return "skill_tour";
    if (/docs|架构|ARCHITECTURE/i.test(input.goal))
        return "docs_focus";
    if (/README|说明|定位/i.test(input.goal))
        return "readme_focus";
    if (/结构|目录|探索|list/i.test(input.goal))
        return "structure_focus";
    return "explore";
}
function parseAction(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match)
        return null;
    try {
        return JSON.parse(match[0]);
    }
    catch {
        return null;
    }
}
async function runMockLoop(input) {
    const { workspaceRoot, goal, agentId, modelId, tools, scenario, onEvent, signal } = input;
    const list = tools.find((t) => t.name === "list_dir");
    const read = tools.find((t) => t.name === "read_file");
    const grep = tools.find((t) => t.name === "grep_files");
    const write = tools.find((t) => t.name === "write_file");
    const cmd = tools.find((t) => t.name === "run_safe_cmd");
    const fetchUrl = tools.find((t) => t.name === "fetch_url");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const emitText = async (full) => {
        await emitTextDeltas(full, onEvent, sleep);
        onEvent?.({ type: "text", text: full });
    };
    await emitText(`[mock:${scenario}] agent=${agentId} model=${modelId}\n目标：${goal}`);
    if (signal?.aborted)
        return "已中止";
    const call = async (name, tool, args) => {
        if (!tool)
            return null;
        onEvent?.({
            type: "phase",
            phase: name === "write_file" || name === "run_safe_cmd" ? "writing" : "tooling",
        });
        onEvent?.({ type: "tool_call", name, args });
        await sleep(40);
        const result = await tool.execute(args, { workspaceRoot, signal });
        onEvent?.({ type: "tool_result", name, result });
        if (result.requiresApproval && result.pendingWrite) {
            onEvent?.({
                type: "approval_needed",
                kind: "write",
                path: result.pendingWrite.path,
                content: result.pendingWrite.content,
            });
        }
        if (result.requiresApproval && result.pendingCmd) {
            onEvent?.({
                type: "approval_needed",
                kind: "cmd",
                path: result.pendingCmd.command,
                content: "",
                command: result.pendingCmd.command,
            });
        }
        return result;
    };
    const finish = async (lines) => {
        const answer = [...lines, `trace: ${nanoid(8)}`].join("\n");
        await emitText(answer);
        onEvent?.({ type: "done", text: answer });
        return answer;
    };
    if (scenario === "list_only") {
        await call("list_dir", list, { path: "." });
        return finish(["[mock list_only] 仅列根目录", `目标：${goal}`]);
    }
    if (scenario === "cmd_hitl") {
        await call("list_dir", list, { path: "." });
        if (!cmd) {
            return finish(["当前 Agent 无 run_safe_cmd，无法演示命令 HITL"]);
        }
        await call("run_safe_cmd", cmd, { command: "git status" });
        return finish([
            "[mock cmd_hitl] 已提出待批准命令：git status",
            "请在 HITL 卡片批准或拒绝。",
        ]);
    }
    if (scenario === "fetch_url_stub") {
        // 离线不发起外网：模拟工具结果，避免无 Key 环境依赖网络
        onEvent?.({ type: "phase", phase: "tooling" });
        onEvent?.({
            type: "tool_call",
            name: "fetch_url",
            args: { url: "https://example.com" },
        });
        await sleep(40);
        const stub = {
            ok: true,
            data: {
                url: "https://example.com",
                excerpt: "Example Domain — 离线 stub：未发起真实 HTTP（fixture 模式）。",
                stub: true,
            },
        };
        onEvent?.({
            type: "tool_result",
            name: "fetch_url",
            result: stub,
        });
        void fetchUrl;
        return finish([
            "[mock fetch_url_stub] 已返回示例摘录（无外网）",
            "接入真模型后将走真实 fetch_url（含 SSRF 防护）。",
        ]);
    }
    if (scenario === "ask_readonly") {
        await call("list_dir", list, { path: "." });
        await call("read_file", read, { path: "README.md" });
        return finish([
            "[mock ask_readonly] Ask 模式：只读探索完成",
            "未调用 write_file / run_safe_cmd。",
            `目标：${goal}`,
        ]);
    }
    if (scenario === "rules_focus") {
        await call("read_file", read, { path: ".loom/RULES.md" });
        return finish([
            "[mock rules_focus] 已阅读工作区 RULES",
            "写文件前应遵守沙箱与审批约定。",
        ]);
    }
    if (scenario === "todo_focus") {
        await call("read_file", read, { path: "TODO.md" });
        await call("grep_files", grep, { query: "TODO" });
        return finish(["[mock todo_focus] 已汇总 TODO.md 与 grep TODO 命中"]);
    }
    if (scenario === "package_focus") {
        await call("read_file", read, { path: "package.json" });
        return finish(["[mock package_focus] 已阅读 package.json 依赖与脚本"]);
    }
    if (scenario === "utils_focus") {
        await call("read_file", read, { path: "src/utils.ts" });
        await call("read_file", read, { path: "src/index.ts" });
        return finish(["[mock utils_focus] 已阅读 src 入口与工具函数"]);
    }
    if (scenario === "api_docs") {
        await call("read_file", read, { path: "docs/API.md" });
        return finish(["[mock api_docs] 已阅读 docs/API.md"]);
    }
    if (scenario === "env_audit") {
        await call("grep_files", grep, { query: "sk-" });
        await call("grep_files", grep, { query: "password" });
        await call("read_file", read, { path: ".env.example" });
        return finish([
            "[mock env_audit] 已扫描疑似密钥痕迹并阅读 .env.example",
            "假密钥仅作演示，勿提交真凭证。",
        ]);
    }
    if (scenario === "multi_grep") {
        await call("grep_files", grep, { query: "export" });
        await call("grep_files", grep, { query: "function" });
        await call("grep_files", grep, { query: "TODO" });
        return finish(["[mock multi_grep] 多关键词扫描完成"]);
    }
    if (scenario === "skill_tour") {
        await call("list_dir", list, { path: "." });
        await call("read_file", read, { path: "README.md" });
        await call("list_dir", list, { path: "docs" });
        await call("list_dir", list, { path: "src" });
        return finish([
            "[mock skill_tour] 5 分钟导览",
            "入口：README → docs/ → src/",
            `目标：${goal}`,
        ]);
    }
    if (scenario === "workflow_requirements" ||
        scenario === "workflow_design" ||
        scenario === "workflow_code" ||
        scenario === "workflow_verify") {
        await call("list_dir", list, { path: "." });
        await call("read_file", read, { path: "README.md" });
        if (scenario === "workflow_code" && write) {
            await call("write_file", write, {
                path: "notes/workflow-stage-draft.md",
                content: `# 多步任务草案\n\ngoal: ${goal}\n\n（mock workflow_code · 需批准）\n`,
            });
        }
        if (scenario === "workflow_verify" && cmd) {
            await call("run_safe_cmd", cmd, { command: "git status" });
        }
        const label = scenario === "workflow_requirements"
            ? "摸清现状"
            : scenario === "workflow_design"
                ? "拟定改法"
                : scenario === "workflow_code"
                    ? "动手改码"
                    : "核对结果";
        return finish([
            `[mock ${scenario}] 多步任务「${label}」产出`,
            `1) 理解：${goal}`,
            "2) 涉及：README / sample 工作区",
            "3) 验收：摘要可回写任务并确认下一步",
            scenario === "workflow_code"
                ? "4) 已提出 notes/workflow-stage-draft.md 待批准"
                : "4) 本步未强制写盘",
        ]);
    }
    if (scenario === "changelog_write") {
        if (!write) {
            return finish(["无 write_file，无法演示 changelog"]);
        }
        await call("write_file", write, {
            path: "notes/CHANGELOG-draft.md",
            content: `# Changelog\n\n- chore: mock changelog_write\n- note: ${goal}\n`,
        });
        return finish([
            "[mock changelog_write] 已提出 CHANGELOG 草稿，待批准",
        ]);
    }
    if (scenario === "write_hitl" || scenario === "multi_write") {
        await call("list_dir", list, { path: "." });
        if (!write) {
            const msg = "当前 Agent 无 write_file，无法演示 HITL 写入";
            onEvent?.({ type: "error", message: msg });
            onEvent?.({ type: "done", text: msg });
            return msg;
        }
        const files = scenario === "multi_write"
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
        for (const f of files) {
            await call("write_file", write, f);
        }
        return finish([
            `[mock ${scenario}] 已提出 ${files.length} 个待批准写入：`,
            ...files.map((f) => `  · ${f.path}`),
            "请在「写操作审批」批准或拒绝。",
        ]);
    }
    if (scenario === "grep_audit") {
        await call("list_dir", list, { path: "." });
        const q1 = await call("grep_files", grep, { query: "TODO" });
        const q2 = await call("grep_files", grep, { query: "FIXME" });
        const q3 = await call("grep_files", grep, { query: "sk-" });
        const q4 = await call("grep_files", grep, { query: "password" });
        const count = (r) => {
            const hits = r?.data?.hits;
            return Array.isArray(hits) ? hits.length : 0;
        };
        return finish([
            "[mock grep_audit] 审计摘要",
            `TODO 命中：${count(q1)}`,
            `FIXME 命中：${count(q2)}`,
            `sk- 命中：${count(q3)}`,
            `password 命中：${count(q4)}`,
            "建议：假密钥仅存在于 .env.example / 注释，勿提交真凭证。",
        ]);
    }
    if (scenario === "docs_focus") {
        await call("list_dir", list, { path: "docs" });
        await call("read_file", read, { path: "docs/ARCHITECTURE.md" });
        await call("read_file", read, { path: "docs/API.md" });
        return finish([
            "[mock docs_focus] 已阅读 docs/ARCHITECTURE + API",
            "要点：Tools → Agents → Orchestrator；写操作 HITL。",
            `目标：${goal}`,
        ]);
    }
    if (list && scenario !== "readme_focus") {
        await call("list_dir", list, { path: "." });
    }
    if (read && scenario !== "structure_focus") {
        await call("read_file", read, { path: "README.md" });
    }
    if (scenario === "structure_focus" && read) {
        await call("read_file", read, { path: "src/index.ts" });
        await call("read_file", read, { path: "package.json" });
    }
    const focus = scenario === "readme_focus"
        ? "侧重 README"
        : scenario === "structure_focus"
            ? "侧重目录与入口"
            : "综合探索";
    return finish([
        `[mock:${scenario} 完成] ${focus}`,
        `工作区：${workspaceRoot}`,
        `目标：${goal}`,
        "确定性工具脚本。有云端 API Key 且选用真模型时不走本路径。",
    ]);
}
/** mock UX 与真模型对齐：把整段答案拆成小块 text_delta */
async function emitTextDeltas(full, onEvent, sleep, chunkSize = 24) {
    if (!onEvent || !full)
        return;
    for (let i = 0; i < full.length; i += chunkSize) {
        const delta = full.slice(i, i + chunkSize);
        onEvent({ type: "text_delta", delta });
        await sleep(8);
    }
}
