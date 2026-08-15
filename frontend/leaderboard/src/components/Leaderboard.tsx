import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

interface RankEntry    { machineId: string; score: number; rank: number; }
interface JackpotAlert { machineId: string; amount: number; }
interface Machine      { machine_id: string; display_name: string; status: string; credits: number; }
interface Tournament   { id: number; status: string; started_at: string; duration_seconds: number; }

const ROWS   = 10;
const MEDALS = ['#c8a84b', '#a0a8b0', '#a07448'];

function formatTime(sec: number) {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function Leaderboard() {
  // Socket.IO tournament rankings (empty = no active tournament)
  const [rankings, setRankings]       = useState<RankEntry[]>([]);
  const [jackpot, setJackpot]         = useState<JackpotAlert | null>(null);
  const [tournId, setTournId]         = useState<number | null>(null);
  const [flash, setFlash]             = useState<Set<string>>(new Set());

  // Machine poll state
  const [connected, setConnected]     = useState<Machine[]>([]);
  const [nameMap, setNameMap]         = useState<Record<string, string>>({});

  // Timer
  const [timeLeft, setTimeLeft]       = useState<number | null>(null);
  const endTimeRef                    = useRef<number | null>(null);

  // Score-change tracking
  const prevScores                    = useRef<Record<string, number>>({});
  // Machines that were in tournament — kept even if they go offline
  const tournamentMachineIds          = useRef<Set<string>>(new Set());

  // ── Poll /api/machines every 2 s ──────────────────────────
  useEffect(() => {
    const fetch2 = () =>
      fetch('/api/machines')
        .then(r => r.json())
        .then((list: Machine[]) => {
          const online = list.filter(m => m.status.toLowerCase() !== 'offline');
          setConnected(online);
          const map: Record<string, string> = {};
          list.forEach(m => { if (m.display_name) map[m.machine_id] = m.display_name; });
          setNameMap(map);
        })
        .catch(() => {});
    fetch2();
    const iv = setInterval(fetch2, 2000);
    return () => clearInterval(iv);
  }, []);

  // ── Poll active tournament for countdown ──────────────────
  useEffect(() => {
    const fetchT = () =>
      fetch('/api/tournaments')
        .then(r => r.json())
        .then((list: Tournament[]) => {
          const active = list.find(t => t.status === 'active');
          if (active?.started_at) {
            endTimeRef.current = new Date(active.started_at).getTime() + active.duration_seconds * 1000;
          } else {
            endTimeRef.current = null;
            setTimeLeft(null);
          }
        })
        .catch(() => {});
    fetchT();
    const iv = setInterval(fetchT, 5000);
    return () => clearInterval(iv);
  }, []);

  // ── Countdown tick ─────────────────────────────────────────
  useEffect(() => {
    const tick = setInterval(() => {
      if (endTimeRef.current !== null)
        setTimeLeft(Math.max(0, Math.floor((endTimeRef.current - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  // ── Socket.IO handlers ─────────────────────────────────────
  const onLeaderboard = useCallback((data: any) => {
    if (data.tournamentId) setTournId(data.tournamentId);
    const ranked: RankEntry[] = (data.rankings ?? []).map(
      (r: any, i: number) => ({ ...r, rank: i + 1 }),
    );

    // Track which machines are in tournament (never remove from leaderboard mid-tournament)
    ranked.forEach(r => tournamentMachineIds.current.add(r.machineId));

    // Score flash detection
    const changed = new Set<string>();
    ranked.forEach(r => {
      if (prevScores.current[r.machineId] !== undefined &&
          prevScores.current[r.machineId] !== r.score) changed.add(r.machineId);
      prevScores.current[r.machineId] = r.score;
    });
    if (changed.size) {
      setFlash(changed);
      setTimeout(() => setFlash(new Set()), 700);
    }

    // If backend sends empty rankings → tournament ended → reset
    if (ranked.length === 0) {
      tournamentMachineIds.current.clear();
      setTournId(null);
    }
    setRankings(ranked);
  }, []);

  const onJackpotHit = useCallback((data: any) => {
    setJackpot({ machineId: data.machineId, amount: data.amount });
    setTimeout(() => setJackpot(null), 9000);
  }, []);

  useWebSocket(onLeaderboard, onJackpotHit);

  // ── Build display rows ─────────────────────────────────────
  const isInTournament = rankings.length > 0;

  // Pre-tournament: sort connected machines by credits descending
  const preTournRanks: RankEntry[] = [...connected]
    .sort((a, b) => (b.credits - a.credits) || a.machine_id.localeCompare(b.machine_id))
    .map((m, i) => ({ machineId: m.machine_id, score: m.credits, rank: i + 1 }));

  const sourceRows = isInTournament ? rankings : preTournRanks;

  // Fixed 10 slots, pad with nulls
  const displayRows: (RankEntry | null)[] = Array.from({ length: ROWS }, (_, i) => sourceRows[i] ?? null);

  const name = (mid: string) => nameMap[mid] || mid;

  // ── Render ─────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.left}>
          <span style={s.mark}>◈</span>
          <div>
            <div style={s.brand}>SLOT TOURNAMENT</div>
            <div style={s.sub}>
              {isInTournament ? `TOURNAMENT #${tournId} · LIVE` : 'STANDINGS'}
            </div>
          </div>
        </div>

        <div style={s.right}>
          {isInTournament && timeLeft !== null && (
            <div style={s.timerBlock}>
              <div style={s.timerLabel}>TIME REMAINING</div>
              <div style={{
                ...s.timerVal,
                color: timeLeft <= 60 ? '#e05050' : '#c8a84b',
                textShadow: timeLeft <= 60 ? '0 0 20px rgba(220,70,70,.35)' : '0 0 16px rgba(200,168,75,.28)',
              }}>
                {formatTime(timeLeft)}
              </div>
            </div>
          )}
          <div style={s.liveChip}>
            <span style={{
              ...s.liveDot,
              background: isInTournament ? '#3aaa60' : (connected.length > 0 ? '#c8a84b' : '#333'),
              boxShadow: isInTournament ? '0 0 8px #3aaa60' : 'none',
            }} />
            {isInTournament ? 'LIVE' : connected.length > 0 ? 'STANDBY' : 'IDLE'}
          </div>
        </div>
      </div>

      <div style={s.divider} />

      {/* Column headers */}
      <div style={s.colHead}>
        <span style={{ width: 64, textAlign: 'center' }}>RANK</span>
        <span style={{ flex: 1 }}>MACHINE</span>
        <span style={{ textAlign: 'right' }}>{isInTournament ? 'POINTS' : 'CREDITS'}</span>
      </div>

      {/* 10 fixed rows */}
      <div style={s.list}>
        {displayRows.map((entry, i) => {
          const rank  = i + 1;
          const color = rank <= 3 ? MEDALS[rank - 1] : null;
          const empty = !entry;
          const isFlashing = entry ? flash.has(entry.machineId) : false;
          const isTop = !empty && rank <= 3;

          return (
            <div
              key={rank}
              style={{
                ...s.row,
                borderLeft: `3px solid ${empty ? '#1a1c28' : (color ?? '#2a2c40')}`,
                background: (!empty && isTop) ? `${color}0e` : 'transparent',
                opacity: empty ? 0.16 : 1,
                transition: 'opacity .3s, background .3s',
              }}
            >
              {/* Rank */}
              <div style={{ ...s.rankWrap, color: color ?? (empty ? '#2a2a3a' : '#404060') }}>
                {rank <= 3
                  ? <span style={s.medal}>{'①②③'[rank - 1]}</span>
                  : <span style={s.rankNum}>#{rank}</span>
                }
              </div>

              {/* Name */}
              <div style={{
                ...s.machineName,
                color: empty ? '#2a2a3a' : isTop ? '#ede8d8' : '#8080a8',
              }}>
                {empty ? '—' : name(entry.machineId)}
              </div>

              {/* Score */}
              <div style={{
                ...s.score,
                color: empty
                  ? '#1e1e2e'
                  : isFlashing ? '#e8d070' : (color ?? '#505070'),
                textShadow: (!empty && isTop) ? `0 0 24px ${color}40` : 'none',
                transition: 'color .5s ease',
              }}>
                {empty ? '—' : entry.score.toLocaleString()}
                {!empty && (
                  <span style={s.unit}> {isInTournament ? 'pts' : 'CR'}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Jackpot overlay */}
      {jackpot && (
        <div style={s.overlay}>
          <div style={s.jpBox}>
            <div style={s.jpEye}>MYSTERY JACKPOT HIT</div>
            <div style={s.jpMachine}>{name(jackpot.machineId)}</div>
            <div style={s.jpAmount}>
              ${(jackpot.amount / 100).toLocaleString('en', { minimumFractionDigits: 2 })}
            </div>
            <div style={s.jpSub}>CONGRATULATIONS</div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    width: '100%', height: '100%',
    display: 'flex', flexDirection: 'column',
    background: '#06070c', color: '#ede8d8',
    fontFamily: "'Consolas','Menlo',monospace",
    overflow: 'hidden', position: 'relative',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '24px 56px 18px', flexShrink: 0,
  },
  left: { display: 'flex', alignItems: 'center', gap: 16 },
  right: { display: 'flex', alignItems: 'center', gap: 28 },
  mark: { fontSize: 40, color: '#c8a84b', fontFamily: 'Georgia,serif', lineHeight: 1 },
  brand: {
    fontFamily: 'Georgia,serif', fontSize: 30, fontWeight: 700,
    letterSpacing: '.22em', color: '#c8a84b', lineHeight: 1,
  },
  sub: { fontSize: 11, color: '#4a4040', letterSpacing: '.14em', marginTop: 5 },
  timerBlock: { textAlign: 'right' },
  timerLabel: { fontSize: 9, color: '#3a3030', letterSpacing: '.2em', marginBottom: 3 },
  timerVal: {
    fontFamily: 'Georgia,serif', fontSize: 40, fontWeight: 700,
    fontVariantNumeric: 'tabular-nums', lineHeight: 1, transition: 'color .5s, text-shadow .5s',
  },
  liveChip: {
    display: 'flex', alignItems: 'center', gap: 7,
    fontSize: 11, fontWeight: 700, letterSpacing: '.16em', color: '#3a3040',
  },
  liveDot: {
    width: 8, height: 8, borderRadius: '50%',
    display: 'inline-block', transition: 'all .4s',
  },
  divider: { height: 1, background: '#14162a', margin: '0 52px', flexShrink: 0 },
  colHead: {
    display: 'flex', alignItems: 'center',
    padding: '6px 20px 4px 20px',
    margin: '0 36px',
    fontSize: 9, fontWeight: 700, letterSpacing: '.14em',
    color: '#2a2a3a', flexShrink: 0,
  },
  list: {
    flex: 1, display: 'flex', flexDirection: 'column',
    padding: '4px 36px', gap: 2, overflowY: 'hidden',
  },
  row: {
    display: 'flex', alignItems: 'center',
    padding: '10px 18px', borderRadius: 5,
    gap: 18, flexShrink: 0,
  },
  rankWrap: { width: 64, textAlign: 'center', flexShrink: 0 },
  medal: { fontFamily: 'Georgia,serif', fontSize: 28, fontWeight: 700, lineHeight: 1 },
  rankNum: { fontFamily: 'Georgia,serif', fontSize: 22, fontWeight: 700 },
  machineName: {
    flex: 1, fontSize: 18, fontWeight: 600, letterSpacing: '.04em',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    transition: 'color .3s',
  },
  score: {
    fontFamily: 'Georgia,serif', fontSize: 30, fontWeight: 700,
    fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 140, textAlign: 'right',
  },
  unit: { fontFamily: "'Consolas',monospace", fontSize: 12, fontWeight: 400, color: '#2a2a40' },
  overlay: {
    position: 'absolute', inset: 0, background: 'rgba(6,7,12,.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99,
  },
  jpBox: {
    border: '1px solid rgba(200,168,75,.3)', borderRadius: 8,
    padding: '52px 88px', textAlign: 'center', background: '#08090e',
    boxShadow: '0 0 100px rgba(200,168,75,.14)',
  },
  jpEye: { fontSize: 11, fontWeight: 700, letterSpacing: '.22em', color: '#c8a84b', marginBottom: 20 },
  jpMachine: {
    fontFamily: 'Georgia,serif', fontSize: 42, color: '#ede8d8',
    marginBottom: 12, letterSpacing: '.06em',
  },
  jpAmount: {
    fontFamily: 'Georgia,serif', fontSize: 68, fontWeight: 700, color: '#c8a84b',
    fontVariantNumeric: 'tabular-nums',
    textShadow: '0 0 50px rgba(200,168,75,.38)', marginBottom: 16,
  },
  jpSub: { fontSize: 11, letterSpacing: '.3em', color: '#4a4040' },
};
