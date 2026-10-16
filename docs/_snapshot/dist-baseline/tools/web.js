/** 禁止内网 / 非 http(s)，与 Aether Desk 对齐的演示级 SSRF 防护 */
export function assertPublicHttpUrl(raw) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error("URL 无效");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("仅允许 http/https");
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host.endsWith(".local") ||
        host.endsWith(".internal")) {
        throw new Error("禁止访问本机或内网主机名");
    }
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a === 10 ||
            a === 127 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254)) {
            throw new Error("禁止访问私有 IP 段");
        }
    }
    return parsed;
}
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CHARS = 4000;
export async function fetchUrlTool(args, _ctx) {
    try {
        const url = String(args.url ?? "");
        if (!url)
            return { ok: false, error: "url 必填" };
        assertPublicHttpUrl(url);
        const timeoutMs = Number(process.env.LOOM_FETCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
        const maxChars = Number(process.env.LOOM_FETCH_MAX_CHARS ?? DEFAULT_MAX_CHARS);
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        _ctx.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { "User-Agent": "LoomAgent/1.0 (+local-coding-agent)" },
                redirect: "manual",
            });
            clearTimeout(timer);
            _ctx.signal?.removeEventListener("abort", onAbort);
            if (res.status >= 300 && res.status < 400) {
                return { ok: false, error: "禁止跟随重定向（防 SSRF）" };
            }
            if (!res.ok) {
                return { ok: false, error: `HTTP ${res.status}` };
            }
            const raw = await res.text();
            const text = raw
                .replace(/<script[\s\S]*?<\/script>/gi, " ")
                .replace(/<style[\s\S]*?<\/style>/gi, " ")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, maxChars);
            return {
                ok: true,
                data: {
                    url,
                    excerpt: text.slice(0, Math.min(2000, text.length)),
                    length: text.length,
                    truncated: raw.length > maxChars,
                },
            };
        }
        catch (err) {
            clearTimeout(timer);
            _ctx.signal?.removeEventListener("abort", onAbort);
            throw err;
        }
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
/** 公开网页搜索：优先 Tavily，其次 SerpAPI；无 Key 时诚实失败 */
export async function webSearchTool(args, ctx) {
    const query = String(args.query ?? args.q ?? "").trim();
    if (!query)
        return { ok: false, error: "query 必填" };
    const tavily = process.env.TAVILY_API_KEY?.trim() ||
        process.env.LOOM_SEARCH_API_KEY?.trim();
    const serp = process.env.SERPAPI_API_KEY?.trim();
    if (!tavily && !serp) {
        return {
            ok: false,
            error: "未配置搜索 Key（TAVILY_API_KEY / LOOM_SEARCH_API_KEY / SERPAPI_API_KEY），不会返回假结果",
        };
    }
    const maxResults = Math.min(Number(args.maxResults ?? 5) || 5, 8);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        if (tavily) {
            const res = await fetch("https://api.tavily.com/search", {
                method: "POST",
                signal: controller.signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    api_key: tavily,
                    query,
                    search_depth: "basic",
                    max_results: maxResults,
                    include_answer: false,
                }),
            });
            if (!res.ok) {
                return { ok: false, error: `Tavily HTTP ${res.status}` };
            }
            const data = (await res.json());
            const hits = (data.results ?? [])
                .slice(0, maxResults)
                .map((r) => ({
                title: r.title ?? "(无标题)",
                url: r.url ?? "",
                snippet: (r.content ?? "").slice(0, 280),
            }))
                .filter((h) => h.url);
            return {
                ok: true,
                data: { provider: "tavily", query, hits, count: hits.length },
            };
        }
        const url = new URL("https://serpapi.com/search.json");
        url.searchParams.set("engine", "google");
        url.searchParams.set("q", query);
        url.searchParams.set("api_key", serp);
        url.searchParams.set("num", String(maxResults));
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            return { ok: false, error: `SerpAPI HTTP ${res.status}` };
        }
        const data = (await res.json());
        const hits = (data.organic_results ?? [])
            .slice(0, maxResults)
            .map((r) => ({
            title: r.title ?? "(无标题)",
            url: r.link ?? "",
            snippet: (r.snippet ?? "").slice(0, 280),
        }))
            .filter((h) => h.url);
        return {
            ok: true,
            data: { provider: "serpapi", query, hits, count: hits.length },
        };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
    }
}
