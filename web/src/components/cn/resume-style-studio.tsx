"use client";

import { Check, Columns2, FileText, ImageIcon, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ResumeStyleCatalog, ResumeStyleDefinition, ResumeStyleProfile } from "@/lib/cn-types";

type StyleResponse = { style: ResumeStyleProfile; catalog: ResumeStyleCatalog };

const EMPHASIS_LABEL: Record<ResumeStyleProfile["emphasis"], string> = {
  general: "综合通用",
  technical: "技术交付",
  research: "科研成果",
  campus: "校园综合",
};

function previewStyle(definition: ResumeStyleDefinition, current: ResumeStyleProfile): ResumeStyleProfile {
  return {
    schema_version: 2,
    theme: definition.id,
    density: current.density,
    page_budget: current.page_budget,
    emphasis: current.emphasis,
    font_family: definition.defaults.font_family,
    font_size_pt: definition.defaults.font_size_pt,
    page_margin_cm: definition.defaults.page_margin_cm,
    section_order: [...definition.defaults.section_order],
    project_bullet_limit: definition.defaults.project_bullet_limit,
    photo: { ...definition.defaults.photo, enabled: current.photo.enabled },
  };
}

function ResumePreviewFrame({
  html,
  title,
  scale,
}: {
  html: string;
  title: string;
  scale: number;
}) {
  const width = Math.round(794 * scale);
  const height = Math.round(1123 * scale);
  return (
    <div className="max-w-full overflow-auto">
      <div
        className="relative overflow-hidden border border-border bg-white"
        style={{ width, height }}
      >
        <iframe
          title={title}
          sandbox=""
          srcDoc={html}
          tabIndex={-1}
          className="pointer-events-none absolute left-0 top-0 border-0 bg-white"
          style={{ width: 794, height: 1123, transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      </div>
    </div>
  );
}

function StyleCard({
  definition,
  selected,
  recommended,
  compared,
  onSelect,
  onCompare,
}: {
  definition: ResumeStyleDefinition;
  selected: boolean;
  recommended: boolean;
  compared: boolean;
  onSelect: () => void;
  onCompare: () => void;
}) {
  return (
    <article
      className={`flex min-w-0 flex-col border bg-background p-3 transition-colors duration-200 ${
        selected ? "border-brand" : "border-border hover:border-muted"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-foreground">{definition.label}</h4>
          <p className="mt-0.5 text-xs text-muted">{definition.preview.subtitle}</p>
        </div>
        {selected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-1 text-[11px] font-semibold text-brand-text">
            <Check className="size-3" /> 已选择
          </span>
        ) : recommended ? (
          <span className="rounded-full bg-brand-soft px-2 py-1 text-[11px] font-semibold text-brand-text">推荐</span>
        ) : null}
      </div>
      <div className="mt-3 flex justify-center bg-surface-hover p-2">
        <ResumePreviewFrame html={definition.preview_html} title={`${definition.label}匿名预览`} scale={0.25} />
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">{definition.description}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {definition.preview.key_points.map((point) => (
          <span key={point} className="rounded-full border border-border px-2 py-1 text-[11px] text-muted">{point}</span>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={`mt-auto border px-3 py-2 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          selected ? "border-brand bg-brand text-brand-foreground" : "border-border text-foreground hover:bg-surface-hover"
        }`}
      >
        {selected ? "当前风格" : "选择此风格"}
      </button>
      <button
        type="button"
        aria-pressed={compared}
        onClick={onCompare}
        className={`mt-3 inline-flex items-center justify-center gap-1.5 border px-3 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          compared ? "border-brand bg-brand-soft text-brand-text" : "border-border text-foreground hover:bg-surface-hover"
        }`}
      >
        <Columns2 className="size-3.5" />
        {compared ? "已加入比较" : "加入比较"}
      </button>
    </article>
  );
}

export function ResumeStyleStudio() {
  const [style, setStyle] = useState<ResumeStyleProfile | null>(null);
  const [catalog, setCatalog] = useState<ResumeStyleCatalog | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [compareIds, setCompareIds] = useState<ResumeStyleProfile["theme"][]>([]);
  const [status, setStatus] = useState("正在读取风格与匿名预览…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/cn/resumes/style", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "简历风格读取失败");
        return data as StyleResponse;
      })
      .then((data) => {
        setStyle(data.style);
        setCatalog(data.catalog);
        const selected = data.catalog.styles.find((item) => item.id === data.style.theme);
        setPreviewHtml(selected?.preview_html || "");
        setCompareIds([data.catalog.recommendation.style_id, data.style.theme].filter((id, index, list) => list.indexOf(id) === index).slice(0, 2));
        setStatus("");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus(error instanceof Error ? error.message : "简历风格读取失败");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!style) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus("正在用统一内容模型重新排版…");
      void fetch("/api/cn/resumes/style-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(style),
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "匿名预览生成失败");
          setPreviewHtml(data.html);
          setStatus("");
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setStatus(error instanceof Error ? error.message : "匿名预览生成失败");
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [style]);

  const selectedDefinition = useMemo(
    () => catalog?.styles.find((item) => item.id === style?.theme) || null,
    [catalog, style?.theme],
  );
  const comparedDefinitions = useMemo(
    () => compareIds.map((id) => catalog?.styles.find((item) => item.id === id)).filter((item): item is ResumeStyleDefinition => Boolean(item)),
    [catalog, compareIds],
  );

  function selectTheme(definition: ResumeStyleDefinition) {
    if (!style) return;
    setStyle(previewStyle(definition, style));
  }

  function toggleCompare(id: ResumeStyleProfile["theme"]) {
    setCompareIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : current.length < 2
        ? [...current, id]
        : [current[1], id]);
  }

  async function saveStyle() {
    if (!style) return;
    setSaving(true);
    setStatus("正在保存用户层样式偏好…");
    try {
      const response = await fetch("/api/cn/resumes/style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(style),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "样式保存失败");
      setStyle(data.style);
      setStatus("已保存到 profile/resume-style.yml；候选人事实与正文没有被修改。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "样式保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!style || !catalog) {
    return <section className="border border-border bg-surface p-5 text-sm text-muted">{status}</section>;
  }

  const recommendation = catalog.styles.find((item) => item.id === catalog.recommendation.style_id);
  return (
    <section id="resume-style-studio" className="border border-border bg-surface">
      <header className="flex flex-col gap-4 border-b border-border p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2">
            <FileText className="size-5 text-brand-text" />
            <h3 className="text-lg font-semibold">简历风格中心</h3>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            每张缩略图都由正式简历使用的同一标准化内容模型生成。主题只改变版式与视觉层级，正文仍只能来自已确认 Fact。
          </p>
        </div>
        <div className="max-w-md border border-border bg-background p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <ShieldCheck className="size-4 text-brand-text" />
            当前推荐：{recommendation?.label || "央国企蓝色正式"}
          </p>
          <ul className="mt-1 space-y-1 text-xs leading-5 text-muted">
            {catalog.recommendation.reasons.map((reason) => <li key={reason}>· {reason}</li>)}
          </ul>
          <p className="mt-2 text-[11px] text-faint">推荐只依据当前可发布 Fact 分布，不代表录用判断，也不会限制手动选择。</p>
        </div>
      </header>

      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-5">
        {catalog.styles.map((definition) => (
          <StyleCard
            key={definition.id}
            definition={definition}
            selected={style.theme === definition.id}
            recommended={catalog.recommendation.style_id === definition.id}
            compared={compareIds.includes(definition.id)}
            onSelect={() => selectTheme(definition)}
            onCompare={() => toggleCompare(definition.id)}
          />
        ))}
      </div>

      <div className="grid gap-0 border-t border-border xl:grid-cols-[minmax(0,1fr)_430px]">
        <div className="p-5">
          <h4 className="font-semibold">呈现轴</h4>
          <p className="mt-1 text-xs leading-5 text-muted">头像、密度、篇幅和强调方向相互独立；切换主题不会暗中开启敏感字段。</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted">
              信息密度
              <select
                value={style.density}
                onChange={(event) => setStyle({ ...style, density: event.target.value as ResumeStyleProfile["density"] })}
                className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <option value="balanced">平衡：留出稳定阅读间距</option>
                <option value="full">饱满：提高一页信息量</option>
              </select>
            </label>
            <label className="text-xs font-medium text-muted">
              页数预算
              <select
                value={style.page_budget}
                onChange={(event) => setStyle({ ...style, page_budget: Number(event.target.value) as 1 | 2 })}
                className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <option value={1}>一页：超出时明确阻断</option>
                <option value={2}>两页：保留更多已确认内容</option>
              </select>
            </label>
            <label className="text-xs font-medium text-muted">
              内容强调
              <select
                value={style.emphasis}
                onChange={(event) => setStyle({ ...style, emphasis: event.target.value as ResumeStyleProfile["emphasis"] })}
                className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                {Object.entries(EMPHASIS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="flex min-h-16 items-center justify-between gap-3 border border-border bg-background px-3 py-2 text-sm">
              <span>
                <span className="flex items-center gap-1.5 font-medium"><ImageIcon className="size-4" />显示头像位置</span>
                <span className="mt-1 block text-xs text-muted">正式导出仍需逐次授权并校验照片哈希</span>
              </span>
              <input
                type="checkbox"
                checked={style.photo.enabled}
                onChange={(event) => setStyle({ ...style, photo: { ...style.photo, enabled: event.target.checked } })}
                className="size-4 accent-brand"
              />
            </label>
          </div>

          <details className="mt-4 border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-semibold">高级排版约束</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <label className="text-xs font-medium text-muted">
                字体
                <select
                  value={style.font_family}
                  onChange={(event) => setStyle({ ...style, font_family: event.target.value as ResumeStyleProfile["font_family"] })}
                  className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="Microsoft YaHei">微软雅黑</option>
                  <option value="Noto Sans CJK SC">Noto Sans CJK SC</option>
                  <option value="SimSun">宋体</option>
                </select>
              </label>
              <label className="text-xs font-medium text-muted">
                正文字号 pt
                <input type="number" min={8} max={11} step={0.5} value={style.font_size_pt} onChange={(event) => setStyle({ ...style, font_size_pt: Number(event.target.value) })} className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm text-foreground" />
              </label>
              <label className="text-xs font-medium text-muted">
                页边距 cm
                <input type="number" min={0.7} max={2} step={0.05} value={style.page_margin_cm} onChange={(event) => setStyle({ ...style, page_margin_cm: Number(event.target.value) })} className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm text-foreground" />
              </label>
              <label className="text-xs font-medium text-muted">
                单项目建议 bullet 上限
                <input type="number" min={1} max={6} step={1} value={style.project_bullet_limit} onChange={(event) => setStyle({ ...style, project_bullet_limit: Number(event.target.value) })} className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm text-foreground" />
                <span className="mt-1 block text-[11px] font-normal leading-4 text-faint">用于编辑建议；没有项目归属信息时不会自动删除 Fact。</span>
              </label>
            </div>
          </details>

          <details className="mt-4 border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-semibold">央国企内容写法规则</summary>
            <p className="mt-2 text-xs leading-5 text-muted">
              参考图只用于学习区块顺序、密度和表达结构，不能给候选人引入学校、单位、指标、荣誉或身份事实。
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {Object.values(catalog.editorial_policy.sections).map((section) => (
                <div key={section.label} className="border border-border bg-background p-3">
                  <p className="text-sm font-semibold">{section.label}</p>
                  <p className="mt-1 text-xs leading-5 text-muted">{section.pattern.join(" → ")}</p>
                  <p className="mt-2 text-[11px] leading-5 text-faint">避免：{section.avoid.join("；")}</p>
                </div>
              ))}
            </div>
          </details>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" onClick={saveStyle} disabled={saving} className="bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground hover:bg-brand-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50">
              {saving ? "正在保存…" : "保存当前风格"}
            </button>
            <span role="status" className="text-xs text-muted">{status}</span>
          </div>
        </div>

        <aside className="border-t border-border bg-background p-5 xl:border-l xl:border-t-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">当前真实预览</p>
              <p className="mt-0.5 text-xs text-muted">{selectedDefinition?.label} · {EMPHASIS_LABEL[style.emphasis]} · {style.page_budget} 页预算</p>
            </div>
            <span className="h-5 w-5 border border-black/10" style={{ background: selectedDefinition?.palette.accent }} aria-label="主题色" />
          </div>
          <div className="mt-3 flex justify-center overflow-hidden bg-surface-hover p-3">
            {previewHtml ? <ResumePreviewFrame html={previewHtml} title="当前简历风格匿名真实预览" scale={0.45} /> : <p className="p-8 text-sm text-muted">正在生成预览…</p>}
          </div>
        </aside>
      </div>

      {comparedDefinitions.length === 2 && (
        <section className="border-t border-border p-5">
          <div className="flex items-center gap-2">
            <Columns2 className="size-4 text-brand-text" />
            <h4 className="font-semibold">并排比较</h4>
          </div>
          <p className="mt-1 text-xs text-muted">两边使用完全相同的匿名内容；只比较版式、密度和默认篇幅。</p>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {comparedDefinitions.map((definition) => (
              <div key={definition.id} className="border border-border bg-background p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold">{definition.label}</p>
                    <p className="text-xs text-muted">{definition.recommendation.summary}</p>
                  </div>
                  <span className="h-5 w-5 border border-black/10" style={{ background: definition.palette.accent }} />
                </div>
                <div className="mt-3 flex justify-center overflow-hidden bg-surface-hover p-3">
                  <ResumePreviewFrame html={definition.preview_html} title={`${definition.label}并排预览`} scale={0.4} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
