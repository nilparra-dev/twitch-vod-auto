import { cn } from "@/lib/utils";

export function LogoMark({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <path
        d="M44 24 a15 15 0 1 0 3 12"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <path
        d="M44 16 v9 h-9"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M28 26 L40 32 L28 38 Z" fill="var(--accent-fg)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark size={30} />
      <span className="font-display text-[18px] font-semibold leading-none tracking-tight text-fg">
        VOD Auto
      </span>
    </div>
  );
}
