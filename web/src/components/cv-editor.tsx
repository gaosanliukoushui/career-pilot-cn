"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileDown, Loader2, ShieldCheck, Upload } from "lucide-react";
import { cn } from "@/lib/cn";

type Fact = {
  id: string;
  type: string;
  statement: string;
  status: "unconfirmed" | "confirmed" | "rejected" | "conflicted";
  sensitivity: string;
  allowed_uses: string[];
  evidence_ids: string[];
};
type Evidence = { id: string; kind: string; ref: string; strength: "ordinary" | "strong" };
type Profile = { candidate: { display_name: string; photo?: string; political_status?: string }; facts: Fact[]; evidence: Evidence[] };
type Preview = {
  variant: {
    schema_version: number;
    id: string;
    template: Template;
    source_profile_sha256: string;
    source_photo_sha256: string | null;
    fact_ids: string[];
    order: string[];
    rewrites: Rewrite[];
    sensitive_authorizations: Record<string, boolean>;
    status: string;
    confirmation: { status: "pending" | "confirmed"; confirmed_at: string | null; preview_sha256: string | null };
    diff: { added: string[]; removed: string[]; rewritten: unknown[]; reordered: { fact_id: string; from: number; to: number }[] };
  };
  markdown: string;
  html: string;
};
type Rewrite = { fact_id: string; proposed_statement: string; accepted: boolean };
type Audit = { profile?: { facts?: { id: string; eligible: boolean; reasons: string[] }[] } };
type Template = "soe-one-page" | "tech-two-page" | "application-detail";

const TEMPLATES: { id: Template; name: string; note: string }[] = [
  { id: "soe-one-page", name: "央国企一页版", note: "教育与综合经历优先，严格一页" },
  { id: "tech-two-page", name: "技术岗位版", note: "技能与项目优先，最多两页" },
  { id: "application-detail", name: "网申详细版", note: "完整呈现，不强制一页" },
];
const HIGH_RISK = new Set(["education", "grade", "ranking", "certificate", "award", "internship", "employment", "affiliation", "result", "quantified_result"]);
const STATUS_LABEL = { unconfirmed: "待确认", confirmed: "已确认", rejected: "已拒绝", conflicted: "有冲突" } as const;
const FACT_TYPE_LABEL: Record<string, string> = {
  basic: "基本信息", education: "教育经历", grade: "成绩", ranking: "排名", skill: "技能",
  certificate: "证书", award: "奖项", campus: "校园经历", internship: "实习经历",
  employment: "工作经历", affiliation: "组织关系", project: "项目经历", result: "成果",
  quantified_result: "量化成果",
};
const SENSITIVITY_LABEL: Record<string, string> = {
  public: "公开", personal: "个人", sensitive: "敏感", restricted: "受限",
};
const USE_LABEL: Record<string, string> = {
  resume: "简历", application_form: "网申表", interview: "面试",
};
const EVIDENCE_KIND_LABEL: Record<string, string> = {
  user_confirmation: "用户确认", repository: "代码仓库", document: "文件", transcript: "成绩单",
  certificate: "证书", official_link: "官方链接",
};
const EVIDENCE_STRENGTH_LABEL: Record<string, string> = { ordinary: "普通证据", strong: "强证据" };
const REASON_LABEL: Record<string, string> = {
  status_unconfirmed: "事实尚未确认", status_rejected: "事实已被拒绝", status_conflicted: "事实存在冲突",
  use_not_allowed: "未授权用于简历", forbidden_sensitive_content: "包含禁止写入简历的敏感内容",
  basic_requires_safe_subtype: "基本信息缺少安全分类", missing_evidence: "缺少证据",
  evidence_integrity_mismatch: "证据完整性校验失败", evidence_unverifiable: "证据无法核验",
  high_risk_requires_strong_evidence: "高风险事实需要强证据",
};

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || body?.error) throw new Error(body?.error || `请求失败（${response.status}）`);
  return body as T;
}

