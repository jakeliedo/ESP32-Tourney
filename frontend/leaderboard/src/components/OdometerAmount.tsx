// Odometer-style digit reel: a vertical strip of 0-9 behind a fixed-height
// window, positioned by a CONTINUOUS float derived directly from the current
// (already continuously-interpolated, see useSmoothedPoolValue) cents value
// -- not by reacting to discrete digit changes with a one-off CSS
// transition. That discrete-trigger approach looked jerky: useSmoothedPoolValue
// feeds a new value ~60x/sec, so every animation frame was restarting a
// fresh short transition mid-flight instead of one continuous glide.
// Here there's nothing to restart -- each frame just renders
// translateY(-pos * cellHeight) for whatever `pos` the math currently gives,
// so motion is exactly as smooth as the incoming value already is.
const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]; // one loop + one extra cell for the wrap-through

// Continuous position (0..10) for the digit at `exponent` places from the
// right, in cents units (exponent 0 = ones-of-cents, 2 = ones-of-dollars,
// since 1 dollar = 100 cents -- no special jump at the decimal point,
// everything is just "how many cents" underneath).
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
        // Short linear transition as a safety net against a dropped/late
        // animation frame -- NOT the source of the roll itself (that's the
        // continuously-changing `pos` above), so it never fights or
        // restarts against its own previous state.
        transition: 'transform 80ms linear',
      }}>
        {STRIP.map((d, i) => (
          <span key={i} style={{ display: 'block', height: cellPx, lineHeight: `${cellPx}px` }}>{d}</span>
        ))}
      </span>
    </span>
  );
}

// Renders a dollar amount (given as integer-ish cents, may be a fractional
// float mid-roll) with each digit as its own continuously-positioned reel;
// '$', ',' and '.' render as plain static characters. Digit count follows
// the real formatted length of the (rounded) value -- crossing a
// power-of-10 (e.g. $999.99 -> $1,000.00) just adds a cell, no special
// entrance effect.
export function OdometerAmount({ cents, fontSizePx }: { cents: number; fontSizePx: number }) {
  const text = `$${(Math.round(cents) / 100).toLocaleString('en', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  // Walk right-to-left assigning each digit character its place-value
  // exponent in cents units; punctuation doesn't consume an exponent.
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
