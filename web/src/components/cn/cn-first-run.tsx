import Link from "next/link";

export function CareerPilotCnFirstRun() {
  return (
    <div className="dot-bg flex min-h-screen items-center justify-center p-6">
      <section className="w-full max-w-3xl rounded-2xl border border-border bg-surface/95 p-7 shadow-sm md:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">CareerPilot CN</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">先建立可信事实，再开始投递</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted">系统不会直接把一份旧简历当成全部事实。先导入经历，逐条确认并补充证据，再生成主简历、核对央国企资格条件和准备网申材料。</p>
        <ol className="mt-7 grid gap-3 md:grid-cols-3">
          {[
            ["01", "建立事实档案", "导入简历或逐条录入经历，未经确认的内容不会发布。"],
            ["02", "确认主简历", "从已确认事实生成央国企一页版或技术两页版。"],
            ["03", "分析招聘公告", "导入官网 JD，先做资格硬筛，再做匹配和定制。"],
          ].map(([number, title, description]) => <li key={number} className="rounded-xl bg-surface-hover p-4"><span className="text-xs font-semibold text-brand-text">{number}</span><h2 className="mt-2 font-semibold">{title}</h2><p className="mt-1 text-sm leading-6 text-muted">{description}</p></li>)}
        </ol>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/profile" className="rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground">建立个人事实与证据</Link>
          <Link href="/job-analysis" className="rounded-md border border-border px-5 py-2.5 font-medium hover:bg-surface-hover">先查看岗位分析入口</Link>
        </div>
        <p className="mt-5 text-xs text-faint">身份证号码、家庭成员和详细住址不会保存到本地文件；需要时仅提示本人在官网手工填写。</p>
      </section>
    </div>
  );
}
