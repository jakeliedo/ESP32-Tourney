import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface RankEntry { machineId: string; score: number; rank: number; }
interface JackpotAlert { machineId: string; amount: number; }
interface RoundInfo { roundNumber: number; totalRounds: number; }

const MEDAL = ['#c8a84b', '#a8a8b8', '#a0724a'];


export default function LiveLeaderboard() {
  const [rankings, setRankings]   = useState<RankEntry[]>([]);
  const [jackpot, setJackpot]     = useState<JackpotAlert | null>(null);
  const [tournId, setTournId]     = useState<number | null>(null);
  const [flash, setFlash]         = useState<Set<string>>(new Set());
  const [roundInfo, setRoundInfo] = useState<RoundInfo | null>(null);
  const prevScores                = useRef<Record<string,number>>({});
  const socketRef                 = useRef<Socket | null>(null);

  useEffect(() => {
    const s = io('/leaderboard', { transports: ['websocket', 'polling'] });
    socketRef.current = s;

    s.on('leaderboard_update', (data: any) => {
      if (data.tournamentId) setTournId(data.tournamentId);
      if (data.roundNumber) setRoundInfo({ roundNumber: data.roundNumber, totalRounds: data.totalRounds ?? 1 });
      const ranked: RankEntry[] = (data.rankings ?? []).map(
        (r: any, i: number) => ({ ...r, rank: i + 1 }),
      );

      // detect score changes for flash
      const changed = new Set<string>();
      ranked.forEach(r => {
        if (prevScores.current[r.machineId] !== undefined &&
            prevScores.current[r.machineId] !== r.score) {
          changed.add(r.machineId);
        }
        prevScores.current[r.machineId] = r.score;
      });
      if (changed.size) {
        setFlash(changed);
        setTimeout(() => setFlash(new Set()), 600);
      }
      setRankings(ranked);
    });

    s.on('jackpot_hit', (data: any) => {
      setJackpot({ machineId: data.machineId, amount: data.amount });
      setTimeout(() => setJackpot(null), 8000);
    });

    return () => { s.disconnect(); };
  }, []);

  const medal = (rank: number) => rank <= 3 ? MEDAL[rank - 1] : null;

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.logoWrap}>
            <img src="/logo.png" alt="JAKELIEDO" style={{ height: 40, width: 'auto' }}/>
          </div>
          <div>
            <div style={s.brand}>SLOT TOURNAMENT</div>
            {tournId ? (
              <div style={s.sub}>
                Tournament #{tournId}
                {roundInfo && (
                  <span style={{ marginLeft: 8 }}>
                    · Round {roundInfo.roundNumber}/{roundInfo.totalRounds}
                    {roundInfo.roundNumber === roundInfo.totalRounds && roundInfo.totalRounds > 1 && (
                      <span style={{ color: '#e8b84b', marginLeft: 6 }}>FINAL</span>
                    )}
                  </span>
                )}
                {' · LIVE'}
              </div>
            ) : (
              <div style={s.sub}>Waiting for tournament…</div>
            )}
          </div>
        </div>
        <div style={s.liveDot}>
          <span style={{ ...s.dot, background: rankings.length ? '#3d9e6a' : '#555' }} />
          {rankings.length ? 'LIVE' : 'IDLE'}
        </div>
      </div>

      {/* Rankings */}
      <div style={s.list}>
        {rankings.length === 0 ? (
          <div style={s.empty}>
            <div style={s.emptyIcon}>◈</div>
            <div>Waiting for tournament to start</div>
          </div>
        ) : rankings.map(entry => {
          const color = medal(entry.rank);
          const isTop = entry.rank <= 3;
          const isFlashing = flash.has(entry.machineId);
          return (
            <div
              key={entry.machineId}
              style={{
                ...s.row,
                borderLeft: `3px solid ${color ?? 'transparent'}`,
                background: isTop ? `${color}0d` : 'transparent',
              }}
            >
              <span style={{ ...s.rankNum, color: color ?? 'var(--text-3)' }}>
                {entry.rank <= 3 ? ['①','②','③'][entry.rank-1] : `#${entry.rank}`}
              </span>
              <span style={s.machineId}>{entry.machineId}</span>
              <span style={{
                ...s.score,
                color: isFlashing ? '#c8a84b' : isTop ? '#ede8d8' : 'var(--text-2)',
                transition: 'color .4s ease',
              }}>
                ${(entry.score / 100).toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Jackpot overlay */}
      {jackpot && (
        <div style={s.jackpotOverlay}>
          <div style={s.jackpotBox}>
            <div style={s.jackpotLabel}>MYSTERY JACKPOT</div>
            <div style={s.jackpotMachine}>{jackpot.machineId}</div>
            <div style={s.jackpotAmount}>${(jackpot.amount / 100).toFixed(2)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    flex: 1, display: 'flex', flexDirection: 'column',
    overflow: 'hidden', minHeight: 0,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 32px 18px',
    borderBottom: '1px solid var(--border)',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 14 },
  logoPlaceholder: {
    fontSize: 32, color: 'var(--gold)',
    fontFamily: 'Georgia, serif', lineHeight: 1,
  },
  brand: {
    fontFamily: 'Georgia, serif',
    fontSize: 20, fontWeight: 700,
    letterSpacing: '.12em', color: 'var(--gold)',
  },
  logoWrap: {
    background: '#fff', borderRadius: 8, padding: '3px 6px',
    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
  },
  sub: { fontSize: 11, color: 'var(--text-2)', letterSpacing: '.06em', marginTop: 2 },
  liveDot: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 700, letterSpacing: '.1em', color: 'var(--text-2)',
  },
  dot: {
    width: 7, height: 7, borderRadius: '50%',
    display: 'inline-block',
  },
  list: {
    flex: 1, overflowY: 'auto', padding: '8px 20px',
  },
  row: {
    display: 'flex', alignItems: 'center',
    padding: '12px 14px', borderRadius: 6,
    gap: 16, marginBottom: 3,
    transition: 'background .3s',
  },
  rankNum: {
    fontFamily: 'Georgia, serif',
    fontSize: 22, fontWeight: 700,
    width: 36, textAlign: 'center', flexShrink: 0,
  },
  machineId: {
    flex: 1, fontSize: 15, fontWeight: 500,
    color: 'var(--text)', letterSpacing: '.02em',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  score: {
    fontFamily: 'Georgia, serif',
    fontSize: 24, fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
  pts: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: 11, fontWeight: 400,
    color: 'var(--text-2)', marginLeft: 4,
  },
  empty: {
    textAlign: 'center', color: 'var(--text-3)',
    paddingTop: 80, fontSize: 15, lineHeight: 2.2,
  },
  emptyIcon: {
    fontSize: 40, color: 'var(--gold-dim)',
    fontFamily: 'Georgia, serif', marginBottom: 12,
  },
  jackpotOverlay: {
    position: 'absolute', inset: 0,
    background: 'rgba(7,8,13,.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  jackpotBox: {
    border: '1px solid var(--gold-border)',
    borderRadius: 8, padding: '48px 64px', textAlign: 'center',
    background: 'var(--surface)',
    boxShadow: '0 0 80px rgba(200,168,75,.2)',
  },
  jackpotLabel: {
    fontSize: 11, fontWeight: 700, letterSpacing: '.2em',
    color: 'var(--gold)', marginBottom: 16,
  },
  jackpotMachine: {
    fontFamily: 'Georgia, serif',
    fontSize: 36, color: 'var(--text)', marginBottom: 10,
  },
  jackpotAmount: {
    fontFamily: 'Georgia, serif',
    fontSize: 56, fontWeight: 700, color: 'var(--gold)',
    fontVariantNumeric: 'tabular-nums',
  },
};
