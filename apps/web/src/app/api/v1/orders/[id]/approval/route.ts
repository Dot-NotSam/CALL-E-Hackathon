import { NextResponse } from "next/server";
import { z } from "zod";
import { decideApproval } from "@/lib/db/orders-repository";
import { StoreError } from "@/lib/mock/store";

export const dynamic = "force-dynamic";

const Body = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(280).default(""),
});

/**
 * POST /api/v1/orders/:id/approval — operator decision on price change (FR-5.3).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", message: 'Expected { decision: "APPROVE" | "REJECT", note? }' },
      { status: 400 },
    );
  }

  try {
    await decideApproval(id, parsed.data.decision, parsed.data.note);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof StoreError) {
      return NextResponse.json({ error: "rejected", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
