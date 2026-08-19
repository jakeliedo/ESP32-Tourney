import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

interface RankEntry    { machineId: string; score: number; rank: number; }
interface JackpotAlert { machineId: string; amount: number; }
interface Machine      { machine_id: string; display_name: string; status: string; credits: number; coin_in?: number; }
interface Tournament   {
  id: number; status: string;
  started_at?: string; duration_seconds?: number;
  round_number?: number; total_rounds?: number;
}
interface RoundInfo    { roundNumber: number; totalRounds: number; }

const ROWS = 10;
// Gold · Silver · Bronze
const MEDALS = ['#FFD060', '#C0C8D0', '#D4904A'];

// Electron preload exposes window.__config__; browser/Vite-dev falls back to ''
const backendUrl: string = (window as any).__config__?.backendUrl      ?? '';
const bgImageUrl: string = (window as any).__config__?.backgroundImage ?? './bg.jpg';

// ─── LAYOUT — pixel grid for 1920 × 1080 fullscreen ─────────────────────────
// All px values measured directly on the 1920×1080 canvas.
// To relocate columns, edit COL_* constants only.

// Row grid: top edge of row i = Math.round(y0 + pitch * i)
const ROW = { y0: 433.11, pitch: 45.6328, h: 38 } as const;

// Exact column positions (px)
const COL_NAME = { x: 762,  w: 307 } as const;   // PLAYER NAME
const COL_WIN  = { x: 1095, w: 237 } as const;   // TOTAL WINNINGS
// No rank-number overlay — background image already has rank graphics for all 10 rows.

// Timer circle (unchanged — top-right of bg.jpg)
const TIMER = { right: '2.8%', top: '4.7%', size: '9.2vw' } as const;

// Row top in px
const rowTopPx = (i: number) => Math.round(ROW.y0 + ROW.pitch * i);

