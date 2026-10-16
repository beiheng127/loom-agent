import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * 后台 job 通道（对标 DSH 的 jobs）。
 *
 * 存在的理由：`run_safe_cmd` 是**阻塞**的——一条慢命令会占着循环等超时，
 * 超时上限一到就被 SIGTERM 掉，长活（跑测试、装依赖、拉大仓库）根本没活路。
 * 这里把「启动」和「读输出」拆开：start 立刻返回，输出进环形缓冲，
 * 之后随时用 job_output 取新增内容、job_kill 收尾。
 *
 * 刻意的取舍：
 * - **进程内、不落盘**：job 是运行时对象（句柄、pid、缓冲），重启后句柄就没了，
 *   把记录落盘只会留下一堆「永远 running」的假象。这是与 todo 日志相反的判断，
 *   因为 todo 是「状态」而 job 是「句柄」。
 * - **白名单不在这一层**：本层只管跑，安全性由 `applyApprovedCmd` 的 `isSafeCommand`
 *   与人工审批把守（后台跑道不是绕过审批的后门）。
 * - **输出截断而不是无限缓冲**：一条 `yes` 能吃掉整台机器的内存。
 * - **Windows 上杀进程要杀树**：`shell:true` 会多一层 cmd.exe，真正干活的是它的
 *   孙进程；只杀 cmd.exe 的话孙进程继续占着继承来的管道，`close` 永远不来。
 *   所以 win32 分支走 `taskkill /pid <pid> /T /F`。状态判定挂在 `exit` 事件上，
 *   因为 `exit` 是进程自己的结束，比等管道关闭可靠。
 */

export type JobStatus = "running" | "done" | "failed" | "killed";

export type JobRecord = {
  id: string;
  command: string;
  pid: number | null;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  /** 输出撞到上限被截过 */
  truncated: boolean;
};

export type JobView = JobRecord & {
  elapsedMs: number;
  /** 尾部 200 字符，列表里给人/模型一眼看到最近发生了什么 */
  tail: string;
};

export type JobStoreOptions = {
  maxOutputChars?: number;
  /** 最多保留多少个**已结束**的 job（running 永不回收） */
  keep?: number;
  now?: () => number;
  /** 测试注入用；默认 node:child_process 的 spawn */
  spawnFn?: typeof spawn;
  /** 生成 id 用；默认递增 job-1/job-2… */
  idPrefix?: string;
};

export type JobReadResult = {
  job: JobView;
  /** 自上次读取以来的新增输出（stdout+stderr 混排，带 [err] 前缀区分 stderr） */
  output: string;
  running: boolean;
};

export type JobStore = {
  start(
    command: string,
    opts: { cwd: string; env?: NodeJS.ProcessEnv },
  ): JobRecord;
  list(): JobView[];
  get(id: string): JobView | undefined;
  /** 最近一个 job（job_output 不传 id 时用它） */
  latest(): JobView | undefined;
  read(
    id: string,
    opts?: { wait?: boolean; timeoutMs?: number },
  ): Promise<JobReadResult | undefined>;
  kill(id: string): boolean;
  /** 等所有 running 的 job 收尾；测试与关站用 */
  drain(timeoutMs?: number): Promise<void>;
};

type InternalJob = JobRecord & {
  cursor: number;
  child?: ChildProcess;
  killRequested: boolean;
  done: Promise<void>;
  finish: () => void;
};

const DEFAULT_MAX_OUTPUT = 8000;
const DEFAULT_KEEP = 20;

