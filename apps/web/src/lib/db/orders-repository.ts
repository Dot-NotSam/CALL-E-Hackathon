/**
 * apps/web/src/lib/db/orders-repository.ts
 * Orders Data Repository for Sentinel Ops.
 *
 * Interacts with Supabase PostgreSQL tables when configured.
 * Seamlessly falls back to `store.ts` when running without Supabase credentials.
 * Supports Role-Based Access Control (RBAC) filtering (`ADMIN`, `DISTRIBUTOR`, `WHOLESALER`).
 */

import type { Contact, FollowUp, Order, OrderStatus, TriggerType } from "@/lib/contracts/domain";
import type { SentinelEvent } from "@/lib/contracts/events";
import { getSupabaseClient, hasSupabaseConfig } from "./supabase-client";

import * as mockStore from "../mock/store";
import { BUYER, SELLER, contactById, ladderFor } from "../mock/directory";

export type UserRole = "ADMIN" | "DISTRIBUTOR";

export interface ListOrdersFilter {
  role?: UserRole;
  orgId?: string;
  status?: OrderStatus;
}

export interface NewOrderInput {
  reference: string;
  description: string;
  unit: string;
  quantity: number;
  requiredBy: string;
  triggerType: TriggerType;
}

/**
 * List orders with optional RBAC filtering.
 */
export async function listOrders(filter?: ListOrdersFilter): Promise<Order[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    const orders = mockStore.listOrders();
    return filterOrdersByRole(orders, filter);
  }

  let query = supabase.from("orders").select(`
    *,
    buyer:organizations!buyer_id(*),
    seller:organizations!seller_id(*),
    order_items(*)
  `).order("created_at", { ascending: false });

  if (filter?.status) {
    query = query.eq("status", filter.status);
  }

  const { data, error } = await query;
  if (error || !data) {
    console.error("Supabase fetch orders error, falling back to mock:", error);
    return filterOrdersByRole(mockStore.listOrders(), filter);
  }

  const orders: Order[] = data.map((row: any) => mapRowToOrder(row));
  return filterOrdersByRole(orders, filter);
}

/**
 * Filter orders based on user role.
 */
function filterOrdersByRole(orders: Order[], filter?: ListOrdersFilter): Order[] {
  if (!filter || !filter.role || filter.role === "ADMIN") {
    return orders;
  }
  if (filter.role === "DISTRIBUTOR") {
    return orders.filter(
      (o) => o.buyer.role === "DISTRIBUTOR" && (!filter.orgId || o.buyer.id === filter.orgId)
    );
  }
  return orders;
}

/**
 * Get single order by system ID along with contact ladder.
 */
export async function getOrder(
  id: string
): Promise<{ order: Order; ladder: Contact[]; finished: boolean } | null> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    const run = mockStore.getRun(id);
    if (!run) return null;
    return { order: run.order, ladder: run.ladder, finished: run.finished };
  }

  const { data, error } = await supabase
    .from("orders")
    .select(`
      *,
      buyer:organizations!buyer_id(*),
      seller:organizations!seller_id(*)
    `)
    .eq("id", id)
    .single();

  if (error || !data) {
    const run = mockStore.getRun(id);
    if (!run) return null;
    return { order: run.order, ladder: run.ladder, finished: run.finished };
  }

  const order = mapRowToOrder(data);
  const ladder = ladderFor(order.seller.id);
  const finished = ["CONFIRMED", "PARTIALLY_CONFIRMED", "CALLBACK_SCHEDULED", "HUMAN_REVIEW", "UNRESOLVED", "SUPPRESSED"].includes(
    order.status
  );

  return { order, ladder, finished };
}

/**
 * Get historical SSE events for event replay on SSE connect.
 */
export async function getOrderEvents(id: string): Promise<SentinelEvent[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    const run = mockStore.getRun(id);
    return run ? run.emitted : [];
  }

  const { data, error } = await supabase
    .from("agent_events")
    .select("payload")
    .eq("order_id", id)
    .order("created_at", { ascending: true });

  if (error || !data || data.length === 0) {
    const run = mockStore.getRun(id);
    return run ? run.emitted : [];
  }

  return data.map((d: any) => d.payload as SentinelEvent);
}

/**
 * List scheduled follow-ups.
 */
