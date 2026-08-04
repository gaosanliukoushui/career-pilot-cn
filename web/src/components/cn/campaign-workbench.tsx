"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Campaign } from "@/lib/cn-types";

type ImportResult = { imported: string[]; duplicates: Array<{ index: number; reason: string }>; failures: Array<{ index: number; message: string }> };

export function CampaignWorkbench({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [urls, setUrls] = useState("");
  const [texts, setTexts] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionReason, setSelectionReason] = useState("");
  const [excludeReasons, setExcludeReasons] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [mutualConstraints, setMutualConstraints] = useState("");
  const maxApplications = useMemo(() => Number(campaign?.constraints.find((item) => item.kind === "max_applications" && item.confirmation_status === "confirmed")?.value || 0), [campaign]);

  async function refresh() {
    const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(campaignId)}`, { cache: "no-store" });
    const data = await response.json();
    if (response.ok) { setCampaign(data.campaign); setSelected(data.campaign.selection?.job_ids || []); }
    else setMessage(data.error || "Campaign 读取失败");
  }
  useEffect(() => { void refresh(); }, [campaignId]);

  async function importSources() {
    const urlSources = urls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ kind: "url", url }));
    const textSources = texts.split(/\r?\n-{3,}\r?\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ kind: "text", text }));
    const sources = [...urlSources, ...textSources];
    if (!sources.length) return;
    setBusy("import"); setMessage("");
    const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(campaignId)}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources }) });
    const data = await response.json();
    if (response.ok) {
      const failed = new Set<number>((data.failures || []).map((item: { index: number }) => item.index));
      setImportResult(data);
      setUrls(urlSources.filter((_, index) => failed.has(index)).map((item) => item.url).join("\n"));
      setTexts(textSources.filter((_, index) => failed.has(index + urlSources.length)).map((item) => item.text).join("\n---\n"));
      await refresh();
    }
    else setMessage(data.error || "批量导入失败");
    setBusy("");
  }

  async function importFiles() {
    if (!files.length) return;
    setBusy("files"); setMessage("");
    const form = new FormData(); files.forEach((file) => form.append("files", file));
    const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(campaignId)}/import`, { method: "POST", body: form });
    const data = await response.json();
    if (response.ok) {
      const failed = new Set<number>((data.failures || []).map((item: { index: number }) => item.index));
      setImportResult(data);
      setFiles((current) => current.filter((_, index) => failed.has(index)));
      await refresh();
    }
    else setMessage(data.error || "文件导入失败");
    setBusy("");
  }

  async function rank() {
    setBusy("rank"); setMessage("");
    const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(campaignId)}/rank`, { method: "POST" });
    const data = await response.json();
    if (response.ok) { setCampaign(data.campaign); setSelected([]); }
    else setMessage(`${data.error || "暂时无法排名"}${data.details ? `：${JSON.stringify(data.details)}` : ""}`);
    setBusy("");
  }

  async function saveConstraints() {
    setBusy("constraints"); setMessage("");
    try {
      const mutuallyExclusive = mutualConstraints.trim() ? JSON.parse(mutualConstraints) : [];
      if (!Array.isArray(mutuallyExclusive)) throw new Error("互斥岗位必须是 JSON 数组");
      const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(campaignId)}/constraints`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mutually_exclusive: mutuallyExclusive }) });
      const data = await response.json();
      if (response.ok) { setCampaign(data.campaign); setMessage("互斥岗位约束已确认，既有排名与选岗已失效。"); }
      else setMessage(data.error || "互斥约束保存失败");
    } catch (error) { setMessage(error instanceof Error ? error.message : "互斥约束格式错误"); }
    setBusy("");
  }

  function toggle(jobId: string) {
    setSelected((current) => current.includes(jobId) ? current.filter((id) => id !== jobId) : current.length < maxApplications ? [...current, jobId] : current);
  }

  async function confirmSelection() {
    setBusy("select"); setMessage("");
    const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(campaignId)}/select`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_ids: selected, reason: selectionReason }) });
    const data = await response.json();
    if (response.ok) { setCampaign(data.campaign); setMessage("最终岗位已人工确认；现在可以生成 Fact Diff 定向简历。"); }
    else setMessage(data.error || "选岗确认失败");
    setBusy("");
  }

  async function exclude(jobId: string) {
    const reason = excludeReasons[jobId]?.trim();
    if (!reason) return;
    setBusy(`exclude:${jobId}`); setMessage("");
    const response = await fetch(`/api/cn/campaigns/${encodeURIComponent(campaignId)}/exclude`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId, reason }) });
    const data = await response.json();
    if (response.ok) { setCampaign(data.campaign); setSelected([]); }
    else setMessage(data.error || "排除岗位失败");
    setBusy("");
  }

  if (!campaign) return <div className="mx-auto max-w-6xl p-8 text-muted">正在读取 Campaign…{message}</div>;
  return <div className="mx-auto max-w-7xl space-y-6 p-5 md:p-8">
    <header><Link href="/campaigns" className="text-sm text-muted hover:text-foreground">← 返回 Campaign 列表</Link><h1 className="mt-3 text-3xl font-semibold">{campaign.name}</h1><p className="mt-2 text-muted">{campaign.employer} · 最多投 {maxApplications} 个 · {campaign.deadline ? `截止 ${campaign.deadline}` : "未填写截止日期"}</p></header>
    <section className="grid gap-4 rounded-xl border border-border bg-surface p-5 lg:grid-cols-2"><div><h2 className="font-semibold">批量链接</h2><textarea value={urls} onChange={(event) => setUrls(event.target.value)} className="mt-2 min-h-36 w-full rounded-md border border-border bg-background p-3" placeholder="每行一个官网岗位链接" /></div><div><h2 className="font-semibold">多个文本块</h2><textarea value={texts} onChange={(event) => setTexts(event.target.value)} className="mt-2 min-h-36 w-full rounded-md border border-border bg-background p-3" placeholder={'岗位原文\n---\n另一个岗位原文'} /></div><div className="flex flex-wrap items-center gap-3 lg:col-span-2"><button type="button" disabled={Boolean(busy) || (!urls.trim() && !texts.trim())} onClick={importSources} className="rounded-md bg-brand px-4 py-2 text-brand-foreground disabled:opacity-50">导入链接与文本</button><label className="rounded-md border border-border px-4 py-2 text-sm"><input type="file" multiple accept=".pdf,.docx" className="mr-2" onChange={(event) => setFiles(Array.from(event.target.files || []))} />多个 PDF/DOCX</label><button type="button" disabled={Boolean(busy) || !files.length} onClick={importFiles} className="rounded-md border border-border px-4 py-2 disabled:opacity-50">导入 {files.length || ""} 个文件</button></div></section>
    {importResult && <section className="rounded-lg border border-border bg-surface p-4 text-sm"><p>成功 {importResult.imported.length} · 重复 {importResult.duplicates.length} · 失败 {importResult.failures.length}</p>{importResult.failures.map((failure) => <p key={`${failure.index}-${failure.message}`} className="mt-1 text-brand-text">来源 {failure.index + 1}：{failure.message}</p>)}</section>}
    <details className="rounded-xl border border-border bg-surface p-5"><summary className="cursor-pointer font-semibold">确认互斥岗位约束（可选）</summary><p className="mt-2 text-sm text-muted">使用已导入的岗位 ID；每组至少两个岗位，并保留招聘公告原文。</p><textarea value={mutualConstraints} onChange={(event) => setMutualConstraints(event.target.value)} className="mt-3 min-h-28 w-full rounded-md border border-border bg-background p-3 font-mono text-xs" placeholder={'[{"job_ids":["job.xxx","job.yyy"],"source_quote":"这两个岗位不可同时投递"}]'} /><button type="button" disabled={Boolean(busy)} onClick={saveConstraints} className="mt-2 rounded-md border border-border px-4 py-2 disabled:opacity-50">确认互斥约束</button></details>
    {message && <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">{message}</p>}
    <section className="rounded-xl border border-border bg-surface p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">岗位确认队列</h2><p className="mt-1 text-sm text-muted">每个岗位都必须完成规则确认和确定性评估；Campaign 不会跳过单岗位门禁。</p></div><button type="button" disabled={Boolean(busy) || !campaign.jobs.length} onClick={rank} className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50">生成可解释排名</button></div><div className="mt-4 space-y-2">{campaign.jobs.map((job) => <div key={job.job_id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"><span className={`rounded-full px-2 py-1 text-xs ${job.status === "excluded" ? "bg-brand-soft text-brand-text" : "bg-background"}`}>{job.status === "excluded" ? "已排除" : "待核对"}</span><code className="min-w-0 flex-1 break-all text-xs">{job.job_id}</code>{job.status === "included" && <><Link href={`/job-analysis?job=${encodeURIComponent(job.job_id)}&campaign=${encodeURIComponent(campaign.id)}`} className="rounded-md border border-border px-3 py-1.5 text-sm">确认 / 评估</Link><input value={excludeReasons[job.job_id] || ""} onChange={(event) => setExcludeReasons({ ...excludeReasons, [job.job_id]: event.target.value })} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" placeholder="关闭或排除理由" /><button type="button" disabled={Boolean(busy) || !excludeReasons[job.job_id]?.trim()} onClick={() => exclude(job.job_id)} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40">排除</button></>}</div>)}</div></section>
    {campaign.ranking.status === "ready" && <section className="space-y-4"><div><h2 className="text-xl font-semibold">横向排名</h2><p className="text-sm text-muted">界面仅显示一位小数；内部排序保留精确分值，并依次比较资格、建议、匹配分、Fact 覆盖率、缺口和稳定岗位 ID。</p></div>{campaign.ranking.entries.map((entry) => <article key={entry.job_id} className={`rounded-xl border p-5 ${selected.includes(entry.job_id) ? "border-brand bg-brand-soft/30" : "border-border bg-surface"}`}><div className="flex flex-wrap items-start gap-4"><button type="button" onClick={() => toggle(entry.job_id)} className={`grid size-10 place-items-center rounded-full font-semibold ${selected.includes(entry.job_id) ? "bg-brand text-brand-foreground" : "bg-background"}`}>{entry.rank}</button><div className="min-w-0 flex-1"><h3 className="text-lg font-semibold">{entry.title}</h3><p className="mt-1 text-sm text-muted">资格 {entry.eligibility} · 建议 {entry.recommendation} · 匹配 {entry.fit_score.toFixed(1)} / 5 · Fact 覆盖 {(entry.fact_coverage * 100).toFixed(1)}% · 缺口 {entry.gap_count}</p><div className="mt-3 grid gap-3 lg:grid-cols-3"><div><p className="text-xs font-semibold">硬门槛</p>{entry.hard_rule_results.map((rule) => <p key={rule.rule_id} className="mt-1 text-xs">{rule.result} · {rule.reason}</p>)}</div><div><p className="text-xs font-semibold">可引用证据</p><p className="mt-1 text-xs text-muted">{entry.evidence_fact_ids.join("、") || "暂无"}</p></div><div><p className="text-xs font-semibold">缺口 / 不确定项</p><p className="mt-1 text-xs text-muted">{[...entry.gaps, ...entry.unknowns].join("；") || "无"}</p></div></div></div></div></article>)}<div className="flex flex-wrap gap-3 rounded-xl border border-border bg-surface p-4"><input value={selectionReason} onChange={(event) => setSelectionReason(event.target.value)} className="min-w-72 flex-1 rounded-md border border-border bg-background px-3 py-2" placeholder="人工选岗理由" /><button type="button" disabled={Boolean(busy) || !selected.length || selected.length > maxApplications || !selectionReason.trim()} onClick={confirmSelection} className="rounded-md bg-brand px-4 py-2 text-brand-foreground disabled:opacity-50">确认选择 {selected.length}/{maxApplications}</button></div></section>}
    {campaign.selection.status === "confirmed" && <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5"><h2 className="font-semibold">已确认最终岗位</h2><p className="mt-1 text-sm text-muted">{campaign.selection.reason}</p><div className="mt-4 flex flex-wrap gap-2">{campaign.selection.job_ids.map((jobId) => <Link key={jobId} href={`/job-analysis?job=${encodeURIComponent(jobId)}&campaign=${encodeURIComponent(campaign.id)}`} className="rounded-md bg-foreground px-4 py-2 text-background">Fact Diff、正式导出与申请材料</Link>)}</div></section>}
  </div>;
}
