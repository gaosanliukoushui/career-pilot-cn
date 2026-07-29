"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Workspace = {
  baselines: Array<{ id: string; template?: string; status?: string; fact_count?: number; confirmed_at?: string | null; stale: boolean }>;
  tailoring_previews: Array<{ id: string; job_id?: string; change_ratio?: number; changed_fact_count?: number; pending_rewrites?: number; allowed?: boolean; stale: boolean }>;
  exports: Array<{ manifest: string; output: string; generated_at: string; variant_id: string; tailoring_preview_id: string | null; job_id: string | null }>;
};

export function ResumeWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>({ baselines: [], tailoring_previews: [], exports: [] });
  const [error, setError] = useState("");
  useEffect(() => { void fetch("/api/cn/resumes/workspace").then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "简历工作室读取失败");
    setWorkspace(data);
  }).catch((reason) => setError(reason instanceof Error ? reason.message : "简历工作室读取失败")); }, []);
  return <section className="mx-auto max-w-[1500px] space-y-5 px-5 pb-10 lg:px-8">
    <div className="border-t border-border pt-7"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">统一简历工作室</p><h2 className="mt-1 text-2xl font-semibold">主简历、岗位变体与导出记录</h2><p className="mt-1 text-sm text-muted">岗位、Profile 或主简历哈希变化后，旧预览会标记为过期，不会静默复用。</p></div>
    {error && <div className="rounded-lg bg-brand-soft p-3 text-sm text-brand-text">{error}</div>}
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-xl border border-border bg-surface p-4"><h3 className="font-semibold">已保存主简历</h3><div className="mt-3 space-y-2">{workspace.baselines.map((item) => <div key={item.id} className="rounded-lg bg-background/60 p-3 text-sm"><p className="font-medium">{item.template || item.id}</p><p className="mt-1 text-xs text-muted">{item.status} · {item.fact_count || 0} 条事实 · {item.stale ? "已过期" : "当前有效"}</p></div>)}{!workspace.baselines.length && <p className="text-sm text-muted">尚无已保存主简历。</p>}</div></div>
      <div className="rounded-xl border border-border bg-surface p-4"><h3 className="font-semibold">岗位简历预览</h3><div className="mt-3 space-y-2">{workspace.tailoring_previews.map((item) => <Link key={item.id} href={`/job-analysis?job=${encodeURIComponent(item.job_id || "")}&tailoring=${encodeURIComponent(item.id)}`} className="block rounded-lg bg-background/60 p-3 text-sm hover:bg-surface-hover"><p className="font-medium">{item.job_id || item.id}</p><p className="mt-1 text-xs text-muted">{Math.round((item.change_ratio || 0) * 100)}% · {item.pending_rewrites || 0} 条待确认 · {item.stale ? "已过期" : item.allowed ? "可导出" : "已阻断"}</p></Link>)}{!workspace.tailoring_previews.length && <p className="text-sm text-muted">尚无岗位简历预览。</p>}</div></div>
      <div className="rounded-xl border border-border bg-surface p-4"><h3 className="font-semibold">导出记录</h3><div className="mt-3 space-y-2">{workspace.exports.map((item) => <div key={item.manifest} className="rounded-lg bg-background/60 p-3 text-sm"><p className="break-all font-medium">{item.output}</p><p className="mt-1 text-xs text-muted">{item.generated_at} · {item.job_id || "主简历"}</p></div>)}{!workspace.exports.length && <p className="text-sm text-muted">尚无正式导出记录。</p>}</div></div>
    </div>
  </section>;
}
