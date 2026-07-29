"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarClock, CheckCircle2, FileCheck2, FolderKanban, ShieldCheck } from "lucide-react";
import type { CareerPilotApplication } from "@/lib/cn-types";

type Profile = {
  facts?: Array<{ status: string }>;
  structured?: { education?: Record<string, unknown>; language_certificates?: unknown[]; credentials?: unknown[] };
};
type ResumeWorkspace = {
  baselines?: Array<{ id: string; status: string; stale: boolean }>;
  tailoring_previews?: Array<{ id: string; job_id: string; pending_rewrites: number; stale: boolean }>;
};

function daysUntil(value: string | null): number | null {
  if (!value) return null;
  const deadline = new Date(`${value}T23:59:59+08:00`).getTime();
  if (Number.isNaN(deadline)) return null;
  return Math.ceil((deadline - Date.now()) / 86_400_000);
}

export function TodayDashboard() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [applications, setApplications] = useState<CareerPilotApplication[]>([]);
  const [workspace, setWorkspace] = useState<ResumeWorkspace>({});
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      fetch("/api/cn/profile/structured").then((response) => response.ok ? response.json() : null),
      fetch("/api/cn/applications").then((response) => response.ok ? response.json() : { applications: [] }),
      fetch("/api/cn/resumes/workspace").then((response) => response.ok ? response.json() : { baselines: [], tailoring_previews: [] }),
    ]).then(([nextProfile, nextApplications, nextWorkspace]) => {
      setProfile(nextProfile);
      setApplications(nextApplications.applications || []);
      setWorkspace(nextWorkspace || {});
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "今日待办读取失败"));
  }, []);

  const tasks = useMemo(() => {
    const items: Array<{ id: string; title: string; detail: string; href: string; kind: string }> = [];
    const confirmedFacts = profile?.facts?.filter((fact) => fact.status === "confirmed").length || 0;
    const pendingFacts = profile?.facts?.filter((fact) => fact.status !== "confirmed").length || 0;
    const education = profile?.structured?.education || {};
    const missingProfile = ["degree", "institution", "major_name", "graduation_date", "cohort"].filter((key) => !(key in education));
    if (!profile || pendingFacts || missingProfile.length) items.push({
      id: "profile", title: "补齐个人事实与证据",
      detail: `${confirmedFacts} 条已确认事实 · ${pendingFacts} 条待审阅 · ${missingProfile.length} 个关键资格字段待补`,
      href: "/profile", kind: "profile",
    });
    if (!(workspace.baselines || []).some((item) => !item.stale && ["ready", "exported"].includes(item.status))) items.push({
      id: "baseline", title: "预览并确认主简历", detail: "主简历必须经过预览和显式确认，才能用于岗位定制", href: "/cv", kind: "resume",
    });
    for (const preview of workspace.tailoring_previews || []) {
      if (preview.pending_rewrites || preview.stale) items.push({
        id: preview.id, title: preview.stale ? "重新生成已过期岗位简历" : "确认岗位简历改写",
        detail: preview.stale ? `岗位/Profile/主简历已变化 · ${preview.job_id}` : `${preview.pending_rewrites} 条候选改写待接受或拒绝`,
        href: `/job-analysis?job=${encodeURIComponent(preview.job_id)}&tailoring=${encodeURIComponent(preview.id)}`, kind: "resume",
      });
    }
    for (const application of applications) {
      const days = daysUntil(application.deadline);
      if (days != null && days <= 14) items.push({
        id: `deadline-${application.id}`, title: days < 0 ? "岗位已超过截止时间" : `岗位将在 ${days} 天内截止`,
        detail: `#${application.tracker_num} · ${application.current_stage} · ${application.deadline}`, href: `/application-materials/${application.tracker_num}`, kind: "deadline",
      });
      const missingMaterials = application.materials.filter((item) => item.status === "missing").length;
      const pendingFields = application.fields.filter((item) => item.required && item.manual_required).length;
      if (missingMaterials || pendingFields) items.push({
        id: `materials-${application.id}`, title: "补齐网申字段和岗位材料",
        detail: `#${application.tracker_num} · ${pendingFields} 个必填字段待确认 · ${missingMaterials} 项材料缺失`, href: `/application-materials/${application.tracker_num}`, kind: "materials",
      });
      items.push({
        id: `stage-${application.id}`, title: "核对中国招聘详细阶段",
        detail: `#${application.tracker_num} · ${application.current_stage} → ${application.canonical_status}`, href: `/application-materials/${application.tracker_num}`, kind: "stage",
      });
    }
    if (!applications.length) items.push({ id: "job", title: "导入官网岗位并确认资格规则", detail: "粘贴公告、官网 URL 或 PDF/DOCX；逐条确认后才能评估", href: "/job-analysis", kind: "job" });
    return items;
  }, [applications, profile, workspace]);

  const icons = { profile: ShieldCheck, resume: FileCheck2, deadline: CalendarClock, materials: FolderKanban, stage: CheckCircle2, job: FolderKanban } as const;
  return <main className="mx-auto max-w-6xl space-y-8 px-5 py-8 md:px-8">
    <section className="dot-bg rounded-2xl border border-border bg-surface/60 p-7 md:p-10">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">CareerPilot CN · 今日</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">沿着中国校招主链，处理下一件确定的事。</h1>
      <p className="mt-4 max-w-3xl text-muted">事实与证据 → 主简历确认 → 官网岗位导入 → 资格规则确认 → 岗位简历 → 网申材料 → 详细阶段。</p>
      <div className="mt-6 flex flex-wrap gap-3"><Link href="/profile" className="rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground">打开个人事实中心</Link><Link href="/job-analysis" className="inline-flex items-center gap-2 rounded-md border border-border px-5 py-2.5 font-medium hover:bg-surface-hover">导入官网岗位 <ArrowRight className="size-4" /></Link></div>
    </section>
    {error && <div className="rounded-xl border border-brand/30 bg-brand-soft p-4 text-sm text-brand-text">{error}</div>}
    <section><div className="mb-3 flex items-center justify-between"><div><h2 className="text-lg font-semibold">今日待办</h2><p className="text-sm text-muted">资料缺口、截止时间、规则/改写确认、网申材料和详细阶段集中在这里。</p></div><span className="rounded-full bg-surface-hover px-3 py-1 text-sm text-muted">{tasks.length} 项</span></div><div className="grid gap-3 md:grid-cols-2">{tasks.map((task) => { const Icon = icons[task.kind as keyof typeof icons] || CheckCircle2; return <Link key={task.id} href={task.href} className="flex gap-3 rounded-xl border border-border bg-surface p-4 transition hover:bg-surface-hover"><Icon className="mt-0.5 size-5 shrink-0 text-brand" /><span><span className="font-medium">{task.title}</span><span className="mt-1 block text-sm text-muted">{task.detail}</span></span></Link>; })}</div></section>
    <details className="rounded-xl border border-border bg-surface/40 p-4 text-sm text-muted"><summary className="cursor-pointer font-medium text-foreground">高级功能</summary><p className="mt-2">海外 ATS 扫描、固定跟进与门户扫描不属于中国校招默认主链。需要时进入 <Link href="/explore" className="text-brand hover:underline">海外职位发现</Link>、<Link href="/portals" className="text-brand hover:underline">门户配置</Link>。</p></details>
  </main>;
}