export function createJobStore(options: JobStoreOptions = {}): JobStore {
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const keep = options.keep ?? DEFAULT_KEEP;
  const now = options.now ?? (() => Date.now());
  const spawnFn = options.spawnFn ?? spawn;
  const idPrefix = options.idPrefix ?? "job";

  const jobs = new Map<string, InternalJob>();
  let seq = 0;

  const append = (job: InternalJob, chunk: string, toStderr: boolean) => {
    if (!chunk) return;
    const text = toStderr ? chunk.split("\n").map((l) => (l ? `[err] ${l}` : l)).join("\n") : chunk;
    if (job.stdout.length >= maxOutput) {
      job.truncated = true;
      return;
    }
    const room = maxOutput - job.stdout.length;
    if (text.length > room) {
      job.stdout += text.slice(0, room);
      job.truncated = true;
      return;
    }
    job.stdout += text;
  };

  const view = (job: InternalJob): JobView => ({
    id: job.id,
    command: job.command,
    pid: job.pid,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    stdout: job.stdout,
    stderr: job.stderr,
    truncated: job.truncated,
    elapsedMs: (job.endedAt ?? now()) - job.startedAt,
    tail: job.stdout.length > 200 ? `…${job.stdout.slice(-200)}` : job.stdout,
  });

  /** 结束顺序上只保留 keep 个：running 一律不回收 */
  const gc = () => {
    const finished = [...jobs.values()].filter((j) => j.status !== "running");
    if (finished.length <= keep) return;
    finished
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .slice(0, finished.length - keep)
      .forEach((j) => jobs.delete(j.id));
  };

  const store: JobStore = {
    start(command, opts) {
      seq += 1;
      const id = `${idPrefix}-${seq}`;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const job: InternalJob = {
        id,
        command,
        pid: null,
        status: "running",
        startedAt: now(),
        stdout: "",
        stderr: "",
        truncated: false,
        cursor: 0,
        killRequested: false,
        done,
        finish,
      };
      jobs.set(id, job);

      try {
        const child = spawnFn(command, {
          cwd: opts.cwd,
          shell: true,
          windowsHide: true,
          env: { ...process.env, ...opts.env },
        });
        job.child = child;
        job.pid = child.pid ?? null;

        child.stdout?.on("data", (buf: Buffer) => append(job, buf.toString("utf8"), false));
        child.stderr?.on("data", (buf: Buffer) => {
          const text = buf.toString("utf8");
          append(job, text, false);
          job.stderr = (job.stderr + text).slice(0, maxOutput);
        });

        // 为什么 status 挂在 `exit` 而不是 `close` 上：
        // shell:true 在 Windows 上会多一层 cmd.exe，真正干活的是它的孙进程。
        // 杀掉 cmd.exe 之后孙进程（以及它继承的管道）还活着 —— `close` 要等所有
        // 管道关闭才来，可能永远等不到。`exit` 是进程自己的结束事件，先到先算。
        const finalize = (code: number | null) => {
          if (job.status !== "running") return;
          job.status = job.killRequested ? "killed" : code === 0 ? "done" : "failed";
          job.exitCode = code;
          job.endedAt = now();
          job.finish();
          gc();
        };

        child.on("exit", (code) => finalize(code));
        child.on("close", (code) => finalize(code));
        child.on("error", (err) => {
          job.status = "failed";
          job.endedAt = now();
          job.stdout += `\n[启动失败] ${err.message}\n`;
          job.finish();
          gc();
        });
      } catch (err) {
        job.status = "failed";
        job.endedAt = now();
        job.stdout += `[启动失败] ${err instanceof Error ? err.message : String(err)}\n`;
        job.finish();
        gc();
      }

      return view(job) as JobRecord;
    },

    list() {
      return [...jobs.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((j) => view(j));
    },

    get(id) {
      const job = jobs.get(id);
      return job ? view(job) : undefined;
    },

    latest() {
      const all = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
      const job = all[all.length - 1];
      return job ? view(job) : undefined;
    },

    async read(id, opts) {
      const job = jobs.get(id);
      if (!job) return undefined;
      if (opts?.wait && job.status === "running") {
        const timeout = opts.timeoutMs ?? 1000;
        await Promise.race([
          job.done,
          new Promise<void>((resolve) => setTimeout(resolve, timeout)),
        ]);
      }
      const output = job.stdout.slice(job.cursor);
      job.cursor = job.stdout.length;
      return {
        job: view(job),
        output,
        running: job.status === "running",
      };
    },

    kill(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "running" || !job.child) return false;
      job.killRequested = true;
      if (process.platform === "win32" && job.pid) {
        // Windows 上必须连孙进程一起杀：`cmd.exe /c node x.mjs` 里真正跑活的是孙进程，
        // 只 TerminateProcess 掉 cmd.exe 的话它会把管道继续占着（close 永远不来）。
        try {
          spawnSync("taskkill", ["/pid", String(job.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // taskkill 不在 PATH 或已经退出：交给 exit/close 事件给出最终状态
        }
      }
      try {
        job.child.kill("SIGTERM");
      } catch {
        // 上面那刀可能已经把进程干掉了，这里失败不算 kill 失败
      }
      return true;
    },

    async drain(timeoutMs = 5000) {
      const running = [...jobs.values()].filter((j) => j.status === "running");
      if (!running.length) return;
      await Promise.race([
        Promise.all(running.map((j) => j.done)),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };

  return store;
}

/**
 * 为什么单例挂在 globalThis 上而不是模块变量里：Next 的 App Router 在开发模式下
 * 给每条 route 单独编译一个 server chunk，`import "@loom/core"` 于是被各自内联了
 * 一份——模块级变量在 `/api/cmds/approve` 和 `/api/jobs` 里是**两个** store。
 * 实测症状：批准后台命令拿到了 `jobId=job-1`，紧接着 `GET /api/jobs` 返回 `jobs=0`
 * （`scripts/probes/http.mjs` 第 10 节抓到的）。globalThis 是同一个进程共享的，
 * 换个 route 也还是那份。生产构建下同样成立。
 */
const JOB_STORE_KEY = "__loomJobStore";

type GlobalWithJobStore = typeof globalThis & {
  [JOB_STORE_KEY]?: JobStore;
};

/** 进程级单例（见上面为什么必须挂 globalThis）：`/api/cmds/approve` 起的 job，`/api/jobs` 要看得见 */
export function getDefaultJobStore(): JobStore {
  const g = globalThis as GlobalWithJobStore;
  if (!g[JOB_STORE_KEY]) g[JOB_STORE_KEY] = createJobStore();
  return g[JOB_STORE_KEY];
}

/** 只给测试用：丢掉单例，避免用例之间互相看见 */
export function resetDefaultJobStore(): void {
  const g = globalThis as GlobalWithJobStore;
  delete g[JOB_STORE_KEY];
}
