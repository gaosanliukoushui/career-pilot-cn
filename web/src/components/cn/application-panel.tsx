"use client";

import { useMemo, useState } from "react";
import type { CareerPilotApplication } from "@/lib/cn-types";

const STAGES = [
  ["pending_apply", "待投递"], ["submitted", "已提交"], ["qualification", "资格审查"],
  ["assessment_notice", "测评通知"], ["written_test_notice", "笔试通知"], ["written_test_completed", "笔试完成"],
  ["interview_first", "一面"], ["interview_professional", "专业面"], ["interview_hr", "HR 面"],
  ["medical", "体检"], ["background_review", "背调"], ["political_review", "政审"],
  ["intended_offer", "拟录用"], ["signed", "已签约"], ["rejected", "未通过"],
  ["withdrawn", "主动放弃"], ["closed", "岗位关闭"], ["expired", "已过期"],
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  personal: "个人信息", education: "教育经历", grades: "成绩与排名", experience: "实习、项目与校园经历",
  certificates: "证书与奖励", motivation: "应聘动机与自我评价", preferences: "地点与调剂偏好", materials: "材料",
};

export function ApplicationPanel({ initial }: { initial: CareerPilotApplication }) {
  const [application, setApplication] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, unknown>>(() => Object.fromEntries(initial.fields.filter((item) => "draft" in item).map((item) => [item.id, item.draft])));
  const [stage, setStage] = useState(initial.current_stage);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const grouped = useMemo(() => Object.groupBy(application.fields, (item) => item.category), [application.fields]);

  async function saveFields() {
    setBusy(true); setMessage("");
    const response = await fetch(`/api/cn/applications/${application.tracker_num}/fields`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(drafts),
    });
    const data = await response.json();
    if (response.ok) { setApplication(data.application); setMessage("网申草稿已保存到本地侧车文件"); }
    else setMessage(data.error || "保存失败");
    setBusy(false);
  }

  async function updateStage() {
    setBusy(true); setMessage("");
    const response = await fetch(`/api/cn/applications/${application.tracker_num}/stage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage, note }),
    });
    const data = await response.json();
    if (response.ok) { setApplication(data.application); setMessage(`阶段已同步为 ${data.application.canonical_status}`); setNote(""); }
    else setMessage(data.error || "阶段更新失败");
    setBusy(false);
  }

  return (
    <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-text">网申材料 · #{application.tracker_num}</p>
          <h2 className="mt-1 text-xl font-semibold">字段草稿与材料清单</h2>
          <p className="mt-1 text-sm text-muted">当前阶段：{application.current_stage} · 兼容状态：{application.canonical_status}</p>
        </div>
        {application.deadline && <span className="rounded-full bg-brand-soft px-3 py-1 text-sm text-brand-text">截止 {application.deadline}</span>}
      </div>

      {Object.entries(grouped).map(([category, fields]) => (
        <div key={category} className="space-y-3">
          <h3 className="border-b border-border pb-2 text-sm font-semibold">{CATEGORY_LABELS[category] || category}</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {(fields || []).map((item) => (
              <label key={item.id} className="rounded-lg border border-border p-3 text-sm">
                <span className="flex items-center justify-between gap-2 font-medium">
                  {item.label}{item.required && <span className="text-brand-text">必填</span>}
                </span>
                {item.sensitivity === "restricted" ? (
                  <p className="mt-2 rounded-md bg-brand-soft px-3 py-2 text-brand-text">敏感字段：仅在官网表单中由本人手工填写，本系统不保存。</p>
                ) : (
                  <textarea
                    className="mt-2 min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 outline-none focus:border-brand"
                    value={Array.isArray(drafts[item.id]) ? (drafts[item.id] as string[]).join("、") : String(drafts[item.id] ?? "")}
                    maxLength={item.max_length || undefined}
                    placeholder={item.manual_required ? "待本人补充" : "来源于已确认事实"}
                    onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                  />
                )}
                <span className="mt-1 block text-xs text-faint">事实：{item.source_fact_ids.join(", ") || "无"}{item.max_length ? ` · 上限 ${item.max_length} 字` : ""}</span>
              </label>
            ))}
          </div>
        </div>
      ))}

      <div>
        <h3 className="mb-3 text-sm font-semibold">材料检查表</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {application.materials.map((item) => (
            <div key={item.id} className="rounded-lg border border-border p-3 text-sm">
              <span className="font-medium">{item.label}</span>
              <p className={item.status === "ready" ? "text-emerald-700 dark:text-emerald-400" : item.status === "manual_required" ? "text-brand-text" : "text-muted"}>
                {item.status === "ready" ? "证据已就绪" : item.status === "manual_required" ? "本人手工提交，不保存副本" : "尚缺材料"}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 rounded-lg bg-surface-hover p-4 md:grid-cols-[1fr_1fr_auto]">
        <select className="rounded-md border border-border bg-surface px-3 py-2" value={stage} onChange={(event) => setStage(event.target.value)}>
          {STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input className="rounded-md border border-border bg-surface px-3 py-2" value={note} onChange={(event) => setNote(event.target.value)} placeholder="阶段备注（可选）" />
        <button type="button" disabled={busy} onClick={updateStage} className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50">同步阶段</button>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" disabled={busy} onClick={saveFields} className="rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground disabled:opacity-50">保存网申草稿</button>
        {message && <p className="text-sm text-muted">{message}</p>}
      </div>
    </section>
  );
}

