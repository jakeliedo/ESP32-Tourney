import { useEffect, useRef, useState } from 'react';

// Smooths a value that only changes in discrete server-pushed steps (the
// jackpot pool, broadcast every ~2s by jackpot.service.ts /
// virtual-jackpot.service.ts) into continuous per-frame motion.
//
// Naive approach (animate-on-receipt) leaves the display idle for most of
// each 2s window then bursts through the whole delta at once the instant a
// new value lands -- reads as "stutter every 2 seconds", not a smooth roll.
//
// Instead: replay the PREVIOUS observed interval's value change over the
// interval that's starting now. Display is always ~1 update cycle behind
// real time, but in exchange it's perfectly continuous, with no idle pause
// followed by a jump -- the standard client-side interpolation-with-buffer
// trick used in networked games/live dashboards. Works the same way for a
// jackpot-hit reset (value drops) as for normal growth; nothing special-
// cased, it just smoothly counts down instead of up for that one window.
export function useSmoothedPoolValue(raw: number | null): number | null {
  const [display, setDisplay] = useState<number | null>(null);
  const snapshotsRef = useRef<{ value: number; time: number }[]>([]);
  const rafRef = useRef<number | null>(null);

  // Record each new real value as it arrives, rotating [prev, curr].
  useEffect(() => {
    if (raw === null) return;
    const now = performance.now();
    const snaps = snapshotsRef.current;
    const last = snaps[snaps.length - 1];

    if (!last) {
      // First value ever -- nothing to interpolate from, show it directly.
      snapshotsRef.current = [{ value: raw, time: now }];
      setDisplay(raw);
      return;
    }
    if (raw === last.value) return;
    snapshotsRef.current = [last, { value: raw, time: now }];
  }, [raw]);

  // Continuous per-frame interpolation between the last two snapshots.
  useEffect(() => {
    const tick = () => {
      const snaps = snapshotsRef.current;
      if (snaps.length === 2) {
        const [prev, curr] = snaps;
        const span = curr.time - prev.time;
        const t = span > 0 ? Math.min(1, (performance.now() - curr.time) / span) : 1;
        setDisplay(prev.value + (curr.value - prev.value) * t);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, []);

  return display;
}
