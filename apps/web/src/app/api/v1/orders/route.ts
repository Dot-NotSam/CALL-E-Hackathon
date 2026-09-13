import { NextResponse } from "next/server";
import { listOrders, type UserRole } from "@/lib/db/orders-repository";
import type { OrderStatus } from "@/lib/contracts/domain";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/orders — queue of orders (supports ?status= and RBAC ?role=ADMIN|DISTRIBUTOR|WHOLESALER).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") as OrderStatus | null;
  const role = url.searchParams.get("role") as UserRole | null;
  const orgId = url.searchParams.get("orgId") || undefined;

  const orders = await listOrders({
    status: status || undefined,
    role: role || "ADMIN",
    orgId,
  });

  return NextResponse.json({ orders });
}
