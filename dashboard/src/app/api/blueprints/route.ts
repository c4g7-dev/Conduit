import { NextResponse } from "next/server";
import { BLUEPRINTS } from "@/lib/blueprints";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ blueprints: BLUEPRINTS });
}
