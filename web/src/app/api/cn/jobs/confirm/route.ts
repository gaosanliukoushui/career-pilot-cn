import { runCareerPilot } from "@/lib/careerpilot";
import type { JobPosting } from "@/lib/cn-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    posting?: JobPosting;
    official_source_confirmed?: boolean;
    official_source_evidence?: string;
  };
  if (!body.posting) return Response.json({ error: "缺少待确认岗位结构" }, { status: 400 });
  const result = await runCareerPilot(["job-confirm", "--stdin"], JSON.stringify(body));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, {
    status: result.ok ? 200 : 422,
  });
}
