import Link from "next/link";

export default function OfferOnboardingPlaceholder() {
  return (
    <main className="mx-auto max-w-4xl p-5 md:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">V5 · 预留入口</p>
      <h1 className="mt-2 text-3xl font-semibold">Offer 与入职管理</h1>
      <div className="mt-6 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold">本正式版暂不实现</h2>
        <p className="mt-2 leading-7 text-muted">当前版本只保留“拟录用”和“签约”阶段及兼容状态映射，不分析合同、不代替法律意见，也不会自动接受 offer 或提交外部表单。</p>
        <p className="mt-3 text-sm text-muted">后续 V5 将复用现有申请侧车标识和锁定写入路径，不另建一套申请数据。</p>
        <Link href="/application-materials" className="mt-5 inline-flex rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground">返回网申材料</Link>
      </div>
    </main>
  );
}
