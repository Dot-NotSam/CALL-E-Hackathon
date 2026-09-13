import { NextResponse } from "next/server";
import { getSupabaseClient, hasSupabaseConfig } from "@/lib/db/supabase-client";

export const dynamic = "force-dynamic";

/** GET /api/v1/profile */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "User ID required" }, { status: 400 });
  }

  if (hasSupabaseConfig()) {
    const supabase = getSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

      if (!error && data) {
        return NextResponse.json({ profile: data });
      }
    }
  }

  return NextResponse.json({
    profile: {
      id: userId,
      full_name: "Ramesh Northgate",
      email: "wholesaler@northgate.com",
      phone: "+91 9876543210",
      age: 42,
      location: "Mumbai West, MIDC Industrial Area",
      wholesaler_name: "Northgate Wholesale Distributors Pvt Ltd",
      avatar_url: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
    },
  });
}

/** PUT /api/v1/profile — Update Wholesaler Profile */
export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const { userId, fullName, phone, age, location, wholesalerName, avatarUrl } = body;

    if (hasSupabaseConfig()) {
      const supabase = getSupabaseClient();
      if (supabase && userId) {
        await supabase.from("profiles").upsert({
          id: userId,
          full_name: fullName,
          phone,
          age: age ? Number(age) : undefined,
          location,
          wholesaler_name: wholesalerName,
          avatar_url: avatarUrl,
        });

        if (wholesalerName) {
          await supabase.from("organizations").upsert({
            id: "org-northgate",
            name: wholesalerName,
            role: "WHOLESALER",
          });
        }
      }
    }

    return NextResponse.json({ success: true, updated: body });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Could not update profile";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
