"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CareerPilotApplication } from "@/lib/cn-types";

export function CareerPilotApplicationList() {
  const [items, setItems] = useState<CareerPilotApplication[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void fetch("/api/cn/applications").then((response) => response.json().then((data) => ({ response, data }))).then(({ response, data }) => response.ok ? setItems(data.applications || []) : setError(data.error || "读取失败")); }, []);
  return <div className="mx-auto max-w-5xl space-y-6 p-5 md:p-8"><header><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">网申材料</p><h1 className="mt-2 text-3xl font-semibold">字段草稿与材料清单</h1><p className="mt-2 text-muted">这里只保存普通网申草稿和证据引用；身份证、家庭成员、详细住址始终由本人在官网手工填写。</p></header>{error && <div className="rounded-lg bg-brand-soft p-4 text-brand-text">{error}</div>}<div className="space-y-3">{items.map((item) => <Link key={item.id} href={`/application-materials/${item.tracker_num}`} className="grid gap-2 rounded-xl border border-border bg-surface p-4 transition hover:bg-surface-hover md:grid-cols-[6rem_1fr_10rem]"><span className="font-semibold">#{item.tracker_num}</span><span><span className="font-medium">{item.job_id}</span><span className="mt-1 block text-sm text-muted">{item.current_stage} · {item.canonical_status}</span></span><span className="text-sm text-muted">{item.deadline ? `截止 ${item.deadline}` : "未识别截止时间"}</span></Link>)}{!items.length && !error && <div className="rounded-xl border border-dashed border-border p-8 text-center text-muted">还没有网申材料。先在岗位分析页完成资格评估。</div>}</div></div>;
}

