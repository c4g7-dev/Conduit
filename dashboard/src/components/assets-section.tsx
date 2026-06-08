"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { bytes } from "@/lib/format";
import { Upload, Trash2, Globe, Plug, FileCog } from "lucide-react";

type Asset = { kind: string; name: string; path: string; size: number; ref: string };

const ICON: Record<string, React.ElementType> = {
  worlds: Globe,
  plugins: Plug,
  configs: FileCog,
};

const KIND_COLOR: Record<string, string> = {
  worlds: "#34d399",
  plugins: "#a78bfa",
  configs: "#38bdf8",
};

export function AssetsSection() {
  const { data, refresh } = usePoll<{ assets: Asset[] }>("/api/assets", 15000);
  const [kind, setKind] = useState("worlds");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const assets = data?.assets ?? [];

  async function upload(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const res = await fetch("/api/assets", { method: "POST", body: fd });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`Uploaded ${file.name}`);
      refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function del(a: Asset) {
    if (!confirm(`Delete asset "${a.name}"?`)) return;
    await fetch(`/api/assets?path=${encodeURIComponent(a.kind + "/" + a.name)}`, { method: "DELETE" });
    toast.success("Asset deleted");
    refresh();
  }

  const filtered = assets.filter((a) => a.kind === kind);
  const color = KIND_COLOR[kind] ?? "#94a3b8";

  return (
    <div className="mb-8 overflow-hidden rounded-xl border border-white/[0.07] bg-panel">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div className="flex rounded-lg border border-white/[0.08] overflow-hidden">
          {(["worlds", "plugins", "configs"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                kind === k
                  ? "bg-white/[0.08] text-white"
                  : "text-white/30 hover:text-white/60"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
        >
          <Upload className="h-3.5 w-3.5" />
          {busy ? "Uploading…" : "Upload asset"}
        </button>
        <span className="text-[11px] text-white/25">
          Stored on the node; pushed into servers that reference it.
        </span>
      </div>

      {/* Asset list */}
      <div className="divide-y divide-white/[0.04]">
        {filtered.map((a) => {
          const Icon = ICON[a.kind] ?? FileCog;
          return (
            <div
              key={a.ref}
              className="flex items-center justify-between px-4 py-2.5 transition-colors hover:bg-white/[0.02]"
            >
              <span className="flex items-center gap-3">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-md"
                  style={{ background: `color-mix(in oklch, ${color} 12%, transparent)` }}
                >
                  <Icon className="h-3.5 w-3.5" style={{ color }} />
                </div>
                <span className="font-mono text-sm text-white/70">{a.name}</span>
                <span className="font-mono text-[11px] text-white/25">{bytes(a.size)}</span>
              </span>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-red-400/40 transition-colors hover:bg-red-500/10 hover:text-red-400"
                onClick={() => del(a)}
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-white/25">
            No {kind} uploaded yet.
            {kind === "worlds" && " Upload a .tar.gz of a level directory."}
            {kind === "plugins" && " Upload a .jar plugin file."}
          </div>
        )}
      </div>
    </div>
  );
}
