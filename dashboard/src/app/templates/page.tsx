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
import { bytes, pct } from "@/lib/format";
import { HardDrive, LayoutTemplate } from "lucide-react";

type Data = {
  templates: { volid: string; file: string; os: string; size: number; format: string }[];
  storage: { storage: string; type: string; content: string; avail: number; used: number; total: number }[];
};

export default function TemplatesPage() {
  const { data, loading, refresh } = usePoll<Data>("/api/templates", 15000);

  return (
    <>
      <PageHeader
        title="Templates & Storage"
        subtitle="Base images for cloning and the datastores backing them"
        onRefresh={refresh}
        loading={loading}
      />

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
