import { ProjectInterviewWorkbench } from "@/components/cn/project-interview-workbench";

export default function InterviewCenterPage() {
  return (
    <main className="mx-auto max-w-6xl p-5 md:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-text">AI 项目面试特训</p>
      <h1 className="mt-2 text-3xl font-semibold md:text-4xl">项目面试官特训</h1>
      <p className="mt-3 max-w-3xl text-base leading-7 text-muted">围绕正式简历实际选中的项目做事实约束分析、参考解答和逐题模拟。模型负责追问与表达训练，CareerPilot 负责守住事实和贡献边界。</p>
      <div className="mt-7"><ProjectInterviewWorkbench /></div>
    </main>
  );
}
