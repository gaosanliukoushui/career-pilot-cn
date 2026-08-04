"use client";

import { useEffect, useMemo, useState } from "react";
import type { Campaign, CareerPilotApplication, FitDimension, JobPosting, JobRule, MatchReport } from "@/lib/cn-types";
import { ApplicationPanel } from "@/components/cn/application-panel";
import { ResumeTailoringPanel } from "@/components/cn/resume-tailoring-panel";

type SourceKind = "text" | "url" | "file";
type Cli = { id: string; name: string; installed: boolean; proposalAvailable?: boolean };

const RULE_LABELS: Record<string, string> = {
  degree: "学历", major_name: "专业", major_code: "专业代码", graduation_date: "毕业时间", cohort: "毕业届别",
  fresh_graduate_status: "应届生身份", language_certificate: "英语等级", credential: "资格证书", location: "地点", political_status: "政治面貌",
};
const RULE_FIELDS = Object.keys(RULE_LABELS);
const OPERATORS = ["equals", "one_of", "contains_any", "at_least", "between", "before_or_equal"];
const EMPLOYER_TYPES = ["central_soe", "local_soe", "bank", "telecom", "public_institution", "private", "foreign", "unknown"];
const RESULT_LABELS = { satisfied: "通过", failed: "不符合", unknown: "待补资料" } as const;
const RECOMMENDATION_LABELS = { apply: "建议申请", consider: "谨慎考虑", do_not_apply: "不建议申请", need_more_info: "先补资料" } as const;

function parseExpected(value: string): unknown {
  const clean = value.trim();
  if (!clean) return "";
  try { return JSON.parse(clean); } catch { return clean; }
}

