import { ApplicationDetailLoader } from "@/components/cn/application-detail-loader";

export const dynamic = "force-dynamic";

export default async function ApplicationMaterialDetailPage({ params }: { params: Promise<{ tracker: string }> }) {
  const { tracker } = await params;
  return <ApplicationDetailLoader tracker={tracker} />;
}
