import { NextResponse } from "next/server";
import { getOrder } from "@/lib/db/orders-repository";

export const dynamic = "force-dynamic";

/** GET /api/v1/orders/:id — single order detail, contact ladder, and finished status. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = await getOrder(id);

  if (!data) {
    return NextResponse.json({ error: "not_found", message: `No order ${id}` }, { status: 404 });
  }

  return NextResponse.json(data);
}
