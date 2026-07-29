"use client";

import { useEffect, useMemo, useState } from "react";

type Baseline = { id: string; template: string; status: string; fact_count: number };
type ResumeFact = { id: string; type: string; statement: string };
type TailoringPreview = {
  id: string; job_id: string; changed_fact_ids: string[]; change_ratio: number; maximum_change_ratio: number;
  allowed: boolean; block_reasons: string[]; proposed_variant: { fact_ids: string[]; order: string[] };
};

export function ResumeTailoringPanel({ jobId }: { jobId: string }) {
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [baselineId, setBaselineId] = useState("");
  const [facts, setFacts] = useState<ResumeFact[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<TailoringPreview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  async function refreshBaselines(select?: string) {
    const response = await fetch("/api/cn/resumes/baselines");
    const data = await response.json();
    const items = (data.variants || []) as Baseline[];
    setBaselines(items);
    setBaselineId(select || items[0]?.id || "");
  }

  useEffect(() => { void refreshBaselines(); }, []);
  useEffect(() => {
    if (!baselineId) { setFacts([]); setSelected([]); return; }
    void fetch(`/api/cn/resumes/baselines/${encodeURIComponent(baselineId)}`).then((response) => response.json()).then((data) => {
      const nextFacts = (data.facts || []) as ResumeFact[];
      setFacts(nextFacts); setSelected(nextFacts.map((item) => item.id)); setPreview(null);
    });
  }, [baselineId]);

  async function createBaseline() {
    setBusy(true); setMessage("");
    const response = await fetch("/api/cn/resumes/baselines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: "soe-one-page" }) });
    const data = await response.json();
    if (response.ok) { await refreshBaselines(data.variant.id); setMessage("当前事实主简历已确认为央国企一页版基线"); }
    else setMessage(data.error || "主简历基线创建失败");
    setBusy(false);
  }

  async function calculatePreview() {
    setBusy(true); setMessage("");
    const ordered = facts.map((item) => item.id).filter((id) => selectedSet.has(id));
    const response = await fetch("/api/cn/resumes/tailor-preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, baseline_variant_id: baselineId, fact_ids: ordered, order: ordered }),
    });
    const data = await response.json();
    if (response.ok) setPreview(data.preview);
    else setMessage(data.error || "定制比例计算失败");
    setBusy(false);
  }

  async function exportResume(format: string) {
    if (!preview?.allowed) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/cn/resumes/tailor-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview, format }) });
    const data = await response.json();
    setMessage(response.ok ? `已导出：${data.path}` : data.error || "导出失败");
    setBusy(false);
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-text">岗位简历</p>
        <h2 className="mt-1 text-xl font-semibold">事实级定制，硬上限 30%</h2>
        <p className="mt-1 text-sm text-muted">只调整事实取舍和顺序；超过 30% 时系统不会提供越权导出。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <select className="min-w-64 rounded-md border border-border bg-background px-3 py-2" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
          <option value="">选择已确认主简历</option>
          {baselines.map((item) => <option key={item.id} value={item.id}>{item.template} · {item.fact_count} 条事实</option>)}
        </select>
        <button type="button" disabled={busy} onClick={createBaseline} className="rounded-md border border-border px-3 py-2 hover:bg-surface-hover">将当前事实确认为主简历</button>
      </div>
      {facts.length > 0 && (
        <div className="space-y-2">
          {facts.map((item) => (
            <label key={item.id} className="flex gap-3 rounded-lg border border-border p-3 text-sm">
              <input type="checkbox" checked={selectedSet.has(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
              <span><span className="font-medium">{item.statement}</span><span className="mt-1 block text-xs text-faint">{item.id}</span></span>
            </label>
          ))}
          <button type="button" disabled={busy || !baselineId} onClick={calculatePreview} className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50">计算定制比例</button>
        </div>
      )}
      {preview && (
        <div className={`rounded-lg border p-4 ${preview.allowed ? "border-emerald-500/40 bg-emerald-500/5" : "border-brand/50 bg-brand-soft"}`}>
          <p className="text-2xl font-semibold">{Math.round(preview.change_ratio * 100)}%</p>
          <p className="text-sm text-muted">已改变 {preview.changed_fact_ids.length} 条唯一事实；允许上限 30%</p>
          {!preview.allowed && <p className="mt-2 text-sm text-brand-text">已阻断：{preview.block_reasons.join("、")}</p>}
          {preview.allowed && <div className="mt-3 flex flex-wrap gap-2">{["md", "docx", "pdf"].map((format) => <button key={format} type="button" disabled={busy} onClick={() => exportResume(format)} className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground">导出 {format.toUpperCase()}</button>)}</div>}
        </div>
      )}
      {message && <p className="text-sm text-muted">{message}</p>}
    </section>
  );
}

