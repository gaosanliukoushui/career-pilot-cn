import { CampaignWorkbench } from "@/components/cn/campaign-workbench";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignWorkbench campaignId={id} />;
}
