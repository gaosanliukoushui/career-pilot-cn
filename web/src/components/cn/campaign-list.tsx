"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Campaign } from "@/lib/cn-types";

export function CampaignList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [form, setForm] = useState({ name: "", employer: "", recruitment_batch: "", deadline: "", max_applications: 1, constraint_source_quote: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const response = await fetch("/api/cn/campaigns", { cache: "no-store" });
    const data = await response.json();
    if (response.ok) setCampaigns(data.campaigns || []);
    else setMessage(data.error || "Campaign 列表读取失败");
  }
  useEffect(() => { void refresh(); }, []);

  async function create() {
    setBusy(true); setMessage("");
    const response = await fetch("/api/cn/campaigns", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, deadline: form.deadline || null, constraint_confirmation_status: "confirmed" }),
    });
    const data = await response.json();
    if (response.ok) {
      setForm({ name: "", employer: "", recruitment_batch: "", deadline: "", max_applications: 1, constraint_source_quote: "" });
      setMessage("Campaign 已建立；接下来导入岗位并逐一确认规则。");
      await refresh();
    } else setMessage(data.error || "Campaign 创建失败");
    setBusy(false);
  }

  return <div className="mx-auto max-w-6xl space-y-6 p-5 md:p-8">
    <header><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">CareerPilot CN · V3.1</p><h1 className="mt-2 text-3xl font-semibold">可信多岗位投递 Campaign</h1><p className="mt-2 max-w-3xl text-muted">同一企业的岗位共享资格规则、确定性排名和限投约束；任何岗位都必须先单独确认与评估。</p></header>
    <section className="grid gap-3 rounded-xl border border-border bg-surface p-5 md:grid-cols-2">
      <label className="text-sm"><span className="mb-1 block font-medium">Campaign 名称</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label className="text-sm"><span className="mb-1 block font-medium">招聘企业</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.employer} onChange={(event) => setForm({ ...form, employer: event.target.value })} /></label>
      <label className="text-sm"><span className="mb-1 block font-medium">招聘批次</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.recruitment_batch} onChange={(event) => setForm({ ...form, recruitment_batch: event.target.value })} /></label>
      <label className="text-sm"><span className="mb-1 block font-medium">截止日期</span><input type="date" className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} /></label>
      <label className="text-sm"><span className="mb-1 block font-medium">最多投递岗位数</span><input type="number" min={1} className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.max_applications} onChange={(event) => setForm({ ...form, max_applications: Number(event.target.value) })} /></label>
      <label className="text-sm"><span className="mb-1 block font-medium">限投规则原文</span><input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.constraint_source_quote} onChange={(event) => setForm({ ...form, constraint_source_quote: event.target.value })} placeholder="例如：每位应聘者限投 1 个岗位" /></label>
      <button type="button" disabled={busy || !form.name.trim() || !form.employer.trim() || !form.constraint_source_quote.trim()} onClick={create} className="rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground disabled:opacity-50 md:col-span-2">建立并确认 Campaign 约束</button>
    </section>
    {message && <p className="rounded-lg border border-border bg-surface p-3 text-sm text-muted">{message}</p>}
    <section className="grid gap-3 md:grid-cols-2">{campaigns.map((campaign) => <Link key={campaign.id} href={`/campaigns/${encodeURIComponent(campaign.id)}`} className="rounded-xl border border-border bg-surface p-5 hover:bg-surface-hover"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{campaign.name}</h2><p className="mt-1 text-sm text-muted">{campaign.employer} · {campaign.recruitment_batch || "未填写批次"}</p></div><span className="rounded-full bg-background px-3 py-1 text-xs">{campaign.jobs.length} 岗</span></div><p className="mt-4 text-xs text-faint">排名：{campaign.ranking.status === "ready" ? "已生成" : "待完成"} · 选岗：{campaign.selection.status === "confirmed" ? "已确认" : "待确认"}</p></Link>)}</section>
  </div>;
}
