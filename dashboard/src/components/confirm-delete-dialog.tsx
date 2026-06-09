"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";

/**
 * Destructive-action confirmation. The user must type the exact `confirmText` (e.g. the instance
 * name) before the confirm button enables — a deliberate guard against accidental irreversible
 * deletes. Shows an explicit warning body.
 */
export function ConfirmDeleteDialog({
  open, onOpenChange, title, confirmText, warning, onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  confirmText: string;       // the exact string the user must type
  warning: string;           // what will happen
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setTyped(""); }, [open]);
  const ok = typed.trim() === confirmText;

  async function confirm() {
    if (!ok) return;
    setBusy(true);
    try { await onConfirm(); onOpenChange(false); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><TriangleAlert className="h-4 w-4 text-red-400" /> {title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{warning}</div>
          <div>
            <p className="mb-1.5 text-[12px] text-muted-foreground">
              Type <span className="rounded bg-accent px-1 font-mono text-foreground">{confirmText}</span> to confirm:
            </p>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && ok) confirm(); }}
              placeholder={confirmText}
              className="w-full rounded-md border border-hairline bg-accent/30 px-3 py-2 font-mono text-[13px] outline-none placeholder:text-muted-foreground/40" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={confirm} disabled={!ok || busy}
              className="flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
