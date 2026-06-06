"use client";

import { useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bytes, uptime } from "@/lib/format";
import { Play, Square, RotateCw, Power } from "lucide-react";

type Container = {
  vmid: number;
  name: string;
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  maxdisk: number;
  uptime: number;
  tags: string;
  pool: string;
  template: boolean;
  ip: string | null;
};

export default function ContainersPage() {
  const { data, error, loading, refresh } = usePoll<{ containers: Container[] }>(
    "/api/containers",
    4000,
  );
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  async function act(c: Container, action: "start" | "stop" | "shutdown" | "reboot") {
    setBusy((b) => ({ ...b, [c.vmid]: true }));
    try {
      const res = await fetch(`/api/containers/${c.vmid}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, node: c.node }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`${action} → ${c.name} (#${c.vmid})`);
      setTimeout(refresh, 1500);
    } catch (e) {
      toast.error(`Failed to ${action} ${c.name}: ${String(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [c.vmid]: false }));
    }
  }

  const containers = (data?.containers ?? []).filter((c) => !c.template);

  return (
    <>
      <PageHeader
        title="Containers"
        subtitle="LXC instances across the cluster — start, stop and inspect"
        onRefresh={refresh}
        loading={loading}
      />

      {error && (
        <Card className="mb-6 border-destructive/40 bg-destructive/5">
          <CardContent className="py-1 text-sm text-destructive">
            Could not reach Proxmox: {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">VMID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="text-right">Memory</TableHead>
                <TableHead className="text-right">Disk</TableHead>
                <TableHead className="text-right">Uptime</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {containers.map((c) => {
                const running = c.status === "running";
                const isBusy = busy[c.vmid];
                return (
                  <TableRow key={c.vmid}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.vmid}
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {running ? c.ip ?? "…dhcp" : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {c.tags
                          ? c.tags.split(/[;,]/).filter(Boolean).map((tg) => (
                              <Badge key={tg} variant="secondary" className="text-[10px]">
                                {tg}
                              </Badge>
                            ))
                          : <span className="text-xs text-muted-foreground">—</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {running ? bytes(c.mem) : "—"}
                      <span className="text-muted-foreground"> / {bytes(c.maxmem)}</span>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {bytes(c.maxdisk)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {running ? uptime(c.uptime) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {running ? (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              disabled={isBusy}
                              title="Reboot"
                              onClick={() => act(c, "reboot")}
                            >
                              <RotateCw className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-amber-400 hover:text-amber-300"
                              disabled={isBusy}
                              title="Shutdown (graceful)"
                              onClick={() => act(c, "shutdown")}
                            >
                              <Power className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              disabled={isBusy}
                              title="Stop (force)"
                              onClick={() => act(c, "stop")}
                            >
                              <Square className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-emerald-400 hover:text-emerald-300"
                            disabled={isBusy}
                            onClick={() => act(c, "start")}
                          >
                            <Play className="h-4 w-4" /> Start
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {containers.length === 0 && loading && (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell colSpan={9}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              )}
              {containers.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                    No containers yet.
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
