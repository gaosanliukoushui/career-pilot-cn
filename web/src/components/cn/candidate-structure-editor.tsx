"use client";

import { useEffect, useMemo, useState } from "react";

type FactStatus = "unconfirmed" | "confirmed" | "rejected" | "conflicted";
type Fact = { id: string; type: string; statement: string; status: FactStatus; sensitivity: string; allowed_uses: string[]; evidence_ids: string[] };
type Evidence = { id: string; kind: string; ref: string; strength: "ordinary" | "strong"; sha256?: string };
type FactRef = { value: unknown; fact_id: string };
type Structured = {
  education: Record<string, FactRef>;
  language_certificates: Array<{ kind: string; level?: string; score?: number; fact_id: string }>;
  credentials: Array<{ name: string; level?: string; fact_id: string }>;
  political_status?: { value: string; fact_id: string; sensitivity: "sensitive" };
  preferences: Record<string, FactRef>;
};
type Profile = { schema_version: number; candidate: { display_name: string }; structured?: Structured; facts: Fact[]; evidence: Evidence[] };

const emptyStructured = (): Structured => ({ education: {}, language_certificates: [], credentials: [], preferences: {} });
const HIGH_RISK = new Set(["education", "grade", "ranking", "certificate", "award", "internship", "employment", "affiliation", "result", "quantified_result"]);
const FACT_TYPE_LABEL: Record<string, string> = {
  basic: "基本信息", education: "教育经历", grade: "成绩", ranking: "排名", skill: "技能",
  certificate: "证书", award: "奖项", campus: "校园经历", internship: "实习经历",
  employment: "工作经历", affiliation: "组织关系", project: "项目经历", result: "成果",
  quantified_result: "量化成果", preference: "求职偏好",
};
const STATUS_LABEL: Record<FactStatus, string> = { unconfirmed: "待确认", confirmed: "已确认", rejected: "已拒绝", conflicted: "有冲突" };

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || body?.error) throw new Error(body?.error || `请求失败（${response.status}）`);
  return body as T;
}

