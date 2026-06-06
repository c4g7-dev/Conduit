import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }) {
  const running = status === "running" || status === "online";
  const stopped = status === "stopped" || status === "offline";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-medium capitalize",
        running && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        stopped && "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
        !running && !stopped && "border-amber-500/30 bg-amber-500/10 text-amber-400",
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          running ? "bg-emerald-500" : stopped ? "bg-zinc-500" : "bg-amber-500",
        )}
      />
      {status}
    </Badge>
  );
}
