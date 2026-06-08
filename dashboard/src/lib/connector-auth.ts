/** Shared token guard for connector ingest endpoints (plugins authenticate with this). */
import { NextRequest } from "next/server";

const TOKEN = process.env.CONDUIT_CONNECTOR_TOKEN || process.env.CONDUIT_AGENT_TOKEN || "";

export function connectorAuthed(req: NextRequest): boolean {
  if (!TOKEN) return false;
  const h = req.headers.get("authorization");
  return h === `Bearer ${TOKEN}`;
}
