import { Radar } from "lucide-react";
import { PortalsView } from "@/components/portals-view";

export const dynamic = "force-dynamic";

export default function PortalsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex items-center gap-3">
        <Radar className="size-6 text-brand" />
        <h1 className="font-display text-2xl tracking-tight text-landing">招聘门户</h1>
      </div>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        career-ops 会持续关注这些公司的新职位。运行健康检查可发现悄然失效的招聘页面；链接失效会导致该公司从后续扫描结果中消失。
      </p>
      <p className="mt-1.5 text-xs text-faint">
        数据来自 <code className="text-muted">portals.yml</code>，你可以直接编辑，也可以让助手代为配置。
      </p>
      <div className="mt-6">
        <PortalsView />
      </div>
    </div>
  );
}