export function CandidateStructureEditor() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [structured, setStructured] = useState<Structured>(emptyStructured);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [cvText, setCvText] = useState("");
  const [evidenceRefs, setEvidenceRefs] = useState<Record<string, string>>({});
  const confirmed = useMemo(() => (profile?.facts || []).filter((fact) => fact.status === "confirmed"), [profile]);

  async function load() {
    const response = await fetch("/api/cn/profile/structured");
    const data = await response.json();
    if (response.ok) { setProfile(data); setStructured(data.structured || emptyStructured()); }
    else setMessage(data.error || "资料读取失败");
  }
  useEffect(() => { void load(); }, []);

  function setEducation(key: string, next: { value?: unknown; factId?: string }) {
    setStructured((current) => {
      const education = { ...current.education };
      const existing = education[key] || { value: "", fact_id: "" };
      const value = Object.hasOwn(next, "value") ? next.value : existing.value;
      const factId = Object.hasOwn(next, "factId") ? next.factId || "" : existing.fact_id;
      if ((value === "" || value === undefined) && !factId) delete education[key];
      else education[key] = { value, fact_id: factId };
      return { ...current, education };
    });
  }

  function setPreference(key: string, next: { value?: unknown; factId?: string }) {
    setStructured((current) => {
      const preferences = { ...current.preferences };
      const existing = preferences[key] || { value: "", fact_id: "" };
      const value = Object.hasOwn(next, "value") ? next.value : existing.value;
      const factId = Object.hasOwn(next, "factId") ? next.factId || "" : existing.fact_id;
      if ((value === "" || value === undefined || (Array.isArray(value) && !value.length)) && !factId) delete preferences[key];
      else preferences[key] = { value, fact_id: factId };
      return { ...current, preferences };
    });
  }

  function setLanguage(index: number, next: Partial<Structured["language_certificates"][number]>) {
    setStructured((current) => ({
      ...current,
      language_certificates: current.language_certificates.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item),
    }));
  }

  function setCredential(index: number, next: Partial<Structured["credentials"][number]>) {
    setStructured((current) => ({
      ...current,
      credentials: current.credentials.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item),
    }));
  }

  async function migrate() {
    setBusy(true); setMessage("");
    const response = await fetch("/api/cn/profile/structured", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "migrate" }) });
    const data = await response.json();
    if (response.ok) { setMessage(data.changed ? `已迁移并备份：${data.backup_path}` : "当前资料已经是 v2"); await load(); }
    else setMessage(data.error || "迁移失败");
    setBusy(false);
  }

  async function save() {
    setBusy(true); setMessage("");
    const normalized = {
      ...structured,
      education: Object.fromEntries(Object.entries(structured.education).filter(([, item]) => item?.fact_id && item.value !== "" && item.value !== undefined)),
      language_certificates: structured.language_certificates.filter((item) => item.kind.trim() && item.fact_id),
      credentials: structured.credentials.filter((item) => item.name.trim() && item.fact_id),
      political_status: structured.political_status?.value && structured.political_status.fact_id ? structured.political_status : undefined,
      preferences: Object.fromEntries(Object.entries(structured.preferences).filter(([, item]) => item?.fact_id && item.value !== "" && item.value !== undefined && (!Array.isArray(item.value) || item.value.length))),
    };
    const response = await fetch("/api/cn/profile/structured", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ structured: normalized }) });
    const data = await response.json();
    if (response.ok) { setProfile(data); setStructured(data.structured || emptyStructured()); setMessage("结构化资格资料已保存，引用事实已授权用于岗位匹配和网申草稿"); }
    else setMessage(`${data.error || "保存失败"}${data.details ? `：${JSON.stringify(data.details)}` : ""}`);
    setBusy(false);
  }

  async function importFacts() {
    if (!cvText.trim()) return;
    setBusy(true); setMessage("");
    try {
      await readJson(await fetch("/api/candidate-profile/import-cv", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: cvText }),
      }));
      setCvText("");
      await load();
      setMessage("内容已导入为待确认事实；系统没有把它们直接用于匹配或简历。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "导入失败"); }
    finally { setBusy(false); }
  }

  async function updateFactStatus(fact: Fact, status: FactStatus) {
    setBusy(true); setMessage("");
    try {
      await readJson(await fetch("/api/candidate-profile/fact-status", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: fact.id, status }),
      }));
      await load();
      setMessage(status === "confirmed" ? "事实已确认；仍需满足证据要求后才能用于资格资料。" : "事实状态已更新。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "事实状态更新失败"); }
    finally { setBusy(false); }
  }

  async function attachEvidence(fact: Fact) {
    const highRisk = HIGH_RISK.has(fact.type);
    const ref = highRisk ? evidenceRefs[fact.id]?.trim() : `confirmation:web-profile-${crypto.randomUUID()}`;
    if (!ref) { setMessage("学历、证书、经历和成果等高风险事实需要填写可核验的 HTTPS 正式链接。"); return; }
    setBusy(true); setMessage("");
    try {
      await readJson(await fetch("/api/candidate-profile/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fact_id: fact.id,
          id: `evidence.web-profile.${crypto.randomUUID()}`,
          kind: highRisk ? "official_link" : "user_confirmation",
          ref,
          strength: highRisk ? "strong" : "ordinary",
        }),
      }));
      await load();
      setMessage(highRisk ? "强证据已关联。" : "用户确认证据已关联。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "证据关联失败"); }
    finally { setBusy(false); }
  }

  async function uploadEvidence(fact: Fact, file?: File) {
    if (!file) return;
    setBusy(true); setMessage("");
    try {
      const data = new FormData();
      data.set("fact_id", fact.id);
      data.set("file", file);
      const result = await readJson<{ evidence: Evidence }>(await fetch("/api/candidate-profile/evidence", { method: "POST", body: data }));
      await load();
      setMessage(`本地强证据已安全导入，SHA-256：${result.evidence.sha256?.slice(0, 12)}…`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "证据上传失败"); }
    finally { setBusy(false); }
  }

  const completion = useMemo(() => {
    const facts = profile?.facts || [];
    const evidence = profile?.evidence || [];
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const reviewComplete = facts.length > 0 && facts.every((fact) => fact.status === "confirmed" || fact.status === "rejected");
    const evidenceComplete = facts.filter((fact) => fact.status === "confirmed" && HIGH_RISK.has(fact.type)).every((fact) => fact.evidence_ids.some((id) => evidenceById.get(id)?.strength === "strong"));
    const educationComplete = ["degree", "major_name", "graduation_date"].every((key) => structured.education[key]?.fact_id);
    const preferenceComplete = Boolean(structured.preferences.locations?.fact_id);
    const items = [
      { label: "事实已逐条审核", done: reviewComplete },
      { label: "高风险事实已补强证据", done: evidenceComplete },
      { label: "学历、专业、毕业日期已结构化", done: educationComplete },
      { label: "意向地点已绑定事实", done: preferenceComplete },
    ];
    const next = items.find((item) => !item.done)?.label || "资料已具备主简历确认条件，请前往主简历页面";
    return { items, done: items.filter((item) => item.done).length, next };
  }, [profile, structured]);

  if (!profile) return <div className="mx-auto max-w-5xl p-8 text-muted">正在读取个人事实档案……</div>;
  if (profile.schema_version === 1) return <div className="mx-auto max-w-3xl p-8"><div className="rounded-xl border border-border bg-surface p-6"><h1 className="text-2xl font-semibold">升级 CandidateProfile v2</h1><p className="mt-2 text-muted">迁移不会猜测学历或偏好，只会增加空的结构化区域，并保留 v1 原文件备份。</p><button type="button" disabled={busy} onClick={migrate} className="mt-4 rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground">显式迁移并备份</button>{message && <p className="mt-3 text-sm text-muted">{message}</p>}</div></div>;

  const factOptions = (types: string[]) => confirmed.filter((fact) => types.includes(fact.type));
  const educationRows = [
    { key: "degree", label: "学历层次", type: "select", options: [["bachelor", "本科"], ["master", "硕士"], ["doctorate", "博士"], ["associate", "专科"]] },
    { key: "institution", label: "毕业院校", type: "text" },
    { key: "major_name", label: "专业名称", type: "text" },
    { key: "major_code", label: "专业代码", type: "text" },
    { key: "graduation_date", label: "毕业日期", type: "date" },
    { key: "cohort", label: "毕业届别", type: "number" },
    { key: "fresh_graduate_status", label: "应届生类型", type: "select", options: [["domestic", "国内应届"], ["overseas", "海外应届"], ["not_fresh", "非应届"], ["unknown", "待确认"]] },
  ] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-5 md:p-8">
      <header><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">个人事实与证据</p><h1 className="mt-2 text-3xl font-semibold">结构化校招资格资料</h1><p className="mt-2 text-muted">每个值必须绑定一条已确认事实。学历、证书等高风险信息还必须具备强证据；系统不会从文本中自行猜测。</p></header>
      <section className="rounded-xl border border-brand/25 bg-brand/5 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">建档完成度 {completion.done}/4</h2><p className="mt-1 text-sm text-muted">下一步：{completion.next}</p></div><div className="text-2xl font-semibold text-brand-text">{completion.done * 25}%</div></div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">{completion.items.map((item) => <div key={item.label} className="rounded-md bg-surface px-3 py-2 text-sm"><span className={item.done ? "text-emerald-600" : "text-amber-600"}>{item.done ? "✓" : "○"}</span> {item.label}</div>)}</div>
      </section>
      <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <div><h2 className="text-lg font-semibold">第一步：建立事实档案</h2><p className="mt-1 text-sm text-muted">粘贴旧简历或自述内容。导入只会生成待确认事实；请逐条补证并确认。</p></div>
        <textarea value={cvText} onChange={(event) => setCvText(event.target.value)} placeholder="# 教育经历\n- 2026 年本科毕业……\n\n# 项目经历\n- ……" className="min-h-32 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-brand/50" />
        <button type="button" disabled={busy || !cvText.trim()} onClick={importFacts} className="rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground disabled:opacity-50">导入为待确认事实</button>
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-muted">身份证号码、家庭成员和完整住址不会落盘、写日志或进入报告；网申需要时仅提示“需要本人手工填写”。</div>
      </section>
      <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <div><h2 className="text-lg font-semibold">第二步：补充证据并确认</h2><p className="mt-1 text-sm text-muted">普通偏好可由本人确认；学历、成绩、证书、经历和成果必须关联 HTTPS 正式链接，或上传 PDF、DOCX、PNG、JPEG 本地强证据（最大 10 MB）。</p></div>
        <div className="space-y-3">
          {(profile.facts || []).map((fact) => {
            const highRisk = HIGH_RISK.has(fact.type);
            const evidence = (profile.evidence || []).filter((item) => fact.evidence_ids.includes(item.id));
            return <article key={fact.id} className="rounded-lg border border-border bg-background/60 p-4">
              <div className="flex flex-wrap gap-2 text-xs text-muted"><span>{FACT_TYPE_LABEL[fact.type] || fact.type}</span><span>·</span><span>{STATUS_LABEL[fact.status]}</span><span>·</span><span>{fact.id}</span></div>
              <p className="mt-2 text-sm leading-6">{fact.statement}</p>
              <p className="mt-2 text-xs text-faint">证据：{evidence.length ? evidence.map((item) => `${item.strength === "strong" ? "强" : "普通"}/${item.kind}${item.sha256 ? ` · SHA-256 ${item.sha256.slice(0, 12)}…` : ""}`).join("、") : "未关联"}</p>
              {highRisk && <input value={evidenceRefs[fact.id] || ""} onChange={(event) => setEvidenceRefs((current) => ({ ...current, [fact.id]: event.target.value }))} placeholder="https:// 可核验的官方页面或文件链接" className="mt-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand/50" />}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => attachEvidence(fact)} className="rounded-md border border-border px-3 py-1.5 text-xs">{highRisk ? "关联强证据" : "添加本人确认证据"}</button>
                {highRisk && <label className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs">上传本地强证据<input type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" disabled={busy} onChange={(event) => { void uploadEvidence(fact, event.target.files?.[0]); event.currentTarget.value = ""; }} className="sr-only" /></label>}
                {fact.status !== "confirmed" && <button type="button" disabled={busy} onClick={() => updateFactStatus(fact, "confirmed")} className="rounded-md bg-brand px-3 py-1.5 text-xs text-brand-foreground">确认事实</button>}
                {fact.status !== "rejected" && <button type="button" disabled={busy} onClick={() => updateFactStatus(fact, "rejected")} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted">拒绝</button>}
                {fact.status === "rejected" && <button type="button" disabled={busy} onClick={() => updateFactStatus(fact, "unconfirmed")} className="rounded-md border border-border px-3 py-1.5 text-xs">恢复待确认</button>}
              </div>
            </article>;
          })}
          {!profile.facts.length && <p className="py-8 text-center text-sm text-muted">暂无事实，请先导入内容。系统不会创建或猜测你的个人资料。</p>}
        </div>
      </section>
      <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">教育与应届身份</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {educationRows.map((row) => {
            const current = structured.education[row.key];
            return <div key={row.key} className="rounded-lg border border-border p-3"><label className="text-sm font-medium">{row.label}</label>{row.type === "select" ? <select className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2" value={String(current?.value ?? "")} onChange={(event) => setEducation(row.key, { value: event.target.value })}><option value="">待填写</option>{row.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <input type={row.type} className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2" value={String(current?.value ?? "")} onChange={(event) => setEducation(row.key, { value: row.type === "number" ? Number(event.target.value) : event.target.value })} />}<select className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={current?.fact_id || ""} onChange={(event) => setEducation(row.key, { factId: event.target.value })}><option value="">选择证据事实</option>{factOptions(["education", "grade", "ranking", "certificate"]).map((fact) => <option key={fact.id} value={fact.id}>{fact.statement} · {fact.id}</option>)}</select></div>;
          })}
        </div>
      </section>
      <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">英语、证书与政治面貌</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between"><label className="text-sm font-medium">英语等级（可多项）</label><button type="button" onClick={() => setStructured((current) => ({ ...current, language_certificates: [...current.language_certificates, { kind: "CET4", fact_id: "" }] }))} className="rounded-md border border-border px-2 py-1 text-xs">新增</button></div>
            {structured.language_certificates.map((item, index) => <div key={`language-${index}`} className="rounded-md bg-background p-2">
              <div className="grid grid-cols-2 gap-2"><select className="rounded-md border border-border bg-surface px-3 py-2" value={item.kind} onChange={(event) => setLanguage(index, { kind: event.target.value })}><option>CET4</option><option>CET6</option><option>IELTS</option><option>TOEFL</option></select><input type="number" className="rounded-md border border-border bg-surface px-3 py-2" value={item.score ?? ""} onChange={(event) => setLanguage(index, { score: event.target.value ? Number(event.target.value) : undefined })} placeholder="成绩" /></div>
              <select className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={item.fact_id} onChange={(event) => setLanguage(index, { fact_id: event.target.value })}><option value="">选择证书事实</option>{factOptions(["certificate"]).map((fact) => <option key={fact.id} value={fact.id}>{fact.statement}</option>)}</select>
              <button type="button" onClick={() => setStructured((current) => ({ ...current, language_certificates: current.language_certificates.filter((_, itemIndex) => itemIndex !== index) }))} className="mt-2 text-xs text-muted">删除此项</button>
            </div>)}
            {!structured.language_certificates.length && <p className="text-xs text-faint">尚未添加英语等级。</p>}
          </div>
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between"><label className="text-sm font-medium">其他资格证书（可多项）</label><button type="button" onClick={() => setStructured((current) => ({ ...current, credentials: [...current.credentials, { name: "", fact_id: "" }] }))} className="rounded-md border border-border px-2 py-1 text-xs">新增</button></div>
            {structured.credentials.map((item, index) => <div key={`credential-${index}`} className="rounded-md bg-background p-2">
              <div className="grid grid-cols-2 gap-2"><input className="rounded-md border border-border bg-surface px-3 py-2" value={item.name} onChange={(event) => setCredential(index, { name: event.target.value })} placeholder="证书名称" /><input className="rounded-md border border-border bg-surface px-3 py-2" value={item.level || ""} onChange={(event) => setCredential(index, { level: event.target.value || undefined })} placeholder="等级（可选）" /></div>
              <select className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={item.fact_id} onChange={(event) => setCredential(index, { fact_id: event.target.value })}><option value="">选择证书事实</option>{factOptions(["certificate"]).map((fact) => <option key={fact.id} value={fact.id}>{fact.statement}</option>)}</select>
              <button type="button" onClick={() => setStructured((current) => ({ ...current, credentials: current.credentials.filter((_, itemIndex) => itemIndex !== index) }))} className="mt-2 text-xs text-muted">删除此项</button>
            </div>)}
            {!structured.credentials.length && <p className="text-xs text-faint">尚未添加资格证书。</p>}
          </div>
          <div className="rounded-lg border border-border p-3 md:col-span-2">
            <label className="text-sm font-medium">政治面貌（敏感，仅资格硬筛；不会发送给软匹配 AI）</label><div className="mt-2 grid gap-2 md:grid-cols-2"><input className="rounded-md border border-border bg-background px-3 py-2" value={structured.political_status?.value || ""} onChange={(event) => setStructured((current) => ({ ...current, political_status: { value: event.target.value, fact_id: current.political_status?.fact_id || "", sensitivity: "sensitive" } }))} placeholder="如：中共党员" /><select className="rounded-md border border-border bg-background px-3 py-2" value={structured.political_status?.fact_id || ""} onChange={(event) => setStructured((current) => ({ ...current, political_status: event.target.value ? { value: current.political_status?.value || "", fact_id: event.target.value, sensitivity: "sensitive" } : undefined }))}><option value="">选择敏感事实</option>{confirmed.filter((fact) => fact.sensitivity === "sensitive").map((fact) => <option key={fact.id} value={fact.id}>{fact.statement}</option>)}</select></div>
          </div>
        </div>
      </section>
      <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">地点与流动偏好</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border p-3"><label className="text-sm font-medium">意向城市</label><input className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2" value={Array.isArray(structured.preferences.locations?.value) ? (structured.preferences.locations.value as string[]).join("、") : ""} onChange={(event) => setPreference("locations", { value: event.target.value.split(/[、，,]/).map((item) => item.trim()).filter(Boolean) })} placeholder="北京、上海" /><select className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2" value={structured.preferences.locations?.fact_id || ""} onChange={(event) => setPreference("locations", { factId: event.target.value })}><option value="">选择偏好事实</option>{factOptions(["preference", "basic"]).map((fact) => <option key={fact.id} value={fact.id}>{fact.statement}</option>)}</select></div>
          {[["relocation", "接受异地"], ["rotation", "接受轮岗"], ["grassroots_service", "接受基层"], ["travel", "接受出差"], ["adjustment", "接受调剂"]].map(([key, label]) => <div key={key} className="rounded-lg border border-border p-3"><label className="text-sm font-medium">{label}</label><select className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2" value={String(structured.preferences[key]?.value || "")} onChange={(event) => setPreference(key, { value: event.target.value })}><option value="">待确认</option><option value="yes">是</option><option value="no">否</option><option value="unknown">视情况</option></select><select className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2" value={structured.preferences[key]?.fact_id || ""} onChange={(event) => setPreference(key, { factId: event.target.value })}><option value="">选择偏好事实</option>{factOptions(["preference"]).map((fact) => <option key={fact.id} value={fact.id}>{fact.statement}</option>)}</select></div>)}
        </div>
      </section>
      <section className="rounded-xl border border-border bg-surface p-5"><h2 className="text-lg font-semibold">已确认事实</h2><p className="mt-1 text-sm text-muted">下面这些事实可供结构化资格字段引用；保存时仍会重新校验证据强度和用途授权。</p><div className="mt-4 space-y-2">{confirmed.map((fact) => <div key={fact.id} className="rounded-lg bg-surface-hover p-3 text-sm"><p>{fact.statement}</p><p className="mt-1 text-xs text-faint">{fact.id} · {fact.type} · 证据 {fact.evidence_ids.length}</p></div>)}</div></section>
      <div className="flex items-center gap-3"><button type="button" disabled={busy} onClick={save} className="rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground disabled:opacity-50">保存资格资料</button>{message && <p className="text-sm text-muted">{message}</p>}</div>
    </div>
  );
}
