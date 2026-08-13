"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  MessageSquareQuote,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import type {
  ProjectInterviewCatalog,
  ProjectInterviewPack,
  ProjectInterviewQuestion,
  ProjectInterviewReview,
} from "@/lib/project-interview-types";

type Cli = { id: string; name: string; installed: boolean; projectInterviewAvailable?: boolean };
type BusyState = "" | "pack" | "review";
type GenerationMode = "ai" | "deterministic-fallback";

const CATEGORY_LABELS: Record<ProjectInterviewQuestion["category"], string> = {
  overview: "项目总览",
  ownership: "本人责任",
  architecture: "架构链路",
  mechanism: "技术深挖",
  tradeoff: "方案取舍",
  reliability: "可靠性与边界",
};

const DEPTH_LABELS: Record<ProjectInterviewQuestion["depth"], string> = {
  foundation: "基础",
  deep: "深挖",
  pressure: "压力追问",
};

const STATUS_LABELS: Record<ProjectInterviewReview["status"], string> = {
  strong: "Strong · 可上场",
  solid: "Solid · 基本到位",
  gap: "Gap · 需要补强",
};

const DIMENSION_LABELS: Array<[keyof ProjectInterviewReview["dimension_scores"], string]> = [
  ["structure", "结论与结构"],
  ["ownership", "本人责任"],
  ["technical_depth", "技术深度"],
  ["evidence", "事实与验证"],
  ["boundary", "边界意识"],
];

async function jsonBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string; details?: unknown };
  if (!response.ok) {
    const codes = Array.isArray(body.details)
      ? [...new Set(body.details.map((item) => item && typeof item === "object" && "code" in item ? String(item.code) : "").filter(Boolean))]
      : [];
    throw new Error(`${body.error || `请求失败（HTTP ${response.status}）`}${codes.length ? `（${codes.join("、")}）` : ""}`);
  }
  return body as T;
}

