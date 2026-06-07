"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { bytes } from "@/lib/format";
import {
  ChevronRight,
  Folder,
  FileText,
  CornerLeftUp,
  AlertTriangle,
  Terminal,
} from "lucide-react";

type FileEntry = {
  name: string;
  type: "dir" | "file" | "link";
  size: number;
  mtime: number;
};

// shape of the slice of /api/conduit/state we care about
type StateTask = {
  id: string;
  name: string;
  mode: "dynamic" | "static";
  instances: { vmid: number; ip: string | null; status: string; name: string }[];
};
type StateGroup = { id: string; name: string; tasks: StateTask[] };

const MC_ROOT = "/opt/mc";

export default function ServiceDetailPage({
  params,
}: {
  params: Promise<{ vmid: string }>;
}) {
  const { vmid } = use(params);
  const id = Number(vmid);

  // resolve which task/group this vmid belongs to (for header + dynamic warning)
  const { data: state } = usePoll<{ groups: StateGroup[] }>(
    "/api/conduit/state",
    10_000,
  );
  const owner = useMemo(() => {
    for (const g of state?.groups ?? []) {
      for (const t of g.tasks) {
        const inst = t.instances.find((i) => i.vmid === id);
        if (inst) return { group: g, task: t, inst };
      }
    }
    return null;
  }, [state, id]);

  const isDynamic = owner?.task.mode === "dynamic";

  return (
    <>
      <PageHeader
        title={owner ? `${owner.task.name} #${id}` : `Service #${id}`}
        subtitle={
          owner
            ? `${owner.group.name} · ${owner.inst.ip ?? "…"} · ${owner.inst.status}`
            : `Live console and files for container ${id}`
        }
      />

      {isDynamic && (
        <Card className="mb-6 border-amber-400/40 bg-amber-400/5">
          <CardContent className="flex items-center gap-2 py-1 text-sm text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              This is a dynamic service — its files are NOT persistent and will be
              lost when it scales down.
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="console">
        <TabsList>
          <TabsTrigger value="console">
            <Terminal className="h-4 w-4" /> Console
          </TabsTrigger>
          <TabsTrigger value="files">
            <Folder className="h-4 w-4" /> Files
          </TabsTrigger>
        </TabsList>
        <TabsContent value="console">
          <ConsolePanel vmid={id} />
        </TabsContent>
        <TabsContent value="files">
          <FilesPanel vmid={id} />
        </TabsContent>
      </Tabs>
    </>
  );
}

/* ---- Console ------------------------------------------------------------- */

function ConsolePanel({ vmid }: { vmid: number }) {
  const { data } = usePoll<{ lines: string }>(
    `/api/services/${vmid}/console`,
    1500,
  );
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  const lines = data?.lines ?? "";

  // keep scrolled to bottom unless the user has scrolled up
  useEffect(() => {
    const el = boxRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function send() {
    const cmd = command.trim();
    if (!cmd) return;
    setSending(true);
    try {
      const res = await fetch(`/api/services/${vmid}/console`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setCommand("");
    } catch (e) {
      toast.error(`Failed to send: ${String(e)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <pre
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-[60vh] overflow-auto rounded-lg bg-black/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-emerald-200/90"
        >
          {lines || "…"}
        </pre>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Type a server command (e.g. list) and press Enter"
            className="font-mono"
            disabled={sending}
          />
          <Button type="submit" disabled={sending || !command.trim()}>
            Send
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ---- Files --------------------------------------------------------------- */

function FilesPanel({ vmid }: { vmid: number }) {
  const [path, setPath] = useState(MC_ROOT);
  const { data, error, loading } = usePoll<{ path: string; entries: FileEntry[] }>(
    `/api/services/${vmid}/files?path=${encodeURIComponent(path)}`,
    8000,
  );
  const [viewing, setViewing] = useState<string | null>(null);

  const segments = path.replace(/^\//, "").split("/"); // ["opt","mc",...]
  const parent =
    path === MC_ROOT ? null : path.slice(0, path.lastIndexOf("/")) || "/";

  function crumbPath(idx: number): string {
    return "/" + segments.slice(0, idx + 1).join("/");
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        {/* breadcrumb */}
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {segments.map((seg, i) => {
            const p = crumbPath(i);
            const inRoot = p === MC_ROOT || p.startsWith(`${MC_ROOT}/`);
            return (
              <span key={p} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                <button
                  className="rounded px-1 hover:bg-muted disabled:text-muted-foreground disabled:hover:bg-transparent"
                  disabled={!inRoot || p === path}
                  onClick={() => setPath(p)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        {error && (
          <div className="text-sm text-destructive">Could not list: {error}</div>
        )}

        <div className="overflow-hidden rounded-lg border">
          {parent && (
            <button
              className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => setPath(parent)}
            >
              <CornerLeftUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">..</span>
            </button>
          )}
          {(data?.entries ?? []).map((e) => {
            const full = `${path === "/" ? "" : path}/${e.name}`;
            const isDir = e.type === "dir";
            return (
              <button
                key={e.name}
                className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-muted"
                onClick={() => (isDir ? setPath(full) : setViewing(full))}
              >
                {isDir ? (
                  <Folder className="h-4 w-4 text-sky-400" />
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="flex-1 truncate font-medium">{e.name}</span>
                {e.type === "link" && (
                  <Badge variant="secondary" className="text-[10px]">
                    link
                  </Badge>
                )}
                {!isDir && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {bytes(e.size)}
                  </span>
                )}
              </button>
            );
          })}
          {!loading && (data?.entries?.length ?? 0) === 0 && !parent && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Empty.
            </div>
          )}
        </div>
      </CardContent>

      {viewing && (
        <FileViewer
          vmid={vmid}
          path={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </Card>
  );
}

function FileViewer({
  vmid,
  path,
  onClose,
}: {
  vmid: number;
  path: string;
  onClose: () => void;
}) {
  const { data, error, loading } = usePoll<{
    content: string;
    truncated: boolean;
    size: number;
    // huge interval → effectively load-once when the viewer opens
  }>(`/api/services/${vmid}/files?path=${encodeURIComponent(path)}&file=1`, 600_000);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm break-all">{path}</DialogTitle>
        </DialogHeader>
        {error && <div className="text-sm text-destructive">{error}</div>}
        <pre className="max-h-[65vh] overflow-auto rounded-lg bg-black/60 p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {loading ? "…" : data?.content || "(empty)"}
        </pre>
        {data?.truncated && (
          <p className="text-xs text-amber-300">
            Truncated — file is {bytes(data.size)} (showing first 256KB).
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
