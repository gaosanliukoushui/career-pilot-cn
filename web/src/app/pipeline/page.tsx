import Link from "next/link";
import { CareerPilotApplicationList } from "@/components/cn/application-list";

export const dynamic = "force-dynamic";

export default function PipelinePage() {
  return <>
    <CareerPilotApplicationList />
    <div className="mx-auto max-w-5xl px-5 pb-10 md:px-8">
      <details className="rounded-xl border border-border bg-surface/50 p-4 text-sm text-muted">
        <summary className="cursor-pointer font-medium text-foreground">高级功能：海外 ATS 与旧版汇总</summary>
        <p className="mt-2">海外扫描和旧版 Markdown 管道不再是中国校招默认主链。需要时可进入 <Link className="text-brand hover:underline" href="/explore">海外职位发现</Link> 或 <Link className="text-brand hover:underline" href="/portals">门户配置</Link>。</p>
      </details>
    </div>
  </>;
}
