import Link from "next/link";

export default function InterviewCenterPlaceholder() {
  return (
    <main className="mx-auto max-w-4xl p-5 md:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">V4 · 预留入口</p>
      <h1 className="mt-2 text-3xl font-semibold">面试中心</h1>
      <div className="mt-6 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold">本正式版暂不实现</h2>
        <p className="mt-2 leading-7 text-muted">当前版本只记录一面、专业面、HR 面、体检、背调和政审等阶段，不生成面试题、不自动评价候选人，也不替用户作出承诺。</p>
        <p className="mt-3 text-sm text-muted">阶段数据已保存在申请侧车文件中，后续 V4 会在不改变现有申请记录的前提下扩展。</p>
        <Link href="/pipeline" className="mt-5 inline-flex rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground">查看申请进度</Link>
      </div>
    </main>
  );
}
