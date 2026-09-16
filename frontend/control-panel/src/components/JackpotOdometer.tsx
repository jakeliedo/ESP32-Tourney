// Odometer-style digit reel -- see leaderboard/src/components/OdometerAmount.tsx
// for the full rationale (kept duplicated, two independent frontend apps).
// Position is a CONTINUOUS function of the current cents value (itself
// already continuously interpolated by useSmoothedPoolValue), not a
// discrete transition triggered on digit change -- that approach fought
// itself when fed ~60 updates/sec and looked jerky instead of smooth.
const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]; // one loop + one extra cell for the wrap-through

function digitPosition(cents: number, exponent: number): number {
  const scaled = cents / Math.pow(10, exponent);
  const mod = scaled % 10;
  return mod < 0 ? mod + 10 : mod;
}

function DigitReel({ cents, exponent, cellPx }: { cents: number; exponent: number; cellPx: number }) {
  const pos = digitPosition(cents, exponent);
  return (
    <span style={{ display: 'inline-block', overflow: 'hidden', height: cellPx, verticalAlign: 'top' }}>
      <span style={{
        display: 'block',
        transform: `translateY(${-pos * cellPx}px)`,
        transition: 'transform 80ms linear',
      }}>
        {STRIP.map((d, i) => (
          <span key={i} style={{ display: 'block', height: cellPx, lineHeight: `${cellPx}px` }}>{d}</span>
        ))}
      </span>
    </span>
  );
}

function OdometerAmount({ cents, fontSizePx }: { cents: number; fontSizePx: number }) {
  const text = `$${(Math.round(cents) / 100).toLocaleString('en', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  const exponents: (number | null)[] = new Array(text.length).fill(null);
  let exp = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] >= '0' && text[i] <= '9') exponents[i] = exp++;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline' }}>
      {text.split('').map((ch, i) =>
        exponents[i] !== null
          ? <DigitReel key={i} cents={cents} exponent={exponents[i]!} cellPx={fontSizePx} />
          : <span key={i} style={{ display: 'inline-block' }}>{ch}</span>,
      )}
    </span>
  );
}

// Compact header readout: "JACKPOT  $1,234.56", styled to sit inline with
// the "SLOT TOURNAMENT" title on the opposite side of the same header row.
export function JackpotOdometer({ pool }: { pool: number | null }) {
  if (pool === null) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 8,
      fontFamily: 'Georgia, serif',
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '.18em',
        color: 'var(--text-3)', textTransform: 'uppercase',
      }}>
        Jackpot
      </span>
      <span style={{
        fontSize: 16, fontWeight: 700, color: 'var(--gold)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1,
      }}>
        <OdometerAmount cents={pool} fontSizePx={16} />
      </span>
    </div>
  );
}
