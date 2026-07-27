import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";

type EvidenceBody = {
  fact_id?: string;
  id?: string;
  kind?: string;
  ref?: string;
  strength?: "ordinary" | "strong";
  verified_at?: string;
};

export async function POST(req: Request) {
  let body: EvidenceBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  if (!body.fact_id || !body.id || !body.kind || !body.ref || !body.strength) {
    return Response.json({ error: "证据字段不完整" }, { status: 400 });
  }
  const args = [
    "attach-evidence", body.fact_id,
    "--id", body.id,
    "--kind", body.kind,
    "--ref", body.ref,
    "--strength", body.strength,
  ];
  if (body.verified_at) args.push("--verified-at", body.verified_at);
  const result = await runCareerPilot(args);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 400 });
}
