import { NextRequest, NextResponse } from "next/server";
import { getDB, mutate, slug, type Group } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = await getDB();
  return NextResponse.json({ groups: db.groups });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

    const id = slug(name);
    const group: Group = {
      id,
      name,
      slotLimit: Number(body.slotLimit ?? 500),
      maintenance: false,
      createdAt: Date.now(),
    };

    const created = await mutate((db) => {
      if (db.groups.some((g) => g.id === id)) throw new Error("group exists");
      db.groups.push(group);
      return group;
    });
    return NextResponse.json({ group: created });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
