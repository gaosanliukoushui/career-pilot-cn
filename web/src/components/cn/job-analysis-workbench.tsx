"use client";

import { useEffect, useMemo, useState } from "react";
import type { CareerPilotApplication, FitDimension, JobPosting, MatchReport } from "@/lib/cn-types";
import { ApplicationPanel } from "@/components/cn/application-panel";
import { ResumeTailoringPanel } from "@/components/cn/resume-tailoring-panel";

type SourceKind = "text" | "url" | "file";
type Cli = { id: string; name: string; installed: boolean };

const RULE_LABELS: Record<string, string> = {
  degree: "学历", major_name: "专业", major_code: "专业代码", graduation_date: "毕业时间", cohort: "毕业届别",
  fresh_graduate_status: "应届生身份", language_certificate: "英语等级", credential: "资格证书", location: "地点", political_status: "政治面貌",
};
const RESULT_LABELS = { satisfied: "通过", failed: "不符合", unknown: "待补资料" } as const;
const RECOMMENDATION_LABELS = { apply: "建议申请", consider: "谨慎考虑", do_not_apply: "不建议申请", need_more_info: "先补资料" } as const;

export function JobAnalysisWorkbench() {
  const [sourceKind, setSourceKind] = useState<SourceKind>("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [posting, setPosting] = useState<JobPosting | null>(null);
  const [proposal, setProposal] = useState<{ dimensions: FitDimension[]; strengths: string[]; gaps: string[] } | null>(null);
  const [report, setReport] = useState<MatchReport | null>(null);
  const [application, setApplication] = useState<CareerPilotApplication | null>(null);
  const [clis, setClis] = useState<Cli[]>([]);
  const [cliId, setCliId] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/clis").then((response) => response.json()).then((data) => {
      const installed = (data.clis || []).filter((item: Cli) => item.installed) as Cli[];
      setClis(installed); setCliId(installed[0]?.id || "");
    });
  }, []);

  const hardRules = useMemo(() => posting?.rules.filter((rule) => rule.severity === "hard") || [], [posting]);

  async function parseSource() {
    setBusy("parse"); setError(""); setPosting(null); setProposal(null); setReport(null); setApplication(null);
    let response: Response;
    if (sourceKind === "file") {
      if (!file) { setError("请选择 PDF 或 DOCX 文件"); setBusy(""); return; }
      const form = new FormData(); form.append("file", file);
      response = await fetch("/api/cn/jobs/parse", { method: "POST", body: form });
    } else {
      response = await fetch("/api/cn/jobs/parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourceKind === "url" ? { kind: "url", url } : { kind: "text", text }),
      });
    }
    const data = await response.json();
    if (response.ok) setPosting(data);
    else setError(data.error || "岗位解析失败");
    setBusy("");
  }

  async function askAi() {
    if (!posting || !cliId) return;
    setBusy("ai"); setError("");
    const response = await fetch("/api/cn/jobs/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ posting, cliId }) });
    const data = await response.json();
    if (response.ok) setProposal(data);
    else setError(data.error || "AI 匹配建议失败；仍可使用中性分数继续资格硬筛");
    setBusy("");
  }

  async function evaluate() {
    if (!posting) return;
    setBusy("evaluate"); setError("");
    const payload = { posting, ...(proposal || {}), ...(overrideReason.trim() ? { override_reason: overrideReason.trim() } : {}) };
    const response = await fetch("/api/cn/jobs/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (response.ok) setReport(data.report);
    else setError(data.error || "岗位评估失败");
    setBusy("");
  }

  async function prepareApplication() {
    if (!report) return;
    setBusy("application"); setError("");
    const response = await fetch("/api/cn/applications/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: report.job_id }) });
    const data = await response.json();
    if (response.ok) setApplication(data.application);
    else setError(data.error || "网申材料准备失败");
    setBusy("");
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-5 md:p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">CareerPilot CN · V2/V3</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">岗位导入与资格分析</h1>
        <p className="mt-2 max-w-3xl text-muted">先核对招聘公告中的硬条件，再看证据化匹配。资格结论由本地确定性规则计算，AI 只能提交只读建议。</p>
      </header>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex flex-wrap gap-2">
          {(["text", "url", "file"] as const).map((kind) => <button key={kind} type="button" onClick={() => setSourceKind(kind)} className={`rounded-full px-4 py-2 text-sm ${sourceKind === kind ? "bg-foreground text-background" : "border border-border hover:bg-surface-hover"}`}>{kind === "text" ? "粘贴文本" : kind === "url" ? "官网链接" : "PDF / DOCX"}</button>)}
        </div>
        {sourceKind === "text" && <textarea className="min-h-64 w-full rounded-lg border border-border bg-background p-4 outline-none focus:border-brand" value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴岗位描述或完整招聘公告……" />}
        {sourceKind === "url" && <input className="w-full rounded-lg border border-border bg-background p-3 outline-none focus:border-brand" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://单位官网/招聘公告" />}
        {sourceKind === "file" && <label className="block rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted"><input className="mx-auto mb-3 block" type="file" accept=".pdf,.docx" onChange={(event) => setFile(event.target.files?.[0] || null)} />首版只读取文本型 PDF/DOCX，不执行图片 OCR</label>}
        <button type="button" disabled={Boolean(busy)} onClick={parseSource} className="mt-4 rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground disabled:opacity-50">{busy === "parse" ? "正在解析…" : "提取岗位条件"}</button>
      </section>

      {error && <div className="rounded-lg border border-brand/40 bg-brand-soft p-4 text-sm text-brand-text">{error}</div>}

      {posting && (
        <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm"><span className="mb-1 block font-medium">招聘单位</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.employer.name} onChange={(event) => setPosting({ ...posting, employer: { ...posting.employer, name: event.target.value } })} /></label>
            <label className="text-sm"><span className="mb-1 block font-medium">岗位名称</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.title} onChange={(event) => setPosting({ ...posting, title: event.target.value })} /></label>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted"><span className="rounded-full bg-surface-hover px-3 py-1">{posting.employer.type}</span><span className="rounded-full bg-surface-hover px-3 py-1">{posting.recruitment.track}</span>{posting.recruitment.cohort && <span className="rounded-full bg-surface-hover px-3 py-1">{posting.recruitment.cohort} 届</span>}{posting.recruitment.deadline && <span className="rounded-full bg-surface-hover px-3 py-1">截止 {posting.recruitment.deadline}</span>}</div>
          <div>
            <h2 className="font-semibold">待确认资格规则（{hardRules.length} 条硬规则）</h2>
            <div className="mt-3 space-y-2">{posting.rules.length ? posting.rules.map((rule) => <div key={rule.id} className="rounded-lg border border-border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{RULE_LABELS[rule.field] || rule.field}</span><span className={`rounded-full px-2 py-0.5 text-xs ${rule.severity === "hard" ? "bg-brand-soft text-brand-text" : "bg-surface-hover text-muted"}`}>{rule.severity === "hard" ? "硬条件" : "软条件"}</span></div><p className="mt-1 text-muted">{rule.source_quote || "没有明确原文，不能自动淘汰"}</p></div>) : <p className="rounded-lg bg-surface-hover p-3 text-sm text-muted">未提取到明确硬条件；评估结果会保持谨慎。</p>}</div>
          </div>
          <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">查看招聘原文快照</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-muted">{posting.raw_text}</pre></details>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm"><span className="mb-1 block text-muted">只读 AI 建议</span><select className="rounded-md border border-border bg-background px-3 py-2" value={cliId} onChange={(event) => setCliId(event.target.value)}><option value="">没有可用 CLI</option>{clis.map((cli) => <option key={cli.id} value={cli.id}>{cli.name}</option>)}</select></label>
            <button type="button" disabled={!cliId || Boolean(busy)} onClick={askAi} className="rounded-md border border-border px-4 py-2 hover:bg-surface-hover disabled:opacity-50">{busy === "ai" ? "AI 分析中…" : proposal ? "重新生成 AI 建议" : "生成软匹配建议"}</button>
            <label className="min-w-64 flex-1 text-sm"><span className="mb-1 block text-muted">资格人工覆盖原因（仅不符合/未知时）</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="没有必要时请留空" /></label>
            <button type="button" disabled={Boolean(busy)} onClick={evaluate} className="rounded-md bg-foreground px-5 py-2 text-background disabled:opacity-50">{busy === "evaluate" ? "正在计算…" : "确认并评估"}</button>
          </div>
          {proposal && <p className="text-sm text-emerald-700 dark:text-emerald-400">AI 建议已返回；事实 ID 和分数边界仍会由本地核心复核。</p>}
        </section>
      )}

      {report && (
        <>
          <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg bg-surface-hover p-4"><p className="text-xs text-muted">资格结论</p><p className="mt-1 text-2xl font-semibold">{{ eligible: "符合", ineligible: "不符合", unknown: "信息不足" }[report.eligibility.result]}</p></div>
              <div className="rounded-lg bg-surface-hover p-4"><p className="text-xs text-muted">软匹配</p><p className="mt-1 text-2xl font-semibold">{report.fit.score.toFixed(2)} / 5</p></div>
              <div className="rounded-lg bg-surface-hover p-4"><p className="text-xs text-muted">投递建议</p><p className="mt-1 text-2xl font-semibold">{RECOMMENDATION_LABELS[report.recommendation]}</p></div>
            </div>
            <div className="space-y-2">{report.eligibility.rule_results.map((item) => <div key={item.rule_id} className="grid gap-2 rounded-lg border border-border p-3 text-sm md:grid-cols-[7rem_1fr]"><span className={item.result === "satisfied" ? "text-emerald-700 dark:text-emerald-400" : item.result === "failed" ? "text-brand-text" : "text-muted"}>{RESULT_LABELS[item.result]}</span><div><p>{item.reason}</p><p className="mt-1 text-xs text-faint">原文：{item.source_quote || "无"} · 事实：{item.candidate_fact_ids.join(", ") || "待补"}</p></div></div>)}</div>
            {report.override && <div className="rounded-lg border border-brand/40 bg-brand-soft p-3 text-sm text-brand-text">已记录人工覆盖：{report.override.reason}</div>}
            <div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(busy)} onClick={prepareApplication} className="rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground disabled:opacity-50">{busy === "application" ? "正在建立…" : "建立网申材料与进度"}</button><span className="self-center text-xs text-faint">报告：{report.report_path}</span></div>
          </section>
          <ResumeTailoringPanel jobId={report.job_id} />
        </>
      )}

      {application && <ApplicationPanel initial={application} />}
    </div>
  );
}

