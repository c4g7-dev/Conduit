/**
 * Small role indicator — a colored dot (+ optional label) instead of full-card role colors.
 * Roles stay recognizable without the rainbow borders/glows of the old design.
 */
export const ROLE_COLORS: Record<string, string> = {
  proxy: "#f6821f", // brand amber
  lobby: "#34d399", // emerald
  smp: "#38bdf8", // sky
  db: "#a78bfa", // violet
  generic: "#94a3b8", // slate
};

export function roleColor(role: string): string {
  return ROLE_COLORS[role] ?? ROLE_COLORS.generic;
}

export function RoleDot({
  role,
  label,
  className = "",
}: {
  role: string;
  label?: boolean | string;
  className?: string;
}) {
  const color = roleColor(role);
  const text = typeof label === "string" ? label : role;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: color }}
      />
      {label && (
        <span className="text-xs capitalize text-muted-foreground">{text}</span>
      )}
    </span>
  );
}
