import { ChevronDown, ExternalLink } from "lucide-react";

// Transparency = our differentiator ("why it's a 4.0 for YOU"). The wording is
// the CANONICAL public text from career-ops.org/methodology + /docs — rendered
// verbatim, NOT a web reinterpretation of the rubric (whose weights live in the
// core, modes/_shared.md). Native <details> → no client JS.

const DIMENSIONS: [string, string][] = [
  ["匹配度", "你的简历与职位要求的匹配程度"],
  ["职业目标一致性", "该职位能在多大程度上推动你实现职业目标"],
  ["薪酬", "职位薪酬与市场水平的比较；缺少信息时会明确标注，不会编造数字"],
  ["文化信号", "招聘信息中体现的团队、价值观和工作方式"],
  ["风险信号", "幽灵职位、诈骗或不匹配等风险提示"],
  ["综合评价", "汇总以上维度形成的最终判断"],
];

const BLOCKS: [string, string][] = [
  ["A", "职位概况"],
  ["B", "简历与各项要求的匹配情况及差距"],
  ["C", "申请策略与个人定位"],
  ["D", "薪酬研究及市场水平比较"],
  ["E", "申请材料个性化建议"],
  ["F", "针对该职位的 STAR 面试故事准备"],
  ["G", "职位真实性检查，识别诈骗或幽灵职位"],
];

export function ScoreMethodology() {
  return (
    <details className="group mt-10 overflow-hidden rounded-2xl border border-border bg-surface/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-medium transition-colors hover:bg-surface-hover">
        career-ops 如何评分，以及为什么适合<span className="text-landing">你</span>
        <ChevronDown className="ml-auto size-4 text-faint transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 border-t border-border px-5 py-4 text-sm">
        <p className="text-muted">
          每个职位都会从六个维度获得 <strong className="text-foreground">1.0–5.0</strong> 分。{" "}
          <strong className="text-brand">4.0</strong> 是建议申请线；低于该分数时，career-ops 通常不建议申请。
        </p>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-faint">六个评分维度</div>
          <ul className="space-y-1.5">
            {DIMENSIONS.map(([k, v]) => (
              <li key={k}>
                <span className="font-medium text-foreground">{k}</span> <span className="text-muted">— {v}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-faint">报告各部分说明</div>
          <ul className="space-y-2">
            {BLOCKS.map(([k, v]) => (
              <li key={k} className="flex items-start gap-2.5">
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded bg-brand-soft text-xs font-semibold text-brand">
                  {k}
                </span>
                <span className="text-muted">{v}</span>
              </li>
            ))}
          </ul>
        </div>
        <a
          href="https://career-ops.org/methodology"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-brand transition-colors hover:underline"
        >
          查看完整评分方法 <ExternalLink className="size-3" />
        </a>
      </div>
    </details>
  );
}
