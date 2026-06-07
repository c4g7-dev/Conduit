"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { bytes } from "@/lib/format";
import { Upload, Trash2, Globe, Plug, FileCog } from "lucide-react";

type Asset = { kind: string; name: string; path: string; size: number; ref: string };
const ICON: Record<string, React.ElementType> = { worlds: Globe, plugins: Plug, configs: FileCog };

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
    if (!confirm(`Delete asset ${a.name}?`)) return;
    await fetch(`/api/assets?path=${encodeURIComponent(a.kind + "/" + a.name)}`, { method: "DELETE" });
    toast.success("Asset deleted");
    refresh();
  }

  return (
    <Card className="mb-8">
      <CardContent className="space-y-3 py-1">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Kind</label>
            <Select value={kind} onValueChange={(v) => setKind(v ?? "worlds")}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="worlds">world (.tar.gz)</SelectItem>
                <SelectItem value="plugins">plugin (.jar)</SelectItem>
                <SelectItem value="configs">config</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload className="h-4 w-4" /> {busy ? "Uploading…" : "Upload asset"}
          </Button>
          <span className="text-xs text-muted-foreground">Stored on the node; pushed into servers that reference it.</span>
        </div>

        <div className="divide-y divide-border/50">
          {assets.map((a) => {
            const Icon = ICON[a.kind] ?? FileCog;
            return (
              <div key={a.ref} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{a.name}</span>
                  <Badge variant="secondary" className="text-[10px]">{a.kind}</Badge>
                  <span className="text-xs text-muted-foreground">{bytes(a.size)}</span>
                </span>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => del(a)} title="Delete asset">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
          {assets.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">
              No uploaded assets yet. Upload a world (.tar.gz of a level dir) or plugin (.jar).
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
