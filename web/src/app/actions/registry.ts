// The ONE action registry — the single source of truth for "what can be done".
// Both UI controls and the assistant dispatch the SAME entries via dispatch(),
// so the human UI and the agentic UI can never drift. Pure module (no React
// hooks): the caller assembles `ctx` from its hooks and passes it in.
//
// The model emits intents as a vendor-neutral text envelope (<<act:ID {json}>>),
// parsed CLIENT-SIDE; the registry validates args by hand (no zod dep) and gates
// side-effects. Resolution of "all the Anthropic ones" happens here, off the
// client pipeline snapshot — the model never sees or invents URLs.

import type { Application, InboxJob } from "@/lib/career-ops";
import type { Job } from "@/components/jobs/job-store";

export const AUTO_FIRE_MAX = 3; // fire ≤3 evaluations silently; confirm above that
export const BATCH_CAP = 12; // hard ceiling on a single fan-out

// Canonical states (templates/states.yml) — the web validates against the same set.
const CANON_STATUS = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP"];

const TAB_VALUES = [
  "INBOX", "ALL", "EVALUATED", "APPLIED", "RESPONDED", "INTERVIEW", "OFFER", "REJECTED", "DISCARDED", "SKIP",
] as const;
const SORT_VALUES = ["company", "role", "score", "status", "date"] as const;

export type StartJobInput = {
  title: string;
  subtitle?: string;
  kind: string;
  input: string;
  page?: string;
  batchId?: string;
};

export type ActionCtx = {
  push: (path: string) => void; // router.push — section/detail change
  replace: (path: string) => void; // router.replace — incremental filter tweak
  startJob: (opts: StartJobInput) => string | null;
  inbox: InboxJob[];
  applications: Application[]; // tracker snapshot — resolve #n → company/role for confirms
  jobForUrl: (url: string) => Job | undefined; // skip-if-done / retry logic
  rememberFact: (fact: string) => void;
  writeStatus: (n: string, status: string) => void; // UPDATE-only writeback via /api/status
  setApplyField: (idOrLabel: string, value: string) => void; // edit an apply-proxy answer
  startApply: (url: string) => void; // open the apply form-proxy for a posting URL
  applyExplore?: (patch: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => void; // build a FREE discovery search
  writeProfile?: (patch: Record<string, unknown>) => void; // merge-safe config/profile.yml write
  writePortals?: (roles: string[], location?: string[]) => void; // merge-safe portals.yml title_filter write
};

export type ProfilePatch = {
  name?: string;
  email?: string;
  location?: string;
  roles?: string[];
  compMin?: number;
  compMax?: number;
  currency?: string;
  remote?: string;
  seniority?: string;
};

// House-style hand validation (no zod). Keeps only well-formed, confident fields.
function coerceProfile(raw: Record<string, unknown>): ProfilePatch {
  const out: ProfilePatch = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  out.name = str(raw.name);
  out.email = str(raw.email);
  out.location = str(raw.location);
  out.currency = str(raw.currency);
  out.remote = str(raw.remote);
  out.seniority = str(raw.seniority);
  out.compMin = num(raw.compMin);
  out.compMax = num(raw.compMax);
  if (Array.isArray(raw.roles)) out.roles = raw.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim()).slice(0, 6);
  return out;
}

export type DoneInfo = { jobIds?: string[]; batchId?: string; note?: string };
export type DispatchResult =
  | ({ status: "done" } & DoneInfo)
  | { status: "ignored"; note?: string }
  | { status: "confirm"; summary: string; run: () => DoneInfo };