function fmt(sec: number) {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── CSS keyframe injected once ───────────────────────────────────────────────
const STYLE_ID = 'lb-keyframes';
if (!document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    @keyframes timerPulse {
      0%,100% { opacity: 1; }
      50%      { opacity: .55; }
    }
    @keyframes rowFadeIn {
      from { opacity: 0; transform: translateX(-8px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes jpGlow {
      0%,100% { box-shadow: 0 0 60px rgba(200,168,75,.25); }
      50%      { box-shadow: 0 0 120px rgba(200,168,75,.55); }
    }
    @keyframes vjpPanelGlow {
      0%,100% {
        box-shadow:
          0 0 18px rgba(0,180,255,.30),
          0 0 40px rgba(0,180,255,.14),
          inset 0 0 18px rgba(0,180,255,.06);
      }
      50% {
        box-shadow:
          0 0 32px rgba(0,200,255,.55),
          0 0 70px rgba(0,180,255,.28),
          inset 0 0 28px rgba(0,180,255,.10);
      }
    }
    @keyframes vjpAmountShimmer {
      0%,100% { filter: drop-shadow(0 0 6px rgba(0,210,255,.60)); }
      50%      { filter: drop-shadow(0 0 14px rgba(0,230,255,.95)); }
    }
    @keyframes vjpTitlePulse {
      0%,100% { opacity: .85; }
      50%      { opacity: 1; }
    }
  `;
  document.head.appendChild(el);
}

// ─────────────────────────────────────────────────────────────────────────────

export default function Leaderboard() {
  const [rankings, setRankings]   = useState<RankEntry[]>([]);
  const [jackpot,  setJackpot]    = useState<JackpotAlert | null>(null);
  const [tournId,  setTournId]    = useState<number | null>(null);
  const [flash,    setFlash]      = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState<Machine[]>([]);
  const [nameMap,  setNameMap]    = useState<Record<string, string>>({});
  const [roundInfo,setRoundInfo]  = useState<RoundInfo | null>(null);
  const [tournamentRunning, setTournamentRunning] = useState(false);
  const [timeLeft, setTimeLeft]   = useState<number | null>(null);
  // Duration shown before tournament starts (from SCHEDULED tournament)
  const [standbyTime, setStandbyTime] = useState<number | null>(null);
  // Virtual jackpot pool — updated by jackpot_pool_update socket event
  const [vjpPool, setVjpPool]         = useState<number | null>(null);
  const [jackpotVideoUrl, setJackpotVideoUrl] = useState<string | null>(null);

  const endTimeRef           = useRef<number | null>(null);
  const prevScores           = useRef<Record<string, number>>({});
  const tournIdRef           = useRef<number | null>(null);
  const lastRestTournIdRef   = useRef<number | null>(null);
  const jackpotTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jackpotVideoRef      = useRef<HTMLVideoElement>(null);

  // ── Fetch jackpot video URL on mount ─────────────────────────────────────
  useEffect(() => {
    fetch(`${backendUrl}/api/jackpot/virtual/video-url`)
      .then(r => r.json())
      .then((d: { url: string | null }) => { if (d.url) setJackpotVideoUrl(backendUrl + d.url); })
      .catch(() => {});
  }, []);

  // ── Poll /api/machines every 2 s ─────────────────────────────────────────
  useEffect(() => {
    const load = () =>
      fetch(`${backendUrl}/api/machines`)
        .then(r => r.json())
        .then((list: Machine[]) => {
          setConnected(list.filter(m => m.status.toLowerCase() !== 'offline'));
          const map: Record<string, string> = {};
          list.forEach(m => { if (m.display_name) map[m.machine_id] = m.display_name; });
          setNameMap(map);
        }).catch(() => {});
    load();
    const iv = setInterval(load, 2000);
    return () => clearInterval(iv);
  }, []);

  // ── Poll /api/tournaments — init timer, standby duration & ranking fallback
  useEffect(() => {
    const load = () =>
      fetch(`${backendUrl}/api/tournaments`)
        .then(r => r.json())
        .then((list: Tournament[]) => {
          const active = list
            .filter(t => t.status === 'active')
            .sort((a, b) => b.id - a.id)[0];

          if (active) {
            // Initialize countdown if WebSocket hasn't synced yet
            if (endTimeRef.current === null && active.started_at && active.duration_seconds) {
              const endsAt = new Date(active.started_at).getTime() + active.duration_seconds * 1000;
              if (endsAt > Date.now()) { endTimeRef.current = endsAt; setTournamentRunning(true); }
            }
            setStandbyTime(null);

            // Fallback: if Socket.IO hasn't delivered rankings for this tournament yet,
            // fetch them via REST so the table isn't empty after reconnects or late opens.
            if (active.id !== lastRestTournIdRef.current) {
              lastRestTournIdRef.current = active.id;
              if (active.id !== tournIdRef.current) {
                fetch(`${backendUrl}/api/tournaments/${active.id}/leaderboard`)
                  .then(r => r.json())
                  .then((data: { machineId: string; score: number }[]) => {
                    if (data.length > 0 && tournIdRef.current !== active.id) {
                      const ranked = data.map((r, i) => ({ ...r, rank: i + 1 }));
                      setRankings(ranked);
                      setTournId(active.id);
                      tournIdRef.current = active.id;
                      if (active.round_number) {
                        setRoundInfo({ roundNumber: active.round_number, totalRounds: active.total_rounds ?? 1 });
                      }
                    }
                  }).catch(() => {});
              }
            }
          } else {
            if (endTimeRef.current !== null) {
              // Socket missed the end event — clear
              endTimeRef.current = null; setTimeLeft(null); setTournamentRunning(false);
            }
            lastRestTournIdRef.current = null;
            // Show scheduled tournament's duration in the timer circle
            const scheduled = list
              .filter(t => t.status === 'scheduled')
              .sort((a, b) => b.id - a.id)[0];
            setStandbyTime(scheduled?.duration_seconds ?? null);
          }
        }).catch(() => {});
    load();
    const iv = setInterval(load, 2000);
    return () => clearInterval(iv);
  }, []);

  // ── Countdown tick ────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = setInterval(() => {
      if (endTimeRef.current !== null)
        setTimeLeft(Math.max(0, Math.floor((endTimeRef.current - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  // ── Socket.IO handlers ────────────────────────────────────────────────────
  const onLeaderboard = useCallback((data: any) => {
    const newId: number | undefined = data.tournamentId;
    if (newId && newId !== tournIdRef.current) {
      // New tournament — reset score tracking
      prevScores.current = {};
      tournIdRef.current = newId;
    }
    if (newId) setTournId(newId);
    if (data.roundNumber) setRoundInfo({ roundNumber: data.roundNumber, totalRounds: data.totalRounds ?? 1 });

    if (data.endsAt > 0) {
      setTournamentRunning(true);
      setStandbyTime(null);
      if (data.endsAt > Date.now()) endTimeRef.current = data.endsAt;
    } else if (data.endsAt === 0) {
      // Tournament ended — stop the timer but KEEP rankings visible until a new
      // tournament arrives (no 10-second auto-clear).
      endTimeRef.current = null; setTimeLeft(null); setTournamentRunning(false);
    }

    const ranked: RankEntry[] = (data.rankings ?? []).map((r: any, i: number) => ({ ...r, rank: i + 1 }));

    const changed = new Set<string>();
    ranked.forEach(r => {
      if (prevScores.current[r.machineId] !== undefined && prevScores.current[r.machineId] !== r.score)
        changed.add(r.machineId);
      prevScores.current[r.machineId] = r.score;
    });
    if (changed.size) { setFlash(changed); setTimeout(() => setFlash(new Set()), 700); }
    // During an active tournament always apply rankings (even empty = all machines offline).
    // When tournament is finished (endsAt=0), only update if non-empty so final results persist.
    if (data.endsAt > 0 || ranked.length > 0) setRankings(ranked);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJackpotHit = useCallback((data: any) => {
    if (data.videoUrl) setJackpotVideoUrl(backendUrl + data.videoUrl);
    if (jackpotTimerRef.current) clearTimeout(jackpotTimerRef.current);
    setJackpot({ machineId: data.machineId, amount: data.amount });
    jackpotTimerRef.current = setTimeout(() => {
      setJackpot(null);
      jackpotTimerRef.current = null;
    }, 6500);
  }, []);

  const handleJackpotVideoEnded = useCallback(() => {
    if (jackpotTimerRef.current) { clearTimeout(jackpotTimerRef.current); jackpotTimerRef.current = null; }
    setJackpot(null);
  }, []);

  // Auto-play video when jackpot fires
  useEffect(() => {
    if (jackpot && jackpotVideoRef.current) {
      jackpotVideoRef.current.currentTime = 0;
      jackpotVideoRef.current.play().catch(() => {});
    }
  }, [jackpot]);

  const onMachineUpdate = useCallback((data: any) => {
    setConnected(prev => {
      const idx = prev.findIndex(m => m.machine_id === data.machineId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], credits: data.credits, coin_in: data.coin_in };
      return next;
    });
  }, []);

  const onJackpotPool = useCallback((data: any) => {
    if (typeof data.pool === 'number') setVjpPool(data.pool);
  }, []);

  useWebSocket(onLeaderboard, onJackpotHit, onMachineUpdate, onJackpotPool);

  // ── Build display rows ────────────────────────────────────────────────────
  const preTournRanks: RankEntry[] = [...connected]
    .sort((a, b) => (b.credits - a.credits) || a.machine_id.localeCompare(b.machine_id))
    .map((m, i) => ({ machineId: m.machine_id, score: m.credits, rank: i + 1 }));

  // Source priority:
  //   1. No machines connected  → always empty (clear stale data)
  //   2. Tournament running     → tournament scores from Redis (empty = all offline mid-tournament)
  //   3. Machines online, idle  → current machine credits (pre-tournament view)
  const sourceRows: RankEntry[] = connected.length === 0
    ? []
    : tournamentRunning
      ? rankings
      : preTournRanks;

  const displayRows: (RankEntry | null)[] = Array.from({ length: ROWS }, (_, i) => sourceRows[i] ?? null);
  const name = (mid: string) => nameMap[mid] || mid;

  // Timer display value (priority: active countdown > standby configured duration)
  const timerSec = timeLeft !== null ? timeLeft : standbyTime;
  const timerStr = timerSec !== null ? fmt(timerSec) : '--:--';
  const timerUrgent = tournamentRunning && timeLeft !== null && timeLeft <= 10;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        width: '100vw', height: '100vh',
        position: 'relative', overflow: 'hidden',
        background: '#1a0606',
        backgroundImage: `url('${bgImageUrl}')`,
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
        backgroundRepeat: 'no-repeat',
        fontFamily: "'Georgia', serif",
        cursor: 'none',
      }}
      onDoubleClick={() => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.();
        } else {
          document.exitFullscreen?.();
        }
      }}
    >

      {/* ── TIMER CIRCLE — top-right black circle in image ──────────────── */}
      <div style={{
        position: 'absolute',
        right:  TIMER.right,
        top:    TIMER.top,
        width:  TIMER.size,
        height: TIMER.size,
        borderRadius: '50%',
        background: 'rgba(4,0,0,0.82)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        zIndex: 20,
        animation: timerUrgent ? 'timerPulse 0.9s ease-in-out infinite' : 'none',
      }}>
        <span style={{
          fontSize: '0.62vw',
          color: timerUrgent ? '#ff6060' : tournamentRunning ? '#c8a84b' : '#888',
          letterSpacing: '0.18em',
          fontFamily: "'Consolas', monospace",
          fontWeight: 700,
          marginBottom: '0.5vw',
          textTransform: 'uppercase',
        }}>
          {tournamentRunning ? 'TIME LEFT' : standbyTime ? 'READY' : 'STANDBY'}
        </span>
        <span style={{
          fontFamily: "'Georgia', serif",
          fontSize: '2.3vw',
          fontWeight: 700,
          color: timerUrgent ? '#ff4040' : '#ffffff',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          textShadow: timerUrgent
            ? '0 0 1.5vw rgba(255,60,60,0.7)'
            : tournamentRunning
              ? '0 0 1.2vw rgba(255,255,255,0.4)'
              : 'none',
          letterSpacing: '0.04em',
          transition: 'color 0.5s, text-shadow 0.5s',
        }}>
          {timerStr}
        </span>
      </div>

      {/* ── VIRTUAL JACKPOT PANEL — top-LEFT, mirrors timer circle ────────
           Positioned symmetrically: left:2.8%, same top/size as timer.
           Uses text-shadow glow (no WebkitTextFillColor) for reliable rendering. */}
      {tournamentRunning && vjpPool !== null && (
        <div style={{
          position: 'absolute',
          left:   TIMER.right,   // '2.8%' — symmetric axis with timer on right
          top:    TIMER.top,     // '4.7%' — same vertical origin
          width:  TIMER.size,    // '9.2vw' — exact same diameter
          height: TIMER.size,    // '9.2vw' — circle
          borderRadius: '50%',
          background: 'rgba(0,5,20,0.84)',
          border: '1px solid rgba(0,180,255,0.42)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          zIndex: 20,
          animation: 'vjpPanelGlow 2.8s ease-in-out infinite',
        }}>
          {/* Label — mirrors "TIME LEFT" label style in timer */}
          <span style={{
            fontSize: '0.62vw',
            color: '#00c8ff',
            letterSpacing: '0.18em',
            fontFamily: "'Consolas', monospace",
            fontWeight: 700,
            marginBottom: '0.5vw',
            textTransform: 'uppercase',
            textShadow: '0 0 8px rgba(0,200,255,0.75)',
            animation: 'vjpTitlePulse 2s ease-in-out infinite',
          }}>
            JACKPOT
          </span>

          {/* Amount — mirrors timer digit style, neon blue glow */}
          <span style={{
            fontFamily: "'Georgia', serif",
            fontSize: '1.55vw',
            fontWeight: 700,
            color: '#cce8ff',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
            textShadow: '0 0 1.2vw rgba(0,200,255,0.85), 0 0 0.4vw rgba(140,220,255,0.65)',
            letterSpacing: '0.04em',
            transition: 'color 0.4s, text-shadow 0.4s',
            animation: 'vjpAmountShimmer 2.2s ease-in-out infinite',
            whiteSpace: 'nowrap',
          }}>
            {`$${(vjpPool / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          </span>
        </div>
      )}

      {/* ── TOURNAMENT INFO BADGE — small, bottom-left ───────────────────── */}
      {(tournId || roundInfo) && (
        <div style={{
          position: 'absolute',
          bottom: '3%', left: '3%',
          fontSize: '0.7vw',
          color: 'rgba(200,168,75,0.55)',
          letterSpacing: '0.22em',
          fontFamily: "'Consolas', monospace",
          textShadow: '0 0 10px rgba(200,168,75,0.2)',
          zIndex: 10,
        }}>
          {tournId ? `TOURNAMENT #${tournId}` : ''}
          {roundInfo ? ` · ROUND ${roundInfo.roundNumber}/${roundInfo.totalRounds}` : ''}
          {roundInfo && roundInfo.roundNumber === roundInfo.totalRounds && roundInfo.totalRounds > 1
            ? ' · FINAL ROUND' : ''}
        </div>
      )}

      {/* ── LIVE STATUS — bottom-right corner ───────────────────────────── */}
      <div style={{
        position: 'absolute',
        bottom: '3%', right: '3%',
        display: 'flex', alignItems: 'center', gap: '0.5vw',
        fontSize: '0.65vw', fontWeight: 700, letterSpacing: '0.2em',
        color: tournamentRunning ? 'rgba(58,170,96,0.8)' : 'rgba(128,128,128,0.5)',
        fontFamily: "'Consolas', monospace",
        zIndex: 10,
      }}>
        <span style={{
          width: '0.6vw', height: '0.6vw', borderRadius: '50%', display: 'inline-block',
          background: tournamentRunning ? '#3aaa60' : connected.length > 0 ? '#c8a84b' : '#444',
          boxShadow: tournamentRunning ? '0 0 0.5vw #3aaa60' : 'none',
        }} />
        {tournamentRunning ? 'LIVE' : connected.length > 0 ? 'STANDBY' : 'IDLE'}
      </div>

      {/* ── RANKINGS TABLE OVERLAY ────────────────────────────────────────────
           Rows are positioned using the exact pixel formula:
             top = Math.round(ROW.y0 + ROW.pitch * i)
           Columns are absolute within each row container.
           Edit COL_NAME / COL_WIN / ROW at the top of this file. ── */}
      {displayRows.map((entry, i) => {
        const rank       = i + 1;
        const medalColor = rank <= 3 ? MEDALS[rank - 1] : null;
        const empty      = !entry;
        const isFlash    = entry ? flash.has(entry.machineId) : false;
        const isTop      = !empty && rank <= 3;
        const rowBg      = empty
          ? 'transparent'
          : isTop
            ? `${medalColor}1a`
            : i % 2 === 0 ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.10)';

        return (
          <div
            key={rank}
            style={{
              position: 'absolute',
              left: COL_NAME.x, width: COL_WIN.x + COL_WIN.w - COL_NAME.x,
              top: rowTopPx(i), height: ROW.h,
              background: rowBg,
              transition: 'background 0.3s',
              animation: !empty ? 'rowFadeIn 0.4s ease both' : 'none',
              animationDelay: `${i * 35}ms`,
              zIndex: 5,
            }}
          >
            {/* ── PLAYER NAME ── */}
            <div style={{
              position: 'absolute',
              left: 0, width: COL_NAME.w,
              top: 0, height: '100%',
              display: 'flex', alignItems: 'center',
              overflow: 'hidden',
            }}>
              {!empty && (
                <span style={{
                  fontFamily: 'Georgia, serif',
                  fontSize: isTop ? 26 : 22, fontWeight: isTop ? 700 : 500,
                  color: isTop ? '#fff8e8' : 'rgba(230,210,160,0.75)',
                  textShadow: isTop ? '0 1px 4px rgba(0,0,0,0.9)' : '0 1px 2px rgba(0,0,0,0.7)',
                  letterSpacing: isTop ? '0.06em' : '0.03em',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  width: '100%',
                  transition: 'color 0.3s',
                }}>
                  {name(entry.machineId)}
                </span>
              )}
            </div>

            {/* ── TOTAL WINNINGS ── */}
            <div style={{
              position: 'absolute',
              left: COL_WIN.x - COL_NAME.x, width: COL_WIN.w,
              top: 0, height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            }}>
              {!empty && (
                <span style={{
                  fontFamily: 'Georgia, serif',
                  fontSize: isTop ? 32 : 26, fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  color: isFlash
                    ? '#ffe878'
                    : isTop ? medalColor! : 'rgba(200,168,75,0.65)',
                  textShadow: isTop
                    ? `0 0 24px ${medalColor}70, 0 1px 3px rgba(0,0,0,0.9)`
                    : '0 1px 2px rgba(0,0,0,0.7)',
                  transition: 'color 0.5s ease',
                }}>
                  {`$${(entry.score / 100).toFixed(2)}`}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {/* ── JACKPOT OVERLAY ──────────────────────────────────────────────── */}
      {jackpot && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(4,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 99,
        }}>
          <div style={{
            border: '1px solid rgba(200,168,75,0.4)',
            borderRadius: 12,
            padding: jackpotVideoUrl ? '2vw 3vw 3vw' : '4vw 6vw',
            textAlign: 'center',
            background: 'radial-gradient(ellipse at center, #1a0f00 0%, #08060a 70%)',
            animation: 'jpGlow 1.6s ease-in-out infinite',
            width: jackpotVideoUrl ? '42vw' : undefined,
          }}>
            {jackpotVideoUrl && (
              <video
                ref={jackpotVideoRef}
                src={jackpotVideoUrl}
                onEnded={handleJackpotVideoEnded}
                muted={false}
                playsInline
                style={{
                  width: '100%',
                  borderRadius: 8,
                  marginBottom: '1.5vw',
                  display: 'block',
                  background: '#000',
                }}
              />
            )}
            <div style={{
              fontSize: '0.9vw', fontWeight: 700, letterSpacing: '0.28em',
              color: '#c8a84b', marginBottom: '1.5vw',
              fontFamily: "'Consolas', monospace",
            }}>
              MYSTERY JACKPOT HIT
            </div>
            <div style={{
              fontFamily: 'Georgia, serif', fontSize: '3.5vw',
              color: '#fffbe8', marginBottom: '1vw', letterSpacing: '0.08em',
              textShadow: '0 0 2vw rgba(200,168,75,0.4)',
            }}>
              {name(jackpot.machineId)}
            </div>
            <div style={{
              fontFamily: 'Georgia, serif', fontSize: '5.5vw', fontWeight: 700,
              color: '#FFD060', fontVariantNumeric: 'tabular-nums',
              textShadow: '0 0 3vw rgba(255,208,96,0.5)', marginBottom: '1.5vw',
            }}>
              ${(jackpot.amount / 100).toLocaleString('en', { minimumFractionDigits: 2 })}
            </div>
            <div style={{
              fontSize: '0.75vw', letterSpacing: '0.35em',
              color: 'rgba(200,168,75,0.45)',
              fontFamily: "'Consolas', monospace",
            }}>
              CONGRATULATIONS
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
