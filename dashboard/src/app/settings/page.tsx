"use client";

import { PageHeader } from "@/components/page-header";
import { Server, Network, ShieldCheck } from "lucide-react";

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Cluster, network and panel configuration" />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <Network className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Network</h2>
          </div>
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">VIP</dt>
              <dd className="font-mono">10.27.27.50</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Velocity forwarding</dt>
              <dd className="text-emerald-400">modern · configured</dd>
            </div>
          </dl>
        </div>

        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <Server className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold">Cluster</h2>
          </div>
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Nodes</dt>
              <dd>skdCore01 · SkdCore02 · SkdCore03</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">State backend</dt>
              <dd className="font-mono text-xs">/etc/pve/conduit</dd>
            </div>
          </dl>
        </div>

        <div className="panel p-5 sm:col-span-2">
          <div className="mb-2 flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">More settings</h2>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Per-server configuration lives on each server&apos;s Settings tab under{" "}
            <span className="text-foreground">Servers</span>. Additional panel options will appear here.
          </p>
        </div>
      </div>
    </>
  );
}