// ── helpers ──────────────────────────────────────────────────────────────
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const normCompany = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Allow only in-app routes (with optional :segment and ?query). Blocks anything
// that isn't one of the app's own sections — the model can't navigate offsite.
function isAllowedPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (/^(https?:)?\/\//i.test(p)) return false;
  const path = p.split(/[?#]/)[0];
  if (path === "/") return true;
  return /^\/(explore|pipeline|portals|analytics|cv|config|apply|jobs)(\/[^/]+)?$/.test(path);
}

function genBatchId(): string {
  return `batch-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

// ── actions ──────────────────────────────────────────────────────────────
type ActionDef = {
  sideEffect: "none" | "spend" | "write";
  // parse returns typed args or null (invalid → envelope ignored)
  run: (raw: Record<string, unknown>, ctx: ActionCtx) => DispatchResult;
};

const ACTIONS: Record<string, ActionDef> = {
  navigate: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const path = raw.path;
      if (!isStr(path) || !isAllowedPath(path)) return { status: "ignored", note: "导航已被阻止" };
      ctx.push(path);
      return { status: "done" };
    },
  },

  filterPipeline: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const sp = new URLSearchParams();
      const tab = typeof raw.tab === "string" ? raw.tab.toUpperCase() : "";
      if ((TAB_VALUES as readonly string[]).includes(tab)) sp.set("tab", tab);
      const min = typeof raw.min === "number" ? raw.min : parseFloat(String(raw.min ?? ""));
      if (Number.isFinite(min) && min >= 0 && min <= 5) sp.set("min", String(min));
      if (isStr(raw.q)) sp.set("q", String(raw.q).slice(0, 80));
      const sort = typeof raw.sort === "string" ? raw.sort : "";
      if ((SORT_VALUES as readonly string[]).includes(sort)) sp.set("sort", sort);
      const dir = Number(raw.dir);
      if (dir === 1 || dir === -1) sp.set("dir", String(dir));
      const qs = sp.toString();
      ctx.replace(`/pipeline${qs ? `?${qs}` : ""}`);
      return { status: "done" };
    },
  },

  evaluate: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const url = raw.url;
      if (!isStr(url) || !/^https?:\/\//i.test(url)) return { status: "ignored", note: "链接无效" };
      const ex = ctx.jobForUrl(url);
      if (ex && ex.status !== "error" && !raw.rerun) return { status: "ignored", note: "该职位已评估" };
      const id = ctx.startJob({
        title: isStr(raw.title) ? String(raw.title) : "评估职位",
        subtitle: isStr(raw.subtitle) ? String(raw.subtitle) : undefined,
        kind: "evaluate",
        input: url,
        page: "/pipeline",
      });
      return { status: "done", jobIds: id ? [id] : [] };
    },
  },

  evaluateCompany: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const company = raw.company;
      if (!isStr(company)) return { status: "ignored", note: "缺少公司名称" };
      const target = normCompany(company);
      const rerun = raw.rerun === true;
      const cap = Number.isFinite(Number(raw.max)) ? Math.min(BATCH_CAP, Number(raw.max)) : BATCH_CAP;

      // statusScope: only 'inbox' is supported (Application rows carry no URL).
      const matches = ctx.inbox.filter((j) => {
        if (j.done) return false;
        const c = normCompany(j.company);
        return c === target || c.includes(target) || target.includes(c);
      });
      const pending = matches
        .filter((j) => {
          if (rerun) return true;
          const ex = ctx.jobForUrl(j.url);
          return !ex || ex.status === "error";
        })
        .slice(0, cap);

      if (pending.length === 0) {
        return {
          status: "ignored",
          note: matches.length > 0 ? `${company} 的职位均已评估。` : `收件箱中没有待处理的 ${company} 职位。`,
        };
      }

      const fire = (): DoneInfo => {
        const batchId = pending.length > 1 ? genBatchId() : undefined;
        const ids = pending
          .map((j) =>
            ctx.startJob({
              title: `Evaluate · ${j.company}`,
              subtitle: j.role,
              kind: "evaluate",
              input: j.url,
              page: "/pipeline",
              batchId,
            }),
          )
          .filter((x): x is string => !!x);
        return { jobIds: ids, batchId };
      };

      if (pending.length <= AUTO_FIRE_MAX) return { status: "done", ...fire() };
      return {
        status: "confirm",
        summary: `要评估 ${pending.length} 个 ${company} 职位吗？（约需 ${pending.length} 个任务）`,
        run: fire,
      };
    },
  },

  explore: {
    // FREE: opens the Explorer and builds a discovery search. Zero tokens — it
    // never spends, so it bypasses the confirm gate. The provider clamps/validates.
    sideEffect: "none",
    run: (raw, ctx) => {
      if (!ctx.applyExplore) return { status: "ignored", note: "当前页面无法使用职位发现" };
      const run = raw.run === true;
      const merge = raw.merge === true;
      ctx.push("/explore");
      ctx.applyExplore(raw, { merge, run });
      return { status: "done", note: run ? "正在免费扫描 ATS 网络中的新职位…" : "已使用你的筛选条件打开职位发现。" };
    },
  },

  research: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const target = raw.target;
      if (!isStr(target)) return { status: "ignored", note: "缺少调研目标" };
      const id = ctx.startJob({
        title: isStr(raw.title) ? String(raw.title) : "公司调研",
        kind: "research",
        input: target,
        page: "/pipeline",
      });
      return { status: "done", jobIds: id ? [id] : [] };
    },
  },

  generatePdf: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const n = String(raw.n ?? "").trim();
      if (!n) return { status: "ignored", note: "需要申请编号" };
      const app = ctx.applications.find((a) => a.n === n);
      const id = ctx.startJob({ title: `简历 PDF · ${app?.company ?? `#${n}`}`, subtitle: "定制简历", kind: "pdf", input: n, page: `/pipeline/${n}` });
      return { status: "done", jobIds: id ? [id] : [] };
    },
  },

  setStatus: {
    sideEffect: "write",
    run: (raw, ctx) => {
      const n = String(raw.n ?? "").trim();
      const status = String(raw.status ?? "").trim();
      const canon = CANON_STATUS.find((s) => s.toLowerCase() === status.toLowerCase());
      if (!n || !canon) return { status: "ignored", note: "需要申请编号和有效状态" };
      const app = ctx.applications.find((a) => a.n === n);
      const label = app ? `${app.company} · ${app.role}` : `#${n}`;
      return {
        status: "confirm",
        summary: `Mark ${label} → ${canon}?`,
        run: () => {
          ctx.writeStatus(n, canon);
          return { note: `Marked #${n} as ${canon}.` };
        },
      };
    },
  },

  apply: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const url = raw.url;
      if (!isStr(url) || !/^https?:\/\//i.test(url)) return { status: "ignored", note: "需要申请表链接" };
      ctx.startApply(url);
      return { status: "done", note: "正在打开申请表…" };
    },
  },

  setApplyField: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const field = (raw.field ?? raw.label) as unknown;
      const value = raw.value;
      if (!isStr(field) || typeof value !== "string") return { status: "ignored", note: "需要字段名称和内容" };
      ctx.setApplyField(String(field), value);
      return { status: "done", note: `已更新“${field}”。` };
    },
  },

  remember: {
    sideEffect: "write",
    run: (raw, ctx) => {
      const fact = raw.fact;
      if (!isStr(fact)) return { status: "ignored" };
      ctx.rememberFact(String(fact).trim());
      return { status: "done" };
    },
  },

  // Propose the user's profile → on confirm, merge-safe write to config/profile.yml
  // AND seed the scanner (portals.yml title_filter) so the very first scan has roles.
  // DATA_CONTRACT: deep-merge only proposed keys; never clobber archetypes/narrative.
  setProfile: {
    sideEffect: "write",
    run: (raw, ctx) => {
      if (!ctx.writeProfile) return { status: "ignored", note: "当前无法写入个人资料" };
      const p = coerceProfile(raw);
      const has = Object.values(p).some((v) => (Array.isArray(v) ? v.length : v !== undefined));
      if (!has) return { status: "ignored", note: "没有需要保存的内容" };
      const bits = [p.roles?.length ? `roles: ${p.roles.join(", ")}` : "", p.location ? `in ${p.location}` : "", p.compMin && p.compMax ? `comp ${p.compMin}–${p.compMax}` : ""].filter(Boolean).join(" · ");
      return {
        status: "confirm",
        summary: `要保存个人资料吗？${bits ? `（${bits}）` : ""}`,
        run: () => {
          ctx.writeProfile!(p as Record<string, unknown>);
          if (p.roles?.length) ctx.writePortals?.(p.roles, p.location ? [p.location] : undefined);
          return { note: "个人资料已保存，后续匹配会更准确。" };
        },
      };
    },
  },

  setPortals: {
    sideEffect: "write",
    run: (raw, ctx) => {
      if (!ctx.writePortals) return { status: "ignored", note: "当前无法写入招聘门户配置" };
      const roles = Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim()) : [];
      if (roles.length === 0) return { status: "ignored", note: "没有目标职位" };
      const location = Array.isArray(raw.location) ? raw.location.filter((l): l is string => typeof l === "string") : undefined;
      return {
        status: "confirm",
        summary: `要将扫描目标设为：${roles.join("、")}？`,
        run: () => {
          ctx.writePortals!(roles, location);
          return { note: "扫描目标已更新。" };
        },
      };
    },
  },
};

export function actionExists(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTIONS, id);
}

export function dispatch(id: string, rawArgs: Record<string, unknown>, ctx: ActionCtx): DispatchResult {
  const def = ACTIONS[id];
  if (!def) return { status: "ignored", note: `未知操作：${id}` };
  try {
    return def.run(rawArgs ?? {}, ctx);
  } catch {
    return { status: "ignored", note: `无法执行 ${id}` };
  }
}
