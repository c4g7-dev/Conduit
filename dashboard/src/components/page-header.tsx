"use client";

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  subtitle,
  onRefresh,
  loading,
  children,
}: {
  title: string;
  subtitle?: string;
  onRefresh?: () => void;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-center justify-between gap-4 border-b border-hairline pb-4">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold leading-tight tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {onRefresh && (
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        )}
      </div>
    </div>
  );
}
