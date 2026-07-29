"use client";

import { useRef } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { CostBadge } from "@/components/cost/cost-badge";

const EXAMPLES = [
  "气候科技初创公司的 AI 基础设施岗位，欧盟远程",
  "A 轮开发者工具公司的前线部署工程师，美国远程",
  "本周发布的医疗科技应用 AI 负责人岗位",
];

// The "magic" natural-language box: a soft contained halo at rest that intensifies
// on focus (erupts into the full-viewport hunt on submit). Effect CSS co-located
// per the Tailwind v4 stale-CSS HMR gotcha.
const STYLE = `
.co-aibox{position:relative;border-radius:1.1rem;border:1px solid var(--co-border,hsl(0 0% 50% /.22));background:color-mix(in srgb, var(--bg) 55%, transparent);transition:border-color .3s,box-shadow .3s}
.co-aibox::before{content:"";position:absolute;inset:-1px;border-radius:1.1rem;padding:1px;background:radial-gradient(70% 140% at 28% -10%, hsl(26 82% 55% /.45), transparent 62%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.45;transition:opacity .3s;pointer-events:none}
.co-aibox:focus-within::before{opacity:1}
.co-aibox:focus-within{border-color:hsl(26 73% 51% /.5);box-shadow:0 0 0 4px hsl(26 73% 51% /.09)}
.co-aibox textarea{width:100%;resize:none;background:transparent;border:none;outline:none;font-size:16px;line-height:1.5;color:inherit}
.co-aibox textarea::placeholder{color:var(--co-faint,hsl(0 0% 58%))}
@media(prefers-reduced-motion:reduce){.co-aibox,.co-aibox::before{transition:none}}
`;

export function AiSearchBox({
  intent,
  onIntent,
  onSubmit,
  cliConfigured,
  cliName,
  onRunScan,
}: {
  intent: string;
  onIntent: (s: string) => void;
  onSubmit: () => void;
  cliConfigured: boolean;
  cliName?: string;
  onRunScan: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const t = ref.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
    }
  };

  return (
    <div>
      <style>{STYLE}</style>
      <div className="co-aibox p-4">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-brand">
          <Sparkles className="size-3.5" /> 描述你想找的职位，AI 会在公开网络中搜索
        </div>
        <textarea
          ref={ref}
          rows={2}
          value={intent}
          onChange={(e) => {
            onIntent(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (intent.trim()) onSubmit();
            }
          }}
          placeholder="例如：气候科技初创公司的 AI 基础设施岗位，欧洲远程，非专家级——直接用自然语言描述"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            {cliConfigured ? (
              <>
                使用 <span className="text-foreground">{cliName || "你的命令行工具"}</span> 读取公开网页，会消耗你的令牌。
              </>
            ) : (
              "请先在系统配置中连接 AI 命令行工具。"
            )}
          </span>
          <button
            type="button"
            disabled={!intent.trim()}
            onClick={onSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-50"
          >
            搜索公开网络
            <CostBadge kind="spend" size="xs" />
            <ArrowRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onIntent(ex)}
            className="rounded-full border border-border bg-surface/40 px-3 py-1.5 text-[12px] text-muted transition hover:border-brand/40 hover:text-brand"
          >
            {ex}
          </button>
        ))}
        <button type="button" onClick={onRunScan} className="ml-auto inline-flex items-center gap-1 text-[12px] text-faint transition hover:text-foreground">
          或改用免费扫描 →
        </button>
      </div>
    </div>
  );
}
