import { NextResponse } from "next/server";
import { listFollowUps } from "@/lib/db/orders-repository";

export const dynamic = "force-dynamic";

/** GET /api/v1/followups — scheduled callbacks and verification calls, soonest first. */
export async function GET() {
  const followUps = await listFollowUps();
  return NextResponse.json({ followUps });
}
