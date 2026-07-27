import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PreviewBody = {
  template?: string;
  authorize_photo?: boolean;
  authorize_political_status?: boolean;
  rewrites?: { fact_id: string; proposed_statement: string; accepted: boolean }[];
};

export async function POST(req: Request) {
  let body: PreviewBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  const result = await runCareerPilot(["resume-preview", "--stdin"], JSON.stringify({
    template: body.template || "soe-one-page",
    rewrites: body.rewrites || [],
    sensitive_authorizations: { photo: Boolean(body.authorize_photo), political_status: Boolean(body.authorize_political_status) },
  }));
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 400 });
}
