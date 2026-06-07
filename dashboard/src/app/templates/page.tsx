"use client";

import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { NewTemplateDialog } from "@/components/new-template-dialog";
import { bytes, pct } from "@/lib/format";
import { HardDrive, LayoutTemplate, Boxes, Trash2, Cpu, MemoryStick } from "lucide-react";

type Blueprint = {
  id: string; name: string; role: string; mode: string; cores: number; memory: number;
  disk: number; port: number; description: string; software: { kind: string; version: string };
};
type Data = {
  templates: { volid: string; file: string; os: string; size: number; format: string }[];
  storage: { storage: string; type: string; content: string; avail: number; used: number; total: number }[];
};
type Bps = { blueprints: Blueprint[]; builtin: string[] };

export default function TemplatesPage() {
  const { data, loading, refresh } = usePoll<Data>("/api/templates", 15000);
  const { data: bps, refresh: refreshBps } = usePoll<Bps>("/api/blueprints", 15000);
  const builtin = new Set(bps?.builtin ?? []);

  async function delTemplate(id: string) {
    if (!confirm(`Delete template "${id}"?`)) return;
    const res = await fetch(`/api/blueprints/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (json.error) return toast.error(json.error);
    toast.success("Template deleted");
    refreshBps();
  }

  return (
    <>
      <PageHeader
        title="Templates & Storage"
        subtitle="Server templates, base images, and the datastores backing them"
        onRefresh={() => { refresh(); refreshBps(); }}
        loading={loading}
      >
        <NewTemplateDialog onCreated={refreshBps} />
      </PageHeader>

      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Boxes className="h-4 w-4" /> Server templates
      </h2>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(bps?.blueprints ?? []).map((b) => (
          <Card key={b.id}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <div>
                <CardTitle className="text-base">{b.name}</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {b.role} · {b.software.kind} {b.software.version}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Badge variant="outline" className={b.mode === "dynamic" ? "border-orange-500/30 bg-orange-500/10 text-orange-400" : "border-sky-500/30 bg-sky-500/10 text-sky-400"}>
                  {b.mode}
                </Badge>
                {builtin.has(b.id) ? (
                  <Badge variant="secondary" className="text-[10px]">built-in</Badge>
                ) : (
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => delTemplate(b.id)} title="Delete template">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="line-clamp-2 text-xs text-muted-foreground">{b.description}</p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Cpu className="h-3 w-3" />{b.cores}c</span>
                <span className="flex items-center gap-1"><MemoryStick className="h-3 w-3" />{b.memory}MB</span>
                <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" />{b.disk}GB</span>
                <span>:{b.port}</span>
              </div>
            </CardContent>
          </Card>
        ))}
        {!bps && <Skeleton className="h-28 w-full rounded-xl" />}
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Storage
      </h2>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {!data &&
          loading &&
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={`sk-${i}`}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-2 w-full" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        {data?.storage.map((s) => (
          <Card key={s.storage}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                {s.storage}
              </CardTitle>
              <Badge variant="secondary">{s.type}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {s.total > 0 && <Progress value={pct(s.used, s.total)} />}
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{bytes(s.avail)} free</span>
                <span>{s.total > 0 ? bytes(s.total) : "—"} total</span>
              </div>
              <div className="text-[11px] text-muted-foreground">{s.content}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        LXC Templates
      </h2>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Image</TableHead>
                <TableHead>OS</TableHead>
                <TableHead>Format</TableHead>
                <TableHead className="text-right">Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.templates.map((t) => (
                <TableRow key={t.volid}>
                  <TableCell className="flex items-center gap-2 font-medium">
                    <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                    {t.file}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{t.os}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.format || (t.file.endsWith(".zst") ? "tar.zst" : "tar.gz")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                    {bytes(t.size)}
                  </TableCell>
                </TableRow>
              ))}
              {!data &&
                loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell colSpan={4}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {data && data.templates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                    No templates downloaded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