function FactBadges({ ids }: { ids: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="回答依据">
      {ids.map((id) => <span key={id} className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-faint">{id}</span>)}
    </div>
  );
}

function BulletList({ items, tone = "default" }: { items: string[]; tone?: "default" | "warning" | "success" }) {
  const marker = tone === "warning" ? "text-amber-600" : tone === "success" ? "text-emerald-600" : "text-brand-text";
  return (
    <ul className="space-y-2 text-sm leading-6 text-muted">
      {items.map((item, index) => <li key={`${index}-${item}`} className="flex gap-2"><span className={`mt-2 size-1.5 shrink-0 rounded-full ${marker} bg-current`} /><span>{item}</span></li>)}
    </ul>
  );
}

export function ProjectInterviewWorkbench() {
  const [catalog, setCatalog] = useState<ProjectInterviewCatalog | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [clis, setClis] = useState<Cli[]>([]);
  const [cliId, setCliId] = useState("");
  const [pack, setPack] = useState<ProjectInterviewPack | null>(null);
  const [practiceQuestion, setPracticeQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [review, setReview] = useState<ProjectInterviewReview | null>(null);
  const [packGenerationMode, setPackGenerationMode] = useState<GenerationMode>("ai");
  const [reviewGenerationMode, setReviewGenerationMode] = useState<GenerationMode>("ai");
  const [expandedAnswers, setExpandedAnswers] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<BusyState>("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const packRequest = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const reviewRequest = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/cn/interviews/projects").then((response) => jsonBody<ProjectInterviewCatalog>(response)),
      fetch("/api/clis").then((response) => jsonBody<{ clis: Cli[] }>(response)),
    ]).then(([nextCatalog, cliResponse]) => {
      if (cancelled) return;
      const available = cliResponse.clis.filter((item) => item.id === "codex" && item.projectInterviewAvailable);
      const nextSource = nextCatalog.sources.find((item) => item.id === nextCatalog.default_source_id) || nextCatalog.sources[0];
      setCatalog(nextCatalog);
      setClis(available);
      setCliId(available[0]?.id || "");
      setSourceId(nextSource?.id || "");
      setProjectId(nextSource?.projects[0]?.id || "");
      setTargetRole(nextSource?.target_job_title || "AI 应用开发工程师");
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "面试中心初始化失败");
    }).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      packRequest.current.controller?.abort();
      reviewRequest.current.controller?.abort();
    };
  }, []);

  const source = useMemo(() => catalog?.sources.find((item) => item.id === sourceId) || null, [catalog, sourceId]);
  const project = useMemo(() => source?.projects.find((item) => item.id === projectId) || null, [source, projectId]);
  const cliName = clis.find((item) => item.id === cliId)?.name || "AI";

  function cancelInFlight() {
    packRequest.current.controller?.abort();
    reviewRequest.current.controller?.abort();
    packRequest.current = { id: packRequest.current.id + 1, controller: null };
    reviewRequest.current = { id: reviewRequest.current.id + 1, controller: null };
    setBusy("");
  }

  function resetTraining() {
    cancelInFlight();
    setPack(null);
    setPracticeQuestion("");
    setAnswer("");
    setReview(null);
    setPackGenerationMode("ai");
    setReviewGenerationMode("ai");
    setExpandedAnswers(new Set());
    setError("");
  }

  function chooseSource(nextId: string) {
    const nextSource = catalog?.sources.find((item) => item.id === nextId);
    setSourceId(nextId);
    setProjectId(nextSource?.projects[0]?.id || "");
    setTargetRole(nextSource?.target_job_title || targetRole);
    resetTraining();
  }

  function chooseProject(nextId: string) {
    setProjectId(nextId);
    resetTraining();
  }

  function chooseTargetRole(nextRole: string) {
    setTargetRole(nextRole);
    resetTraining();
  }

  function chooseCli(nextId: string) {
    setCliId(nextId);
    resetTraining();
  }

  async function generatePack() {
    if (!source || !project || !cliId) return;
    resetTraining();
    const controller = new AbortController();
    const requestId = packRequest.current.id + 1;
    packRequest.current = { id: requestId, controller };
    setBusy("pack");
    try {
      const response = await fetch("/api/cn/interviews/projects/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: source.id, project_id: project.id, target_role: targetRole, cliId }),
        signal: controller.signal,
      });
      const generationMode = response.headers.get("X-CareerPilot-Generation-Mode") === "deterministic-fallback"
        ? "deterministic-fallback" : "ai";
      const nextPack = await jsonBody<ProjectInterviewPack>(response);
      if (controller.signal.aborted || packRequest.current.id !== requestId) return;
      setPack(nextPack);
      setPackGenerationMode(generationMode);
      setPracticeQuestion(nextPack.questions[0]?.question || "");
      setAnswer("");
      setReview(null);
      setExpandedAnswers(new Set());
    } catch (reason) {
      if (!controller.signal.aborted && packRequest.current.id === requestId) {
        setError(reason instanceof Error ? reason.message : "项目训练包生成失败");
      }
    } finally {
      if (packRequest.current.id === requestId) {
        packRequest.current.controller = null;
        setBusy("");
      }
    }
  }

  async function reviewAnswer() {
    if (!source || !project || !cliId || !practiceQuestion || !answer.trim()) return;
    reviewRequest.current.controller?.abort();
    const controller = new AbortController();
    const requestId = reviewRequest.current.id + 1;
    reviewRequest.current = { id: requestId, controller };
    setBusy("review");
    setError("");
    try {
      const response = await fetch("/api/cn/interviews/projects/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_id: source.id,
          project_id: project.id,
          target_role: targetRole,
          question: practiceQuestion,
          answer: answer.trim(),
          cliId,
        }),
        signal: controller.signal,
      });
      const generationMode = response.headers.get("X-CareerPilot-Generation-Mode") === "deterministic-fallback"
        ? "deterministic-fallback" : "ai";
      const nextReview = await jsonBody<ProjectInterviewReview>(response);
      if (controller.signal.aborted || reviewRequest.current.id !== requestId) return;
      setReview(nextReview);
      setReviewGenerationMode(generationMode);
    } catch (reason) {
      if (!controller.signal.aborted && reviewRequest.current.id === requestId) {
        setError(reason instanceof Error ? reason.message : "回答点评失败");
      }
    } finally {
      if (reviewRequest.current.id === requestId) {
        reviewRequest.current.controller = null;
        setBusy("");
      }
    }
  }

  function practice(question: string) {
    cancelInFlight();
    setPracticeQuestion(question);
    setAnswer("");
    setReview(null);
    setReviewGenerationMode("ai");
    document.getElementById("mock-interview")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function continueWithFollowUp() {
    if (!review) return;
    setPracticeQuestion(review.follow_up_question);
    setAnswer("");
    setReview(null);
    setReviewGenerationMode("ai");
  }

  function toggleReference(id: string) {
    setExpandedAnswers((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (!ready) {
    return <div className="flex min-h-80 items-center justify-center text-sm text-muted"><LoaderCircle className="mr-2 size-4 animate-spin" />正在核对正式简历与项目事实…</div>;
  }

  return (
    <div className="space-y-7">
      <section className="rounded-2xl border border-border bg-surface p-5 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-text"><ShieldCheck className="size-4" />可信简历快照</div>
            <h2 className="mt-2 text-xl font-semibold">先选正式简历，再训练其中的项目</h2>
            <p className="mt-2 text-sm leading-6 text-muted">只向模型发送当前项目中已确认、有证据并允许用于面试的 Fact。团队项目的“参与”不会被改写成“独立主导”。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[36rem]">
            <label className="text-sm"><span className="mb-1.5 block text-muted">正式简历版本</span><select aria-label="正式简历版本" value={sourceId} onChange={(event) => chooseSource(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2.5 outline-none focus:border-brand/60"><option value="">暂无可用正式简历</option>{catalog?.sources.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label className="text-sm"><span className="mb-1.5 block text-muted">目标岗位</span><input aria-label="目标岗位" value={targetRole} onChange={(event) => chooseTargetRole(event.target.value)} maxLength={120} className="w-full rounded-lg border border-border bg-background px-3 py-2.5 outline-none focus:border-brand/60" placeholder="如：AI 应用开发工程师" /></label>
          </div>
        </div>
      </section>

      {!source ? (
        <section className="rounded-2xl border border-dashed border-border p-8 text-center"><BookOpenCheck className="mx-auto size-8 text-faint" /><h2 className="mt-3 text-lg font-semibold">还没有通过 QA 的正式简历</h2><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">先在主简历工作室确认并导出 PDF 或 DOCX，面试中心才会按那份简历里的项目生成训练内容。</p><Link href="/cv" className="mt-4 inline-flex items-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground">前往主简历工作室<ArrowRight className="ml-2 size-4" /></Link></section>
      ) : (
        <section aria-labelledby="resume-projects-title">
          <div className="flex items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-faint">简历项目</p><h2 id="resume-projects-title" className="mt-1 text-2xl font-semibold">这份简历中的 {source.projects.length} 个项目</h2></div><p className="hidden text-xs text-faint sm:block">生成时间 {new Date(source.generated_at).toLocaleString("zh-CN")}</p></div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {source.projects.map((item, index) => {
              const selected = item.id === projectId;
              return <button key={item.id} type="button" aria-pressed={selected} onClick={() => chooseProject(item.id)} className={`group rounded-xl border p-4 text-left transition-colors ${selected ? "border-brand/60 bg-brand-soft" : "border-border bg-surface hover:bg-surface-hover"}`}><div className="flex items-center justify-between"><span className={`flex size-8 items-center justify-center rounded-lg text-xs font-bold ${selected ? "bg-brand text-brand-foreground" : "bg-background text-faint"}`}>{String(index + 1).padStart(2, "0")}</span><span className="text-xs text-faint">{item.fact_count} 条事实</span></div><h3 className="mt-4 text-lg font-semibold">{item.name}</h3><p className="mt-2 line-clamp-3 text-sm leading-6 text-muted">{item.summary}</p></button>;
            })}
          </div>
        </section>
      )}

      {project && <section className="rounded-2xl border border-border bg-surface p-5 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl"><div className="flex items-center gap-2 text-brand-text"><Target className="size-4" /><span className="text-xs font-semibold uppercase tracking-[0.16em]">当前训练项目</span></div><h2 className="mt-2 text-2xl font-semibold">{project.name}</h2><p className="mt-2 text-sm leading-6 text-muted">{project.summary}</p><p className="mt-2 text-xs leading-5 text-faint">AI 只选择 Fact、题型深度和评分；可复述答案由服务端按 Fact 哈希用完整原文组装。</p><div className="mt-3"><FactBadges ids={project.fact_ids} /></div></div>
          <div className="flex min-w-64 flex-col gap-2"><label className="text-sm"><span className="mb-1.5 block text-muted">隔离提案模型</span><select aria-label="隔离提案模型" value={cliId} onChange={(event) => chooseCli(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2.5"><option value="">未找到可用的 Codex</option>{clis.map((cli) => <option key={cli.id} value={cli.id}>{cli.name}</option>)}</select></label><button type="button" onClick={generatePack} disabled={!cliId || busy !== ""} className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground disabled:opacity-50">{busy === "pack" ? <><LoaderCircle className="mr-2 size-4 animate-spin" />{cliName} 正在生成训练包…</> : pack ? <><RefreshCw className="mr-2 size-4" />重新生成训练包</> : <><Sparkles className="mr-2 size-4" />生成分析、题目与参考答案</>}</button>{!cliId && <Link href="/config" className="text-center text-xs text-brand-text hover:underline">先登录并安装 Codex</Link>}</div>
        </div>
      </section>}

      <div aria-live="polite" className="min-h-6">{error && <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div>}</div>

      {pack && <>
        {packGenerationMode === "deterministic-fallback" && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200"><strong>确定性安全降级：</strong>模型连续两次未通过结构/事实校验，本训练包由 CareerPilot 只用已确认 Fact 生成，未采用有效模型计划。</div>}
        <section className="space-y-4" aria-labelledby="project-analysis-title">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-text">AI 项目拆解</p><h2 id="project-analysis-title" className="mt-1 text-2xl font-semibold">面试官会从哪里深挖</h2></div>
          <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
            <article className="rounded-2xl border border-border bg-surface p-5"><div className="flex items-center gap-2"><BrainCircuit className="size-5 text-brand-text" /><h3 className="font-semibold">项目定位</h3></div><p className="mt-3 leading-7 text-muted">{pack.analysis.positioning}</p><div className="mt-4"><FactBadges ids={pack.analysis.source_fact_ids} /></div></article>
            <article className="rounded-2xl border border-border bg-surface p-5"><h3 className="font-semibold">面试官关注点</h3><div className="mt-3"><BulletList items={pack.analysis.interviewer_focus} /></div></article>
            <article className="rounded-2xl border border-border bg-surface p-5"><h3 className="font-semibold">必须守住的表述边界</h3><div className="mt-3"><BulletList items={pack.analysis.claim_boundaries} tone="warning" /></div></article>
            <article className="rounded-2xl border border-border bg-surface p-5"><h3 className="font-semibold">面试前优先准备</h3><div className="mt-3"><BulletList items={pack.analysis.preparation_priorities} tone="success" /></div></article>
          </div>
          <article className="rounded-2xl border border-brand/30 bg-brand-soft p-5 md:p-6"><div className="flex items-center gap-2 text-brand-text"><MessageSquareQuote className="size-5" /><h3 className="font-semibold">60 秒项目开场参考</h3></div><p className="mt-3 font-medium">{pack.opening_answer.headline}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-muted">{pack.opening_answer.answer}</p>{pack.opening_answer.unknowns.length > 0 && <div className="mt-4 rounded-lg border border-amber-500/30 bg-background/70 p-3"><p className="text-xs font-semibold text-amber-700 dark:text-amber-300">面试前复核清单</p><div className="mt-2"><BulletList items={pack.opening_answer.unknowns} tone="warning" /></div></div>}<div className="mt-4"><FactBadges ids={pack.opening_answer.source_fact_ids} /></div></article>
        </section>

        <section className="space-y-4" aria-labelledby="question-bank-title">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-faint">六类项目题</p><h2 id="question-bank-title" className="mt-1 text-2xl font-semibold">从基础介绍到压力追问</h2><p className="mt-2 text-sm text-muted">先自己回答，再展开参考答案；也可以直接把任意一题送入模拟面试。</p></div>
          <div className="space-y-3">{pack.questions.map((question, index) => {
            const expanded = expandedAnswers.has(question.id);
            return <article key={question.id} className="rounded-xl border border-border bg-surface p-4 md:p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-xs font-bold text-faint">{index + 1}</span><div><div className="flex flex-wrap gap-2"><span className="rounded-full bg-brand-soft px-2 py-1 text-[11px] font-semibold text-brand-text">{CATEGORY_LABELS[question.category]}</span><span className="rounded-full border border-border px-2 py-1 text-[11px] text-faint">{DEPTH_LABELS[question.depth]}</span></div><h3 className="mt-3 text-base font-semibold leading-7">{question.question}</h3><p className="mt-2 text-sm leading-6 text-muted">考察意图：{question.intent}</p></div></div><button type="button" onClick={() => practice(question.question)} className="inline-flex shrink-0 items-center justify-center rounded-lg border border-brand/40 px-3 py-2 text-sm font-medium text-brand-text hover:bg-brand-soft">模拟这题<ArrowRight className="ml-2 size-4" /></button></div><div className="mt-4 border-t border-border pt-4"><button type="button" onClick={() => toggleReference(question.id)} aria-expanded={expanded} className="flex w-full items-center justify-between text-left text-sm font-medium"><span>{expanded ? "收起参考答案" : "查看评分点、参考答案与追问"}</span><ChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></button>{expanded && <div className="mt-4 grid gap-4 lg:grid-cols-2"><div className="rounded-lg bg-background/70 p-4"><h4 className="text-sm font-semibold">评分点</h4><div className="mt-2"><BulletList items={question.scoring_points} /></div><h4 className="mt-4 text-sm font-semibold">自然追问</h4><div className="mt-2"><BulletList items={question.follow_ups} /></div></div><div className="rounded-lg bg-background/70 p-4"><h4 className="text-sm font-semibold">{question.reference_answer.headline}</h4><div className="mt-2"><BulletList items={question.reference_answer.points} tone="success" /></div>{question.reference_answer.unknowns.length > 0 && <div className="mt-3"><p className="text-xs font-semibold text-amber-700 dark:text-amber-300">复核清单（不要猜）</p><div className="mt-1"><BulletList items={question.reference_answer.unknowns} tone="warning" /></div></div>}<div className="mt-3"><FactBadges ids={question.reference_answer.source_fact_ids} /></div></div></div>}</div></article>;
          })}</div>
        </section>

        <section id="mock-interview" className="scroll-mt-6 rounded-2xl border border-border bg-surface p-5 md:p-6" aria-labelledby="mock-interview-title">
          <div className="flex items-center gap-2 text-brand-text"><MessageSquareQuote className="size-5" /><p className="text-xs font-semibold uppercase tracking-[0.16em]">一次一题模拟</p></div><h2 id="mock-interview-title" className="mt-2 text-2xl font-semibold">现在由 AI 面试官追问</h2><p className="mt-2 text-sm leading-6 text-muted">按真实面试作答。提交后会得到五维评分、事实核验、更强版本和一个自然追问。</p>
          <div className="mt-5 rounded-xl border border-brand/30 bg-brand-soft p-4"><p className="text-xs font-semibold text-brand-text">面试官</p><p className="mt-2 text-base font-medium leading-7">{practiceQuestion}</p></div>
          <label className="mt-4 block"><span className="mb-2 block text-sm font-medium">你的回答</span><textarea aria-label="你的项目面试回答" value={answer} onChange={(event) => { setAnswer(event.target.value); setReview(null); }} disabled={busy === "review"} maxLength={6000} rows={7} placeholder="建议按：场景 → 本人责任 → 方案与取舍 → 验证 → 当前边界" className="w-full resize-y rounded-xl border border-border bg-background p-4 text-sm leading-7 outline-none focus:border-brand/60 disabled:opacity-70" /></label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-faint">{answer.length}/6000 · 新增指标会被标为待核实</p><button type="button" onClick={reviewAnswer} disabled={!answer.trim() || busy !== ""} className="inline-flex items-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground disabled:opacity-50">{busy === "review" ? <><LoaderCircle className="mr-2 size-4 animate-spin" />{cliName} 正在点评…</> : <><BrainCircuit className="mr-2 size-4" />提交回答并获取点评</>}</button></div>

          {review && <div className="mt-6 space-y-4 border-t border-border pt-6" aria-live="polite">{reviewGenerationMode === "deterministic-fallback" && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200"><strong>确定性安全降级：</strong>模型点评未通过协议，本结果未采用模型语义评分；0 分仅表示未评分，仍保留本地事实核验与 Fact-only 更强版本。</div>}<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-faint">本题结果</p><h3 className="mt-1 text-xl font-semibold">{reviewGenerationMode === "deterministic-fallback" ? "安全降级 · 未进行模型评分" : STATUS_LABELS[review.status]}</h3></div><div className="flex items-end gap-1"><span className="text-4xl font-semibold text-brand-text">{review.score}</span><span className="pb-1 text-sm text-faint">/100</span></div></div><div className="grid gap-2 sm:grid-cols-5">{DIMENSION_LABELS.map(([key, label]) => <div key={key} className="rounded-lg bg-background/70 p-3"><p className="text-xs text-faint">{label}</p><p className="mt-1 text-lg font-semibold">{review.dimension_scores[key]}<span className="text-xs font-normal text-faint">/20</span></p></div>)}</div><div className="grid gap-4 lg:grid-cols-2"><div className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-4"><div className="flex items-center gap-2 text-sky-700 dark:text-sky-300"><CheckCircle2 className="size-4" /><h4 className="text-sm font-semibold">表达观察（事实另核）</h4></div><div className="mt-2"><BulletList items={review.landed} /></div></div><div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4"><div className="flex items-center gap-2 text-amber-700 dark:text-amber-300"><AlertTriangle className="size-4" /><h4 className="text-sm font-semibold">需加强</h4></div><div className="mt-3 space-y-3">{review.sharpen.map((item, index) => <div key={`${index}-${item.issue}`}><p className="text-sm font-medium">{item.issue}</p><p className="mt-1 text-sm leading-6 text-muted">怎么改：{item.repair}</p></div>)}</div></div></div>{review.unsupported_claims.length > 0 && <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-4"><h4 className="text-sm font-semibold text-red-700 dark:text-red-300">当前事实无法核验</h4><div className="mt-3 space-y-2">{review.unsupported_claims.map((item, index) => <div key={`${index}-${item.claim}`} className="text-sm"><span className="font-medium">“{item.claim}”</span><span className="text-muted"> — {item.reason}</span></div>)}</div></div>}<div className="rounded-xl border border-brand/30 bg-brand-soft p-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-text">不增加事实的更强版本</p><h4 className="mt-2 font-semibold">{review.stronger_version.headline}</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-muted">{review.stronger_version.answer}</p><div className="mt-3"><FactBadges ids={review.stronger_version.source_fact_ids} /></div></div><div className="rounded-xl border border-border bg-background/70 p-4"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">面试官继续追问</p><p className="mt-2 font-medium leading-7">{review.follow_up_question}</p><button type="button" onClick={continueWithFollowUp} className="mt-3 inline-flex items-center rounded-lg border border-brand/40 px-3 py-2 text-sm font-medium text-brand-text hover:bg-brand-soft">继续回答追问<ArrowRight className="ml-2 size-4" /></button></div></div>}
        </section>
      </>}
    </div>
  );
}
