import { cn } from "@/lib/utils";

/**
 * The Sentinel Ops mark: five bars of a voice waveform, then the wordmark.
 * The waveform says "phone call" before the name is read.
 */
export function BrandMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-ink", className)}>
      <svg viewBox="0 0 18 16" className="h-4 w-[18px] shrink-0" aria-hidden>
        {[
          [1, 5, 6],
          [5, 2, 12],
          [9, 0, 16],
          [13, 3, 10],
          [17, 6, 4],
        ].map(([x, y, h]) => (
          <rect key={x} x={x - 1} y={y} width="2" height={h} rx="1" fill="currentColor" />
        ))}
      </svg>
      {!compact && (
        <span className="whitespace-nowrap text-base font-semibold tracking-tight flex items-center gap-1.5">
          Market Buddy
          <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
            Voice
          </span>
        </span>
      )}
    </span>
  );
}
