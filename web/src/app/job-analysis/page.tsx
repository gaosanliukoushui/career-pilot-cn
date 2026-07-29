import { JobAnalysisWorkbench } from "@/components/cn/job-analysis-workbench";

export const dynamic = "force-dynamic";

export default async function JobAnalysisPage({ searchParams }: { searchParams: Promise<{ job?: string; tailoring?: string }> }) {
  const query = await searchParams;
  return <JobAnalysisWorkbench initialJobId={query.job} initialTailoringId={query.tailoring} />;
}