function expectedText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function JobAnalysisWorkbench({ initialJobId, initialTailoringId, campaignId }: { initialJobId?: string; initialTailoringId?: string; campaignId?: string }) {
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
  const [officialSourceConfirmed, setOfficialSourceConfirmed] = useState(false);
  const [officialSourceEvidence, setOfficialSourceEvidence] = useState("");
  const [formFieldDefinitions, setFormFieldDefinitions] = useState("");
  const [materialDefinitions, setMaterialDefinitions] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [finalResumeManifest, setFinalResumeManifest] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [targetCampaign, setTargetCampaign] = useState("");

  useEffect(() => {
    void fetch("/api/clis").then((response) => response.json()).then((data) => {
      const installed = (data.clis || []).filter((item: Cli) => item.proposalAvailable) as Cli[];
      setClis(installed); setCliId(installed[0]?.id || "");
    });
  }, []);
  useEffect(() => {
    if (campaignId) return;
    void fetch("/api/cn/campaigns").then((response) => response.json()).then((data) => {
      setCampaigns(data.campaigns || []);
      setTargetCampaign(data.campaigns?.[0]?.id || "");
    });
  }, [campaignId]);
  useEffect(() => {
    if (!initialJobId) return;
    void fetch(`/api/cn/jobs/${encodeURIComponent(initialJobId)}`).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "已保存岗位读取失败");
      setPosting(data.posting); setReport(data.report);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "已保存岗位读取失败"));
  }, [initialJobId]);

  const hardRules = useMemo(() => posting?.rules.filter((rule) => rule.severity === "hard" && rule.confirmation_status === "confirmed") || [], [posting]);
  const pendingRules = useMemo(() => posting?.rules.filter((rule) => rule.confirmation_status === "pending") || [], [posting]);

  function editPosting(update: (current: JobPosting) => JobPosting) {
    setPosting((current) => current ? {
      ...update(current),
      confirmation: { status: "pending", confirmed_at: null, structure_sha256: null },
    } : current);
    setProposal(null); setReport(null); setApplication(null);
  }

  function editRule(index: number, update: Partial<JobRule>) {
    editPosting((current) => ({
      ...current,
      rules: current.rules.map((rule, currentIndex) => currentIndex === index ? { ...rule, ...update } : rule),
    }));
  }

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
    if (response.ok) {
      setPosting(data);
      setOfficialSourceConfirmed(Boolean(data.source?.official));
      setOfficialSourceEvidence(data.source?.official_evidence || "");
    } else setError(data.error || "岗位解析失败");
    setBusy("");
  }

  async function confirmPosting() {
    if (!posting) return;
    if (pendingRules.length) { setError(`仍有 ${pendingRules.length} 条规则待逐条确认或拒绝`); return; }
    setBusy("confirm"); setError("");
    const response = await fetch("/api/cn/jobs/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posting, official_source_confirmed: officialSourceConfirmed, official_source_evidence: officialSourceEvidence }),
    });
    const data = await response.json();
    if (response.ok) setPosting(data);
    else setError(`${data.error || "岗位确认失败"}${data.details ? `：${JSON.stringify(data.details)}` : ""}`);
    setBusy("");
  }

  async function askAi() {
    if (!posting || posting.confirmation.status !== "confirmed" || !cliId) return;
    setBusy("ai"); setError("");
    const response = await fetch("/api/cn/jobs/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ posting, cliId }) });
    const data = await response.json();
    if (response.ok) setProposal(data);
    else setError(data.error || "AI 匹配建议失败；仍可使用中性分数继续资格硬筛");
    setBusy("");
  }

  async function addToCampaign() {
    if (!posting || !targetCampaign) return;
    setBusy("campaign"); setError("");
    const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(targetCampaign)}/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: [{ kind: "posting", posting }] }),
    });
    const data = await response.json();
    if (response.ok) setError(data.duplicates?.length ? "该岗位已在 Campaign 中。" : "岗位已加入 Campaign；请回到 Campaign 完成其余岗位确认与排名。");
    else setError(data.error || "加入 Campaign 失败");
    setBusy("");
  }

  async function evaluate() {
    if (!posting || posting.confirmation.status !== "confirmed") return;
    setBusy("evaluate"); setError("");
    const payload = { posting, ...(proposal || {}), ...(overrideReason.trim() ? { override_reason: overrideReason.trim() } : {}) };
    const response = await fetch("/api/cn/jobs/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (response.ok) setReport(data.report);
    else setError(`${data.error || "岗位评估失败"}${data.details ? `：${JSON.stringify(data.details)}` : ""}`);
    setBusy("");
  }

  async function prepareApplication() {
    if (!report) return;
    if (campaignId && !finalResumeManifest) {
      setError("Campaign 申请包必须先生成并通过 QA 的最终 DOCX 或 PDF 简历。");
      return;
    }
    setBusy("application"); setError("");
    let formFields: unknown[] = [];
    let materials: unknown[] = [];
    try {
      formFields = formFieldDefinitions.trim() ? JSON.parse(formFieldDefinitions) : [];
      materials = materialDefinitions.trim() ? JSON.parse(materialDefinitions) : [];
      if (!Array.isArray(formFields) || !Array.isArray(materials)) throw new Error("定义必须是 JSON 数组");
    } catch (reason) {
      setError(`岗位表单或材料定义不是有效 JSON 数组：${reason instanceof Error ? reason.message : "格式错误"}`);
      setBusy(""); return;
    }
    const response = await fetch("/api/cn/applications/prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: report.job_id,
        ...(campaignId ? { campaign_id: campaignId, resume_manifest: finalResumeManifest } : {}),
        ...(formFieldDefinitions.trim() ? { form_fields: formFields } : {}),
        ...(materialDefinitions.trim() ? { materials } : {}),
      }),
    });
    const data = await response.json();
    if (response.ok) setApplication(data.application);
    else setError(data.error || "网申材料准备失败");
    setBusy("");
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-5 md:p-8">
      <header>
        {campaignId && <a href={`/campaigns/${encodeURIComponent(campaignId)}`} className="mb-3 inline-block text-sm text-muted hover:text-foreground">← 返回多岗位 Campaign</a>}
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">CareerPilot CN · V2/V3</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">岗位导入、规则确认与资格分析</h1>
        <p className="mt-2 max-w-3xl text-muted">先逐条核对招聘公告中的硬条件，再进行确定性资格判断。AI 只能读取已授权事实并提交受 Schema 约束的软匹配建议。</p>
      </header>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex flex-wrap gap-2">
          {(["text", "url", "file"] as const).map((kind) => <button key={kind} type="button" onClick={() => setSourceKind(kind)} className={`rounded-full px-4 py-2 text-sm ${sourceKind === kind ? "bg-foreground text-background" : "border border-border hover:bg-surface-hover"}`}>{kind === "text" ? "粘贴文本" : kind === "url" ? "官网链接" : "PDF / DOCX"}</button>)}
        </div>
        {sourceKind === "text" && <textarea className="min-h-64 w-full rounded-lg border border-border bg-background p-4 outline-none focus:border-brand" value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴岗位描述或完整招聘公告……" />}
        {sourceKind === "url" && <input className="w-full rounded-lg border border-border bg-background p-3 outline-none focus:border-brand" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://单位官网/招聘公告" />}
        {sourceKind === "file" && <label className="block rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted"><input className="mx-auto mb-3 block" type="file" accept=".pdf,.docx" onChange={(event) => setFile(event.target.files?.[0] || null)} />读取文本型 PDF/DOCX；图片型文件会明确提示需要 OCR</label>}
        <button type="button" disabled={Boolean(busy)} onClick={parseSource} className="mt-4 rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground disabled:opacity-50">{busy === "parse" ? "正在解析…" : "提取为待确认岗位"}</button>
      </section>

      {error && <div className="rounded-lg border border-brand/40 bg-brand-soft p-4 text-sm text-brand-text">{error}</div>}

      {posting && (
        <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-lg font-semibold">岗位结构确认</h2><p className="text-sm text-muted">状态：{posting.confirmation.status === "confirmed" ? `已确认 · ${posting.confirmation.confirmed_at}` : `待确认 · ${pendingRules.length} 条规则未处理`}</p></div>
            {posting.confirmation.status === "confirmed" && <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-700 dark:text-emerald-400">结构哈希已锁定</span>}
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm"><span className="mb-1 block font-medium">招聘单位</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.employer.name} onChange={(event) => editPosting((current) => ({ ...current, employer: { ...current.employer, name: event.target.value } }))} /></label>
            <label className="text-sm"><span className="mb-1 block font-medium">单位类型</span><select className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.employer.type} onChange={(event) => editPosting((current) => ({ ...current, employer: { ...current.employer, type: event.target.value } }))}>{EMPLOYER_TYPES.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label className="text-sm"><span className="mb-1 block font-medium">岗位名称</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.title} onChange={(event) => editPosting((current) => ({ ...current, title: event.target.value }))} /></label>
            <label className="text-sm"><span className="mb-1 block font-medium">岗位代码</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.job_code || ""} onChange={(event) => editPosting((current) => ({ ...current, job_code: event.target.value }))} /></label>
            <label className="text-sm"><span className="mb-1 block font-medium">招聘届别</span><input type="number" className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.recruitment.cohort || ""} onChange={(event) => editPosting((current) => ({ ...current, recruitment: { ...current.recruitment, cohort: event.target.value ? Number(event.target.value) : undefined } }))} /></label>
            <label className="text-sm"><span className="mb-1 block font-medium">截止日期</span><input type="date" className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.recruitment.deadline || ""} onChange={(event) => editPosting((current) => ({ ...current, recruitment: { ...current.recruitment, deadline: event.target.value || undefined } }))} /></label>
            <label className="text-sm md:col-span-2 lg:col-span-3"><span className="mb-1 block font-medium">工作地点（描述字段，不自动淘汰）</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={posting.locations.join("、")} onChange={(event) => editPosting((current) => ({ ...current, locations: event.target.value.split(/[、，,；;]/).map((item) => item.trim()).filter(Boolean) }))} /></label>
          </div>

          {["public_url", "official_url"].includes(posting.source.kind) && <div className="rounded-lg border border-border bg-background/50 p-4 text-sm">
            <p className="font-medium">URL 来源核对</p>
            <p className="mt-1 break-all text-xs text-muted">最终地址：{posting.source.final_url || posting.source.ref} · 页面标题：{posting.source.page_title || "未识别"} · 抓取：{posting.source.fetched_at || posting.captured_at}</p>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={officialSourceConfirmed} onChange={(event) => { setOfficialSourceConfirmed(event.target.checked); editPosting((current) => current); }} />我已核对该域名或招聘平台确属招聘单位官方来源</label>
            <input className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2" value={officialSourceEvidence} onChange={(event) => { setOfficialSourceEvidence(event.target.value); editPosting((current) => current); }} placeholder="说明依据，例如：单位官网域名跳转至统一招聘平台" />
          </div>}

          <div>
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">资格规则（已确认 {hardRules.length} 条硬规则）</h2><p className="text-xs text-muted">每条规则都要保留原文，并选择“确认”或“拒绝”；“优先/建议”只能是软条件。</p></div><button type="button" onClick={() => editPosting((current) => ({ ...current, rules: [...current.rules, { id: `rule.custom.${crypto.randomUUID().replaceAll("-", "")}`, field: "degree", operator: "equals", expected: "", severity: "soft", explicit: true, source_quote: "", confidence: 1, confirmation_status: "pending" }] }))} className="rounded-md border border-border px-3 py-2 text-sm">新增规则</button></div>
            <div className="mt-3 space-y-3">{posting.rules.length ? posting.rules.map((rule, index) => <article key={rule.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="grid gap-2 md:grid-cols-4">
                <select className="rounded-md border border-border bg-background px-2 py-2" value={rule.field} onChange={(event) => editRule(index, { field: event.target.value })}>{RULE_FIELDS.map((field) => <option key={field} value={field}>{RULE_LABELS[field]}</option>)}</select>
                <select className="rounded-md border border-border bg-background px-2 py-2" value={rule.operator} onChange={(event) => editRule(index, { operator: event.target.value })}>{OPERATORS.map((operator) => <option key={operator}>{operator}</option>)}</select>
                <input className="rounded-md border border-border bg-background px-2 py-2" value={expectedText(rule.expected)} onChange={(event) => editRule(index, { expected: parseExpected(event.target.value) })} aria-label={`${rule.id} 期望值`} />
                <select className="rounded-md border border-border bg-background px-2 py-2" value={rule.severity} onChange={(event) => editRule(index, { severity: event.target.value as JobRule["severity"] })}><option value="hard">硬条件</option><option value="soft">软条件</option></select>
              </div>
              <textarea className="mt-2 min-h-16 w-full rounded-md border border-border bg-background px-3 py-2" value={rule.source_quote} onChange={(event) => editRule(index, { source_quote: event.target.value })} placeholder="招聘公告原文引用（硬条件必填）" />
              <div className="mt-2 flex flex-wrap items-center gap-2"><span className="mr-auto text-xs text-faint">{rule.id}</span><button type="button" onClick={() => editRule(index, { confirmation_status: "confirmed" })} className={`rounded-md px-3 py-1.5 text-xs ${rule.confirmation_status === "confirmed" ? "bg-emerald-600 text-white" : "border border-border"}`}>确认规则</button><button type="button" onClick={() => editRule(index, { confirmation_status: "rejected" })} className={`rounded-md px-3 py-1.5 text-xs ${rule.confirmation_status === "rejected" ? "bg-brand text-brand-foreground" : "border border-border"}`}>拒绝规则</button><button type="button" onClick={() => editPosting((current) => ({ ...current, rules: current.rules.filter((_, currentIndex) => currentIndex !== index) }))} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted">删除</button></div>
            </article>) : <p className="rounded-lg bg-surface-hover p-3 text-sm text-muted">未提取到资格规则；仍需人工核对公告后确认整份岗位。</p>}</div>
          </div>
          <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">查看招聘原文快照</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-muted">{posting.raw_text}</pre></details>
          {!campaignId && campaigns.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"><select value={targetCampaign} onChange={(event) => setTargetCampaign(event.target.value)} className="rounded-md border border-border bg-background px-3 py-2">{campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" disabled={Boolean(busy) || !targetCampaign} onClick={addToCampaign} className="rounded-md border border-border px-4 py-2 disabled:opacity-50">加入多岗位 Campaign</button></div>}
          <div className="flex flex-wrap items-end gap-3">
            <button type="button" disabled={Boolean(busy) || posting.confirmation.status === "confirmed" || pendingRules.length > 0} onClick={confirmPosting} className="rounded-md bg-foreground px-5 py-2 text-background disabled:opacity-50">{busy === "confirm" ? "正在确认…" : "确认整份岗位"}</button>
            <label className="text-sm"><span className="mb-1 block text-muted">只读 AI 建议</span><select className="rounded-md border border-border bg-background px-3 py-2" value={cliId} onChange={(event) => setCliId(event.target.value)}><option value="">没有满足安全策略的 CLI</option>{clis.map((cli) => <option key={cli.id} value={cli.id}>{cli.name}</option>)}</select></label>
            <button type="button" disabled={posting.confirmation.status !== "confirmed" || !cliId || Boolean(busy)} onClick={askAi} className="rounded-md border border-border px-4 py-2 hover:bg-surface-hover disabled:opacity-50">{busy === "ai" ? "AI 分析中…" : proposal ? "重新生成 AI 建议" : "生成软匹配建议"}</button>
            <label className="min-w-64 flex-1 text-sm"><span className="mb-1 block text-muted">资格人工覆盖原因（仅不符合/未知时）</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="没有必要时请留空" /></label>
            <button type="button" disabled={posting.confirmation.status !== "confirmed" || Boolean(busy)} onClick={evaluate} className="rounded-md bg-brand px-5 py-2 font-medium text-brand-foreground disabled:opacity-50">{busy === "evaluate" ? "正在计算…" : "执行资格与匹配评估"}</button>
          </div>
          {proposal && <p className="text-sm text-emerald-700 dark:text-emerald-400">AI 建议已返回；最终评估入口会再次执行 Schema、事实用途和敏感级别白名单。</p>}
        </section>
      )}

      {report && <>
        <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
          <div className="grid gap-4 md:grid-cols-3"><div className="rounded-lg bg-surface-hover p-4"><p className="text-xs text-muted">资格结论</p><p className="mt-1 text-2xl font-semibold">{{ eligible: "符合", ineligible: "不符合", unknown: "信息不足" }[report.eligibility.result]}</p></div><div className="rounded-lg bg-surface-hover p-4"><p className="text-xs text-muted">软匹配</p><p className="mt-1 text-2xl font-semibold">{report.fit.score.toFixed(2)} / 5</p></div><div className="rounded-lg bg-surface-hover p-4"><p className="text-xs text-muted">投递建议</p><p className="mt-1 text-2xl font-semibold">{RECOMMENDATION_LABELS[report.recommendation]}</p></div></div>
          <div className="space-y-2">{report.eligibility.rule_results.map((item) => <div key={item.rule_id} className="grid gap-2 rounded-lg border border-border p-3 text-sm md:grid-cols-[7rem_1fr]"><span className={item.result === "satisfied" ? "text-emerald-700 dark:text-emerald-400" : item.result === "failed" ? "text-brand-text" : "text-muted"}>{RESULT_LABELS[item.result]}</span><div><p>{item.reason}</p><p className="mt-1 text-xs text-faint">原文：{item.source_quote || "无"} · 事实：{item.candidate_fact_ids.join(", ") || "待补"}</p></div></div>)}</div>
          {report.override && <div className="rounded-lg border border-brand/40 bg-brand-soft p-3 text-sm text-brand-text">已记录人工覆盖：{report.override.reason}</div>}
          <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">岗位特有表单字段与材料（可选）</summary><p className="mt-2 text-xs text-muted">把官网表单字段或公告材料整理成 JSON 数组。系统会保留定义来源和原文，不会自动提交。</p><div className="mt-3 grid gap-3 lg:grid-cols-2"><label className="text-xs font-medium">表单字段 JSON<textarea aria-label="表单字段 JSON" value={formFieldDefinitions} onChange={(event) => setFormFieldDefinitions(event.target.value)} placeholder={'[{"id":"motivation.why_company","label":"为什么选择本单位","category":"motivation","required":true,"max_length":200,"source_quote":"官网表单原文"}]'} className="mt-1 min-h-28 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" /></label><label className="text-xs font-medium">岗位材料 JSON<textarea aria-label="岗位材料 JSON" value={materialDefinitions} onChange={(event) => setMaterialDefinitions(event.target.value)} placeholder={'[{"id":"recommendation_form","label":"就业推荐表","required":true,"source_quote":"公告原文"}]'} className="mt-1 min-h-28 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" /></label></div></details>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(busy)} onClick={prepareApplication} className="rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground disabled:opacity-50">{busy === "application" ? "正在建立…" : "建立网申材料与进度"}</button><span className="self-center text-xs text-faint">报告：{report.report_path}</span></div>
        </section>
        <ResumeTailoringPanel jobId={report.job_id} initialPreviewId={initialTailoringId} campaignId={campaignId} onFinalExport={setFinalResumeManifest} />
      </>}
      {application && <ApplicationPanel initial={application} />}
    </div>
  );
}