export async function listFollowUps(): Promise<mockStore.FollowUpView[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return mockStore.listFollowUps();
  }

  const { data, error } = await supabase
    .from("follow_ups")
    .select(`
      *,
      orders!order_id(reference, id)
    `)
    .eq("status", "SCHEDULED")
    .order("due_at", { ascending: true });

  if (error || !data) {
    return mockStore.listFollowUps();
  }

  return data.map((f: any) => ({
    id: f.id,
    orderId: f.order_id,
    kind: f.kind,
    dueAt: f.due_at,
    contactId: f.contact_id,
    note: f.note,
    status: f.status,
    orderReference: f.orders?.reference ?? f.order_id,
    contactName: contactById(f.contact_id)?.name ?? "Unknown contact",
  }));
}

/**
 * Price change approval decision.
 */
export async function decideApproval(
  orderId: string,
  decision: "APPROVE" | "REJECT",
  note: string
): Promise<void> {
  // Always update mock run if present
  try {
    mockStore.decideApproval(orderId, decision, note);
  } catch (err) {
    // ignore mock errors if purely in Supabase mode
  }

  const supabase = getSupabaseClient();
  if (supabase) {
    const newStatus: OrderStatus = decision === "APPROVE" ? "CONFIRMED" : "HUMAN_REVIEW";
    const summary = decision === "APPROVE"
      ? `Operator approved price update. Order confirmed today.`
      : `Operator rejected proposed price update. Renegotiation required.`;

    await supabase
      .from("orders")
      .update({
        status: newStatus,
        outcome: summary,
        closed_at: new Date().toISOString(),
      })
      .eq("id", orderId);
  }
}

/**
 * Field override.
 */
export async function overrideResult(orderId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    mockStore.overrideResult(orderId, patch);
  } catch (err) {
    // ignore mock errors if purely in Supabase mode
  }

  const supabase = getSupabaseClient();
  if (supabase) {
    await supabase
      .from("calls")
      .update({ structured_result: patch })
      .eq("order_id", orderId);
  }
}

/**
 * Kill switch status & toggle.
 */
export async function isKillSwitchEngaged(): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return mockStore.isKillSwitchEngaged();
  }

  const { data } = await supabase.from("system_settings").select("value").eq("key", "killswitch").single();
  return Boolean(data?.value?.engaged);
}

export async function setKillSwitch(engaged: boolean): Promise<boolean> {
  mockStore.setKillSwitch(engaged);

  const supabase = getSupabaseClient();
  if (supabase) {
    await supabase.from("system_settings").upsert({
      key: "killswitch",
      value: { engaged },
      updated_at: new Date().toISOString(),
    });
  }
  return engaged;
}

/**
 * Helper to map Supabase table row to Domain Order object.
 */
function mapRowToOrder(row: any): Order {
  const item = Array.isArray(row.order_items) && row.order_items.length > 0 ? row.order_items[0] : null;

  return {
    id: row.id,
    reference: row.reference,
    traceId: row.trace_id,
    buyer: row.buyer ? { id: row.buyer.id, name: row.buyer.name, role: row.buyer.role } : BUYER,
    seller: row.seller ? { id: row.seller.id, name: row.seller.name, role: row.seller.role } : SELLER,
    item: {
      sku: item?.sku ?? "MED-TS-CASE",
      description: item?.description ?? "Temperature-sensitive medical supplies",
      unit: item?.unit ?? "cases",
      requestedQuantity: item?.requested_quantity ?? 200,
      confirmedQuantity: item?.confirmed_quantity ?? null,
      remainingQuantity: item?.remaining_quantity ?? null,
      unitPrice: item?.unit_price ? Number(item.unit_price) : 1850,
      currency: item?.currency ?? "INR",
    },
    status: row.status as OrderStatus,
    urgency: row.urgency,
    requiredBy: row.required_by,
    trigger: {
      type: "INVENTORY",
      summary: row.outcome ?? `Order ${row.reference} needs confirmation`,
      receivedAt: row.created_at,
    },
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null,
    currentRung: row.current_rung ?? 1,
    maxRungs: row.max_rungs ?? 3,
    outcome: row.outcome ?? null,
    operatorMinutesSaved: row.operator_minutes_saved ?? null,
    scenarioId: row.scenario_id ?? "hero-replenishment",
  };
}