export function CvEditor() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmedVariant, setConfirmedVariant] = useState<Preview["variant"] | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [template, setTemplate] = useState<Template>("soe-one-page");
  const [cvText, setCvText] = useState("");
  const [evidenceRefs, setEvidenceRefs] = useState<Record<string, string>>({});
  const [rewriteDrafts, setRewriteDrafts] = useState<Record<string, string>>({});
  const [acceptedRewrites, setAcceptedRewrites] = useState<Rewrite[]>([]);
  const [authorizePhoto, setAuthorizePhoto] = useState(false);
  const [authorizePolitical, setAuthorizePolitical] = useState(false);
  const [busy, setBusy] = useState<string | null>("加载");
  const [message, setMessage] = useState<string | null>(null);
  const refreshSequence = useRef(0);

  const previewRequest = useCallback((selected: Template, photo: boolean, political: boolean, rewrites: Rewrite[]) => fetch("/api/resume-variants/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ template: selected, authorize_photo: photo, authorize_political_status: political, rewrites }),
  }).then((response) => json<Preview>(response)), []);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setBusy("刷新");
    setMessage(null);
    try {
      const [nextProfile, nextPreview, nextAudit] = await Promise.all([
        fetch("/api/candidate-profile").then((response) => json<Profile>(response)),
        previewRequest(template, authorizePhoto, authorizePolitical, acceptedRewrites),
        fetch("/api/candidate-profile/audit").then((response) => json<Audit>(response)),
      ]);
      if (sequence !== refreshSequence.current) return;
      setProfile(nextProfile);
      setPreview(nextPreview);
      setConfirmedVariant(null);
      setAudit(nextAudit);
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      setMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      if (sequence === refreshSequence.current) setBusy(null);
    }
  }, [acceptedRewrites, authorizePhoto, authorizePolitical, previewRequest, template]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function importCv() {
    if (!cvText.trim()) return;
    setBusy("导入");
    setMessage(null);
    try {
      await json(await fetch("/api/candidate-profile/import-cv", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: cvText }),
      }));
      setCvText("");
      await refresh();
      setMessage("旧简历已导入为待确认事实，原文件已备份。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入失败");
    } finally { setBusy(null); }
  }

  async function updateStatus(fact: Fact, status: Fact["status"]) {
    setBusy(fact.id);
    setMessage(null);
    try {
      await json(await fetch("/api/candidate-profile/fact-status", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fact.id, status }),
      }));
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "状态更新失败"); }
    finally { setBusy(null); }
  }

  async function attachEvidence(fact: Fact) {
    const highRisk = HIGH_RISK.has(fact.type);
    const ref = highRisk ? evidenceRefs[fact.id]?.trim() : `confirmation:web-${crypto.randomUUID()}`;
    if (!ref) { setMessage("高风险事实需要填写可核验的 HTTPS 链接。"); return; }
    setBusy(fact.id);
    setMessage(null);
    try {
      await json(await fetch("/api/candidate-profile/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fact_id: fact.id,
          id: `evidence.web.${crypto.randomUUID()}`,
          kind: highRisk ? "official_link" : "user_confirmation",
          ref,
          strength: highRisk ? "strong" : "ordinary",
        }),
      }));
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "证据关联失败"); }
    finally { setBusy(null); }
  }

  async function exportFile(format: "md" | "docx" | "pdf") {
    setBusy(`导出-${format}`);
    setMessage(null);
    try {
      const response = await fetch("/api/resume-variants/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variant: confirmedVariant, format }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "导出失败");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${template}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`${format.toUpperCase()} 已生成并下载；导出前已重新审计事实和敏感授权。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "导出失败"); }
    finally {
      refreshSequence.current += 1;
      setAuthorizePhoto(false);
      setAuthorizePolitical(false);
      setPreview(null);
      setBusy(null);
    }
  }

  async function confirmMasterResume() {
    if (!preview?.variant) return;
    setBusy("确认主简历");
    setMessage(null);
    try {
      const result = await json<{ variant: Preview["variant"] }>(await fetch("/api/cn/resumes/baselines", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ variant: preview.variant, confirmed: true }),
      }));
      setConfirmedVariant(result.variant);
      setMessage("已确认当前预览为 ready 主简历；后续改动会要求重新确认。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "主简历确认失败"); }
    finally { setBusy(null); }
  }

  function selectTemplate(nextTemplate: Template) {
    if (nextTemplate === template) return;
    refreshSequence.current += 1;
    setAuthorizePhoto(false);
    setAuthorizePolitical(false);
    setPreview(null);
    setConfirmedVariant(null);
    setTemplate(nextTemplate);
  }

  const evidenceById = new Map((profile?.evidence || []).map((item) => [item.id, item]));
  const auditById = new Map((audit?.profile?.facts || []).map((item) => [item.id, item]));
  const pending = profile?.facts.filter((fact) => fact.status !== "confirmed").length || 0;

  return (
    <main className="mx-auto max-w-[1500px] px-5 py-7 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">CareerPilot CN</p>
          <h1 className="mt-1 font-display text-3xl tracking-tight text-landing">中文简历工作台</h1>
          <p className="mt-1 text-sm text-muted">事实与证据是唯一真源；这里负责审阅、编排、预览和导出。</p>
        </div>
        <div className="rounded-full border border-border bg-surface px-4 py-2 text-sm text-muted">
          {busy ? <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />{busy}中</span> : `${profile?.facts.length || 0} 条事实 · ${pending} 条待处理`}
        </div>
      </header>

      {message && <div className="mt-4 rounded-xl border border-brand/20 bg-brand/5 px-4 py-3 text-sm text-foreground">{message}</div>}

      <div className="mt-6 grid gap-5 xl:grid-cols-[1.05fr_1.4fr_1.2fr]">
        <section className="space-y-5">
          <div className="rounded-2xl border border-border bg-surface/60 p-5">
            <h2 className="flex items-center gap-2 font-semibold text-foreground"><Upload className="size-4 text-brand" />导入旧简历</h2>
            <p className="mt-1 text-xs leading-5 text-muted">粘贴 Markdown；系统只创建待确认事实，不会直接发布。</p>
            <textarea value={cvText} onChange={(event) => setCvText(event.target.value)} placeholder="# 姓名\n\n## 项目经历\n- ..." className="mt-3 min-h-32 w-full resize-y rounded-xl border border-border bg-background p-3 font-mono text-xs outline-none focus:border-brand/50" />
            <button type="button" onClick={importCv} disabled={Boolean(busy) || !cvText.trim()} className="mt-3 w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground disabled:opacity-40">导入为待确认事实</button>
          </div>

          <div className="rounded-2xl border border-border bg-surface/60 p-5">
            <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4 text-brand" />本次敏感授权</h2>
            <p className="mt-1 text-xs leading-5 text-muted">仅作用于当前预览和本次导出，不写入全局授权。</p>
            {[{ key: "photo", label: "照片", checked: authorizePhoto, set: setAuthorizePhoto, available: Boolean(profile?.candidate.photo) }, { key: "political", label: "政治面貌", checked: authorizePolitical, set: setAuthorizePolitical, available: Boolean(profile?.candidate.political_status) }].map((item) => (
              <label key={item.key} className="mt-3 flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
                <span>{item.label}{!item.available && <span className="ml-2 text-xs text-faint">资料未提供</span>}</span>
                <input type="checkbox" checked={item.checked} disabled={!item.available} onChange={(event) => item.set(event.target.checked)} className="size-4 accent-[var(--color-brand)]" />
              </label>
            ))}
            <p className="mt-3 text-xs text-faint">身份证号、家庭成员、完整住址始终禁止进入简历。</p>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-surface/60 p-5">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="font-semibold">事实审阅队列</h2><p className="mt-1 text-xs text-muted">先补证，再确认；高风险事实只接受强证据。</p></div>
            <span className="text-xs text-muted">{profile?.candidate.display_name || "匿名候选人"}</span>
          </div>
          <div className="mt-4 max-h-[74vh] space-y-3 overflow-auto pr-1">
            {(profile?.facts || []).map((fact) => {
              const evidence = fact.evidence_ids.map((id) => evidenceById.get(id)).filter(Boolean) as Evidence[];
              const highRisk = HIGH_RISK.has(fact.type);
              const publishable = preview?.variant.fact_ids.includes(fact.id);
              const reasons = auditById.get(fact.id)?.reasons || [];
              return <article key={fact.id} className={cn("rounded-xl border p-4", publishable ? "border-emerald-500/25 bg-emerald-500/5" : "border-border bg-background/60")}>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="rounded-full bg-foreground/5 px-2 py-1">{FACT_TYPE_LABEL[fact.type] || fact.type}</span>
                  <span className="rounded-full bg-foreground/5 px-2 py-1">{STATUS_LABEL[fact.status]}</span>
                  <span className="rounded-full bg-foreground/5 px-2 py-1">敏感级别：{SENSITIVITY_LABEL[fact.sensitivity] || fact.sensitivity}</span>
                  {publishable ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="size-3" />可发布</span> : <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="size-3" />被门槛拦截</span>}
                </div>
                <p className="mt-2 text-sm leading-6 text-foreground">{fact.statement}</p>
                <p className="mt-2 break-all font-mono text-[10px] text-faint">{fact.id}</p>
                <div className="mt-2 text-xs text-muted">用途：{fact.allowed_uses.map((use) => USE_LABEL[use] || use).join("、") || "无"} · 证据：{evidence.length ? evidence.map((item) => `${EVIDENCE_STRENGTH_LABEL[item.strength] || item.strength}/${EVIDENCE_KIND_LABEL[item.kind] || item.kind}`).join("，") : "未关联"}</div>
                {!!reasons.length && <p className="mt-2 text-xs text-amber-700">阻断原因：{reasons.map((reason) => REASON_LABEL[reason] || reason).join("、")}</p>}
                {highRisk && <input value={evidenceRefs[fact.id] || ""} onChange={(event) => setEvidenceRefs((current) => ({ ...current, [fact.id]: event.target.value }))} placeholder="高风险事实：填写 HTTPS 正式链接" className="mt-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs outline-none focus:border-brand/50" />}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => attachEvidence(fact)} disabled={busy === fact.id} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-brand/40">{highRisk ? "关联强证据" : "添加用户确认证言"}</button>
                  {fact.status === "unconfirmed" && <button type="button" onClick={() => updateStatus(fact, "confirmed")} className="rounded-lg bg-brand px-3 py-1.5 text-xs text-brand-foreground">确认</button>}
                  {fact.status !== "rejected" && <button type="button" onClick={() => updateStatus(fact, "rejected")} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted">拒绝</button>}
                  {fact.status === "rejected" && <button type="button" onClick={() => updateStatus(fact, "unconfirmed")} className="rounded-lg border border-border px-3 py-1.5 text-xs">恢复待确认</button>}
                </div>
                {publishable && <div className="mt-3 flex gap-2 border-t border-border/70 pt-3">
                  <input value={rewriteDrafts[fact.id] ?? fact.statement} onChange={(event) => setRewriteDrafts((current) => ({ ...current, [fact.id]: event.target.value }))} aria-label={`候选改写 ${fact.id}`} className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs outline-none focus:border-brand/50" />
                  <button type="button" onClick={() => {
                    const proposed = (rewriteDrafts[fact.id] ?? fact.statement).trim();
                    setAcceptedRewrites((current) => [...current.filter((item) => item.fact_id !== fact.id), { fact_id: fact.id, proposed_statement: proposed, accepted: true }]);
                  }} className="rounded-lg border border-brand/30 px-3 py-1.5 text-xs text-brand">接受候选改写</button>
                </div>}
              </article>;
            })}
            {!profile?.facts.length && <p className="py-16 text-center text-sm text-muted">暂无事实，请先导入旧简历。</p>}
          </div>
        </section>

        <section className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {TEMPLATES.map((item) => <button key={item.id} type="button" onClick={() => selectTemplate(item.id)} className={cn("rounded-xl border p-3 text-left transition", template === item.id ? "border-brand bg-brand/10" : "border-border bg-surface/60 hover:border-brand/30")}><span className="block text-sm font-medium">{item.name}</span><span className="mt-1 block text-[10px] leading-4 text-muted">{item.note}</span></button>)}
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
            {preview?.html ? <iframe title="简历实时预览" srcDoc={preview.html} className="h-[62vh] w-full bg-white" /> : <div className="grid h-[62vh] place-items-center text-sm text-muted">暂无可发布内容</div>}
          </div>
          <div className="rounded-2xl border border-border bg-surface/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="text-sm font-semibold">差异审计</h2><p className="mt-1 text-xs text-muted">展示 {preview?.variant.diff.added.length || 0} · 删除 {preview?.variant.diff.removed.length || 0} · 改写 {preview?.variant.diff.rewritten.length || 0} · 排序 {preview?.variant.diff.reordered.length || 0}</p></div>
              <div className="flex flex-wrap gap-2"><button type="button" onClick={confirmMasterResume} disabled={Boolean(busy) || !preview?.variant.fact_ids.length || Boolean(confirmedVariant)} className="rounded-lg border border-brand/40 px-3 py-2 text-xs font-medium text-brand disabled:opacity-40">{confirmedVariant ? "主简历已确认" : "确认当前预览为主简历"}</button>{(["md", "docx", "pdf"] as const).map((format) => <button key={format} type="button" onClick={() => exportFile(format)} disabled={Boolean(busy) || !confirmedVariant} className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-2 text-xs font-medium text-brand-foreground disabled:opacity-40"><FileDown className="size-3.5" />{format.toUpperCase()}</button>)}</div>
            </div>
            {!!preview?.variant.diff.removed.length && <p className="mt-3 break-all text-[10px] leading-4 text-faint">未进入正式输出：{preview.variant.diff.removed.join("、")}</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
