import { NextResponse } from "next/server";
import { isKillSwitchEngaged, setKillSwitch } from "@/lib/db/orders-repository";

export const dynamic = "force-dynamic";

/** CLAUDE.md §8.2 / §12 — global halt on outbound calling. */
export async function GET() {
  const engaged = await isKillSwitchEngaged();
  return NextResponse.json({ engaged });
}

export async function POST(request: Request) {
  let body: { engaged?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Expected a JSON body" },
      { status: 400 },
    );
  }

  const engaged = await setKillSwitch(body.engaged !== false);
  return NextResponse.json({ engaged });
}
