"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Baseline = { id: string; template: string; status: string; fact_count: number };
type ResumeFact = { id: string; type: string; statement: string };
type RewriteReview = { fact_id: string; original_statement: string; proposed_statement: string; status: "pending" | "accepted" | "rejected" };
type TailoringChange = { fact_id: string; type: "added" | "removed" | "rewritten" | "reordered"; before: string | null; after: string | null; confirmation_status: "confirmed" | "pending" | "rejected" };
type TailoringPreview = {
  id: string; job_id: string; baseline_variant_id: string; changed_fact_ids: string[]; change_ratio: number; maximum_change_ratio: number;
  allowed: boolean; block_reasons: string[]; rewrite_reviews: RewriteReview[]; changes: TailoringChange[];
  proposed_variant: { fact_ids: string[]; order: string[]; rewrites: Array<{ fact_id: string; proposed_statement: string; accepted: boolean }> };
};
type RewriteDraft = { proposed_statement: string; status: "pending" | "accepted" | "rejected" };

const BLOCK_LABELS: Record<string, string> = {
  tailoring_limit_exceeded: "事实改动超过 30%", eligibility_blocked: "资格结论尚不允许定制",
  rewrite_confirmation_pending: "仍有候选改写待逐条接受或拒绝",
};

export function ResumeTailoringPanel({ jobId, initialPreviewId }: { jobId: string; initialPreviewId?: string }) {
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [baselineId, setBaselineId] = useState("");
  const [facts, setFacts] = useState<ResumeFact[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [rewrites, setRewrites] = useState<Record<string, RewriteDraft>>({});
  const [preview, setPreview] = useState<TailoringPreview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const factById = useMemo(() => new Map(facts.map((fact) => [fact.id, fact])), [facts]);
  const displayFacts = useMemo(() => [
    ...order.map((id) => factById.get(id)).filter(Boolean) as ResumeFact[],
    ...facts.filter((fact) => !order.includes(fact.id)),
  ], [factById, facts, order]);

  async function refreshBaselines(select?: string) {
    const response = await fetch("/api/cn/resumes/baselines");
    const data = await response.json();
    const items = (data.variants || []) as Baseline[];
    setBaselines(items);
    setBaselineId(select || items[0]?.id || "");
  }

  useEffect(() => { void refreshBaselines(); }, []);
  useEffect(() => {
    if (!baselineId) { setFacts([]); setSelected([]); setOrder([]); return; }
    let cancelled = false;
    if (!initialPreviewId) { setPreview(null); setRewrites({}); }
    void fetch(`/api/cn/resumes/baselines/${encodeURIComponent(baselineId)}`).then((response) => response.json()).then((data) => {
      if (cancelled) return;
      const nextFacts = (data.facts || []) as ResumeFact[];
      setFacts(nextFacts); setSelected(nextFacts.map((item) => item.id)); setOrder(nextFacts.map((item) => item.id));
    });
    return () => { cancelled = true; };
  }, [baselineId, initialPreviewId]);
  useEffect(() => {
    if (!initialPreviewId) return;
    void fetch(`/api/cn/resumes/tailor-preview/${encodeURIComponent(initialPreviewId)}`).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "岗位简历预览读取失败");
      const loaded = data.preview as TailoringPreview;
      setPreview(loaded); setBaselineId(loaded.baseline_variant_id); setSelected(loaded.proposed_variant.fact_ids); setOrder(loaded.proposed_variant.order);
      setRewrites(Object.fromEntries(loaded.rewrite_reviews.map((item) => [item.fact_id, { proposed_statement: item.proposed_statement, status: item.status }])));
      if (!data.validation?.valid) setMessage("该岗位简历已过期，请基于当前岗位、Profile 和主简历重新计算。");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "岗位简历预览读取失败"));
  }, [initialPreviewId]);

  function toggleFact(id: string, enabled: boolean) {
    setSelected((current) => enabled ? [...current, id] : current.filter((item) => item !== id));
    setOrder((current) => enabled ? [...current, id] : current.filter((item) => item !== id));
    setPreview(null);
  }

  function move(id: string, delta: number) {
    setOrder((current) => {
      const index = current.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setPreview(null);
  }

  function updateRewrite(fact: ResumeFact, update: Partial<RewriteDraft>) {
    setRewrites((current) => ({
      ...current,
      [fact.id]: {
        proposed_statement: update.proposed_statement ?? current[fact.id]?.proposed_statement ?? fact.statement,
        status: update.status ?? current[fact.id]?.status ?? "pending",
      },
    }));
    setPreview(null);
  }

  async function calculatePreview() {
    if (!baselineId) return;
    setBusy(true); setMessage("");
    const ordered = order.filter((id) => selectedSet.has(id));
    const rewriteReviews = Object.entries(rewrites).filter(([, item]) => item.proposed_statement.trim()).map(([factId, item]) => ({
      fact_id: factId, proposed_statement: item.proposed_statement.trim(), status: item.status,
    }));
    const response = await fetch("/api/cn/resumes/tailor-preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, baseline_variant_id: baselineId, fact_ids: ordered, order: ordered, rewrite_reviews: rewriteReviews, save: true }),
    });
    const data = await response.json();
    if (response.ok) { setPreview(data.preview); setMessage("岗位简历预览已保存，可在统一简历工作室重新打开。"); }
    else setMessage(`${data.error || "定制预览计算失败"}${data.details ? `：${JSON.stringify(data.details)}` : ""}`);
    setBusy(false);
  }

  async function suggestRewrites() {
    if (!baselineId) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/cn/resumes/tailor-suggest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, baseline_variant_id: baselineId }),
    });
    const data = await response.json();
    if (response.ok) {
      const candidates = data.candidates as Array<{ fact_id: string; proposed_statement: string }>;
      setRewrites((current) => ({ ...current, ...Object.fromEntries(candidates.map((item) => [item.fact_id, { proposed_statement: item.proposed_statement, status: "pending" }])) }));
      setPreview(null);
      setMessage(candidates.length ? `已生成 ${candidates.length} 条仅重排原事实的候选改写，请逐条接受或拒绝。` : "没有发现可安全重排且与岗位更相关的多分句事实。");
    } else setMessage(data.error || "候选改写生成失败");
    setBusy(false);
  }

  async function exportResume(format: string) {
    if (!preview?.allowed) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/cn/resumes/tailor-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview, format }) });
    const data = await response.json();
    setMessage(response.ok ? `已导出：${data.path}；导出记录已进入简历工作室` : data.error || "导出失败");
    setBusy(false);
  }

  return <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
    <div><p className="text-xs font-semibold uppercase tracking-wider text-brand-text">岗位简历</p><h2 className="mt-1 text-xl font-semibold">事实级取舍、排序与受控改写</h2><p className="mt-1 text-sm text-muted">每条改写必须绑定 Fact ID 并逐条接受或拒绝；唯一事实改动超过 30% 时无法导出。</p></div>
    <div className="flex flex-wrap gap-2"><select className="min-w-64 rounded-md border border-border bg-background px-3 py-2" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}><option value="">选择已确认主简历</option>{baselines.map((item) => <option key={item.id} value={item.id}>{item.template} · {item.fact_count} 条事实</option>)}</select><button type="button" disabled={busy || !baselineId} onClick={suggestRewrites} className="rounded-md border border-border px-3 py-2 disabled:opacity-50">生成证据约束候选改写</button><Link href="/cv" className="rounded-md border border-border px-3 py-2 hover:bg-surface-hover">打开统一简历工作室</Link></div>
    {displayFacts.length > 0 && <div className="space-y-3">{displayFacts.map((fact) => {
      const included = selectedSet.has(fact.id); const rewrite = rewrites[fact.id]; const position = order.indexOf(fact.id);
      return <article key={fact.id} className="rounded-lg border border-border p-3 text-sm"><div className="flex gap-3"><input type="checkbox" checked={included} onChange={(event) => toggleFact(fact.id, event.target.checked)} /><div className="min-w-0 flex-1"><p className="font-medium">{fact.statement}</p><p className="mt-1 text-xs text-faint">{fact.id} · {fact.type}</p></div>{included && <div className="flex gap-1"><button type="button" disabled={position <= 0} onClick={() => move(fact.id, -1)} className="rounded border border-border px-2 disabled:opacity-30">↑</button><button type="button" disabled={position < 0 || position >= order.length - 1} onClick={() => move(fact.id, 1)} className="rounded border border-border px-2 disabled:opacity-30">↓</button></div>}</div>
        {included && <div className="mt-3 border-t border-border pt-3"><label className="text-xs font-medium text-muted">候选改写（只能重排原事实，不得增加新主张）</label><textarea className="mt-1 min-h-16 w-full rounded-md border border-border bg-background px-3 py-2" value={rewrite?.proposed_statement ?? ""} onChange={(event) => updateRewrite(fact, { proposed_statement: event.target.value, status: "pending" })} placeholder={fact.statement} /><div className="mt-2 flex gap-2"><button type="button" disabled={!rewrite?.proposed_statement.trim()} onClick={() => updateRewrite(fact, { status: "accepted" })} className={`rounded-md px-3 py-1.5 text-xs ${rewrite?.status === "accepted" ? "bg-emerald-600 text-white" : "border border-border"}`}>接受改写</button><button type="button" disabled={!rewrite?.proposed_statement.trim()} onClick={() => updateRewrite(fact, { status: "rejected" })} className={`rounded-md px-3 py-1.5 text-xs ${rewrite?.status === "rejected" ? "bg-brand text-brand-foreground" : "border border-border"}`}>拒绝改写</button></div></div>}
      </article>;
    })}<button type="button" disabled={busy || !baselineId} onClick={calculatePreview} className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50">{busy ? "正在计算…" : "保存并生成完整差异预览"}</button></div>}
    {preview && <div className={`rounded-lg border p-4 ${preview.allowed ? "border-emerald-500/40 bg-emerald-500/5" : "border-brand/50 bg-brand-soft"}`}><p className="text-2xl font-semibold">{Math.round(preview.change_ratio * 100)}%</p><p className="text-sm text-muted">已改变 {preview.changed_fact_ids.length} 条唯一事实；允许上限 30%</p>{!preview.allowed && <p className="mt-2 text-sm text-brand-text">已阻断：{preview.block_reasons.map((reason) => BLOCK_LABELS[reason] || reason).join("、")}</p>}<div className="mt-3 space-y-2">{preview.changes.map((change, index) => <div key={`${change.fact_id}-${change.type}-${index}`} className="rounded-md border border-border/70 bg-background/50 p-3 text-xs"><p className="font-medium">{change.type} · {change.fact_id} · {change.confirmation_status}</p><p className="mt-1 text-muted">改前：{change.before ?? "无"}</p><p className="mt-1 text-muted">改后：{change.after ?? "无"}</p></div>)}</div>{preview.allowed && <div className="mt-3 flex flex-wrap gap-2">{["md", "docx", "pdf"].map((format) => <button key={format} type="button" disabled={busy} onClick={() => exportResume(format)} className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground">导出 {format.toUpperCase()}</button>)}</div>}</div>}
    {message && <p className="text-sm text-muted">{message}</p>}
  </section>;
}
