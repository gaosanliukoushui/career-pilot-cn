// The cost-honesty taxonomy — a single source for the FREE vs $ boundary that the
// Explorer teaches by repetition. Discovery (finding roles) is structurally free:
// it calls no LLM. Only evaluation (scoring a role against your CV) spends tokens,
// and only when the user chooses it. The framing is always local-first: "your key,
// your AI, your machine."

export type CostClass = "free" | "free-network" | "spend" | "free-gemini";

export const COST_META: Record<CostClass, { label: string; tip: string }> = {
  "free-network": {
    label: "免费",
    tip: "通过 HTTP 扫描公开 ATS 网络，不使用 AI、不消耗令牌，也不会发送个人数据；只有你选择加入职位后才会写入本地文件。",
  },
  free: {
    label: "免费",
    tip: "不消耗令牌，只读取或写入本地文件。",
  },
  spend: {
    label: "消耗令牌",
    tip: "使用你自己的 AI 执行真实的 A–F 职位评估。只有你主动选择职位时才会消耗令牌。",
  },
  "free-gemini": {
    label: "免费 · Gemini",
    tip: "使用 Google Gemini 免费额度进行评估，不产生令牌费用。",
  },
};
