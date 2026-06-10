/** Golden-image build status per egg (for fast clone-based autoscaling). */
import { NextResponse } from "next/server";
import { getDB } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = await getDB();
  return NextResponse.json({ images: db.images ?? [] });
}
