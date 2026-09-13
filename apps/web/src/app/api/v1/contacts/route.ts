import { NextResponse } from "next/server";
import { CONTACTS, ORGANIZATIONS, SELLER, WORKING_HOURS } from "@/lib/mock/directory";
import { getSupabaseClient, hasSupabaseConfig } from "@/lib/db/supabase-client";
import type { Contact } from "@/lib/contracts/domain";

export const dynamic = "force-dynamic";

/** GET /api/v1/contacts — the consented business contacts, by escalation priority. */
export async function GET() {
  if (hasSupabaseConfig()) {
    const supabase = getSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .order("escalation_priority", { ascending: true });

      if (!error && data && data.length > 0) {
        const mapped: Contact[] = data.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          name: row.name,
          role: row.role || "Vendor",
          phoneE164: row.phone_e164,
          productCategories: row.product_categories || ["wholesale"],
          region: row.region,
          workplaceLocation: row.workplace_location || undefined,
          livingLocation: row.living_location || undefined,
          shopName: row.shop_name || undefined,
          workingHours: row.working_hours || WORKING_HOURS,
          escalationPriority: row.escalation_priority || 1,
          preferredLanguage: row.preferred_language || "en-IN",
          consentAt: row.consent_at || new Date().toISOString(),
          cooldownUntil: row.cooldown_until || null,
        }));
        return NextResponse.json({
          organizations: ORGANIZATIONS,
          contacts: mapped,
          source: "supabase",
        });
      }
    }
  }

  return NextResponse.json({
    organizations: ORGANIZATIONS,
    contacts: [...CONTACTS].sort((a, b) => a.escalationPriority - b.escalationPriority),
    source: "mock",
  });
}

/** POST /api/v1/contacts — Register a new customer/vendor contact */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, mobileNo, role, region, workplaceLocation, livingLocation, shopName } = body;

    if (!name || !mobileNo || !region || !workplaceLocation) {
      return NextResponse.json(
        { error: "Name, Mobile No., Region, and Workplace Location are required" },
        { status: 400 }
      );
    }

    let phoneE164 = mobileNo.trim();
    if (!phoneE164.startsWith("+")) {
      const cleanDigits = phoneE164.replace(/\D/g, "");
      phoneE164 = cleanDigits.length === 10 ? `+91${cleanDigits}` : `+${cleanDigits}`;
    }

    const contactId = `ct-${Date.now().toString(36)}`;
    const newContact: Contact = {
      id: contactId,
      organizationId: SELLER.id,
      name: name.trim(),
      role: role || "Vendor",
      phoneE164,
      productCategories: ["wholesale", "retail"],
      region: region.trim(),
      workplaceLocation: workplaceLocation.trim(),
      livingLocation: livingLocation?.trim() || undefined,
      shopName: shopName?.trim() || undefined,
      workingHours: WORKING_HOURS,
      escalationPriority: CONTACTS.length + 1,
      preferredLanguage: "en-IN",
      consentAt: new Date().toISOString(),
      cooldownUntil: null,
    };

    // Save to Supabase if configured
    if (hasSupabaseConfig()) {
      const supabase = getSupabaseClient();
      if (supabase) {
        await supabase.from("contacts").insert({
          id: newContact.id,
          organization_id: newContact.organizationId,
          name: newContact.name,
          role: newContact.role,
          phone_e164: newContact.phoneE164,
          product_categories: newContact.productCategories,
          region: newContact.region,
          workplace_location: newContact.workplaceLocation,
          living_location: newContact.livingLocation,
          shop_name: newContact.shopName,
          working_hours: newContact.workingHours,
          escalation_priority: newContact.escalationPriority,
          preferred_language: newContact.preferredLanguage,
          consent_at: newContact.consentAt,
        });
      }
    }

    // Always keep in mock store in memory as well
    CONTACTS.unshift(newContact);

    return NextResponse.json({ success: true, contact: newContact });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Could not add customer";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
