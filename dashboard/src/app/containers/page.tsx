"use client";

import { useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { bytes, uptime } from "@/lib/format";
import {
  Play, Square, RotateCw, Power, AlertCircle, Terminal, FolderOpen, Loader2,
} from "lucide-react";

type Container = {
  vmid: number; name: string; node: string; status: string;
  cpu: number; maxcpu: number; mem: number; maxmem: number; maxdisk: number;
  uptime: number; tags: string; pool: string; template: boolean; ip: string | null;
};

type Action = "start" | "stop" | "shutdown" | "reboot";

export default function ContainersPage() {
  const { data, error, loading, refresh } = usePoll<{ containers: Container[] }>(
    "/api/containers",
    4000,
  );
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  async function act(c: Container, action: Action) {
    setBusy((b) => ({ ...b, [c.vmid]: true }));
    try {
      const res = await fetch(`/api/containers/${c.vmid}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, node: c.node }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(`${action} → ${c.name} #${c.vmid}`);
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
        subtitle="All LXC instances across the cluster — start, stop, and inspect"
        onRefresh={refresh}
        loading={loading}
      />

      {error && (
        <div className="mb-5 flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Could not reach Proxmox: {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-hairline bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline">
              {["VMID", "Name", "Status", "Node", "IP", "Tags", "Memory", "Disk", "Uptime", ""].map((h, i) => (
                <th
                  key={h || i}
                  className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${i >= 6 ? "text-right" : "text-left"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => {
              const running = c.status === "running";
              const isBusy = busy[c.vmid];
              const tags = c.tags ? c.tags.split(/[;,]/).filter(Boolean) : [];
              const memPct = c.maxmem > 0 ? Math.round((c.mem / c.maxmem) * 100) : 0;

              return (
                <ContextMenu key={c.vmid}>
                  <ContextMenuTrigger
                    render={
                      <tr
                        className="group cursor-pointer border-b border-hairline transition-colors last:border-0 hover:bg-accent/40"
                        onClick={() => (window.location.href = `/services/${c.vmid}`)}
                      />
                    }
                  >
                    <td className="px-4 py-2.5"><span className="font-mono text-xs text-muted-foreground/60">#{c.vmid}</span></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                        <span className="font-medium">{c.name}</span>
                        {c.pool && <span className="rounded bg-accent px-1.5 text-[10px] text-muted-foreground">{c.pool}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={c.status} /></td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.node}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{running ? (c.ip ?? "…dhcp") : "—"}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {tags.map((tg) => (
                          <span key={tg} className="rounded bg-accent px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">{tg}</span>
                        ))}
                        {tags.length === 0 && <span className="text-xs text-muted-foreground/40">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {running ? (
                        <div>
                          <div className="text-xs tabular-nums text-muted-foreground">{bytes(c.mem)}<span className="text-muted-foreground/50"> / {bytes(c.maxmem)}</span></div>
                          <div className="ml-auto mt-1 h-1 w-20 overflow-hidden rounded-full bg-accent">
                            <div className="h-full rounded-full" style={{ width: `${memPct}%`, background: memPct > 85 ? "#f87171" : "#34d399" }} />
                          </div>
                        </div>
                      ) : <span className="text-xs text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">{bytes(c.maxdisk)}</td>
                    <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">{running ? uptime(c.uptime) : "—"}</td>
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : running ? (
                          <>
                            <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="Reboot" onClick={() => act(c, "reboot")}><RotateCw className="h-3.5 w-3.5" /></button>
                            <button className="flex h-7 w-7 items-center justify-center rounded-md text-amber-400/70 transition-colors hover:bg-amber-500/10 hover:text-amber-400" title="Shutdown (graceful)" onClick={() => act(c, "shutdown")}><Power className="h-3.5 w-3.5" /></button>
                            <button className="flex h-7 w-7 items-center justify-center rounded-md text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive" title="Stop (force)" onClick={() => act(c, "stop")}><Square className="h-3.5 w-3.5" /></button>
                          </>
                        ) : (
                          <button className="flex items-center gap-1.5 rounded-md border border-emerald-600/30 bg-emerald-600/10 px-2.5 py-1 text-xs text-emerald-400 transition-colors hover:bg-emerald-600/20" onClick={() => act(c, "start")}><Play className="h-3 w-3" /> Start</button>
                        )}
                      </div>
                    </td>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuLabel>#{c.vmid} · {c.name}</ContextMenuLabel>
                    <ContextMenuItem onClick={() => { window.location.href = `/services/${c.vmid}`; }}><Terminal /> Console</ContextMenuItem>
                    <ContextMenuItem onClick={() => { window.location.href = `/services/${c.vmid}?tab=files`; }}><FolderOpen /> Files</ContextMenuItem>
                    <ContextMenuSeparator />
                    {running ? (
                      <>
                        <ContextMenuItem onClick={() => act(c, "reboot")}><RotateCw /> Reboot</ContextMenuItem>
                        <ContextMenuItem onClick={() => act(c, "shutdown")}><Power /> Shutdown</ContextMenuItem>
                        <ContextMenuItem variant="destructive" onClick={() => act(c, "stop")}><Square /> Force stop</ContextMenuItem>
                      </>
                    ) : (
                      <ContextMenuItem onClick={() => act(c, "start")}><Play /> Start</ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {containers.length === 0 && loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-hairline">
                  <td colSpan={10} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                </tr>
              ))}
            {containers.length === 0 && !loading && (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-muted-foreground">No containers found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
