// =============================================================
// Leaderboard.tsx – Real-time tournament ranking display
// Updates at 60fps via WebSocket push events from server
// Designed for 4K video wall displays
// =============================================================
import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

interface RankEntry {
  machineId: string;
  score: number;
  rank: number;
}

interface JackpotAlert {
  machineId: string;
  amount: number;
}

export default function Leaderboard() {
  const [rankings, setRankings]     = useState<RankEntry[]>([]);
  const [jackpot, setJackpot]       = useState<JackpotAlert | null>(null);
  const [tournamentId, setTournId]  = useState<number | null>(null);

  const onLeaderboard = useCallback((data: any) => {
    if (data.tournamentId) setTournId(data.tournamentId);
    const ranked: RankEntry[] = (data.rankings ?? []).map(
      (r: any, i: number) => ({ ...r, rank: i + 1 }),
    );
    setRankings(ranked);
  }, []);

  const onJackpotHit = useCallback((data: any) => {
    setJackpot({ machineId: data.machineId, amount: data.amount });
    setTimeout(() => setJackpot(null), 8000);
  }, []);

  useWebSocket(onLeaderboard, onJackpotHit);

  // Medal colours for top 3
  const medalColor = (rank: number) =>
    rank === 1 ? '#ffd700' : rank === 2 ? '#c0c0c0' : rank === 3 ? '#cd7f32' : '#4a4a6a';

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <h1 style={styles.title}>🏆 SLOT TOURNAMENT</h1>
        {tournamentId && (
          <span style={styles.subtitle}>Tournament #{tournamentId} — LIVE</span>
        )}
      </header>

      {/* Jackpot Alert Overlay */}
      {jackpot && (
        <div style={styles.jackpotOverlay}>
          <div style={styles.jackpotBox}>
            <div style={styles.jackpotLabel}>🎰 MYSTERY JACKPOT HIT!</div>
            <div style={styles.jackpotMachine}>{jackpot.machineId}</div>
            <div style={styles.jackpotAmount}>
              {jackpot.amount.toLocaleString()} CREDITS
            </div>
          </div>
        </div>
      )}

      {/* Ranking Table */}
      <div style={styles.table}>
        {rankings.length === 0 ? (
          <div style={styles.waiting}>Waiting for tournament to start...</div>
        ) : (
          rankings.map(entry => (
            <div
              key={entry.machineId}
              style={{
                ...styles.row,
                borderLeft: `6px solid ${medalColor(entry.rank)}`,
                background: entry.rank <= 3
                  ? `${medalColor(entry.rank)}18`
                  : '#1a1d27',
              }}
            >
              <span style={{ ...styles.rank, color: medalColor(entry.rank) }}>
                #{entry.rank}
              </span>
              <span style={styles.machineId}>{entry.machineId}</span>
              <span style={styles.score}>
                {entry.score.toLocaleString()}
                <span style={styles.pts}> pts</span>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#08090f',
    minHeight: '100vh',
    padding: '40px 60px',
    fontFamily: "'Segoe UI', sans-serif",
    color: '#fff',
  },
  header: {
    textAlign: 'center',
    marginBottom: 40,
  },
  title: {
    fontSize: 56,
    fontWeight: 900,
    letterSpacing: 6,
    color: '#ffd700',
    textShadow: '0 0 30px #ffd70066',
  },
  subtitle: {
    display: 'block',
    fontSize: 20,
    color: '#888',
    marginTop: 8,
    letterSpacing: 2,
  },
  table: {
    maxWidth: 900,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    padding: '18px 24px',
    borderRadius: 10,
    gap: 24,
    transition: 'all 0.3s ease',
  },
  rank: {
    fontSize: 32,
    fontWeight: 900,
    width: 70,
    textAlign: 'center',
  },
  machineId: {
    flex: 1,
    fontSize: 22,
    fontWeight: 600,
    color: '#ddd',
  },
  score: {
    fontSize: 36,
    fontWeight: 900,
    color: '#4fc3f7',
  },
  pts: {
    fontSize: 16,
    color: '#888',
    fontWeight: 400,
  },
  waiting: {
    textAlign: 'center',
    color: '#555',
    fontSize: 24,
    marginTop: 80,
  },
  jackpotOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    animation: 'fadeIn 0.5s ease',
  },
  jackpotBox: {
    background: 'linear-gradient(135deg, #1a0a00, #3d1a00)',
    border: '4px solid #ffd700',
    borderRadius: 24,
    padding: '60px 80px',
    textAlign: 'center',
    boxShadow: '0 0 80px #ffd70066',
  },
  jackpotLabel: {
    fontSize: 40,
    fontWeight: 900,
    color: '#ffd700',
    letterSpacing: 4,
  },
  jackpotMachine: {
    fontSize: 28,
    color: '#fff',
    marginTop: 12,
  },
  jackpotAmount: {
    fontSize: 64,
    fontWeight: 900,
    color: '#ff6b35',
    marginTop: 16,
    textShadow: '0 0 40px #ff6b3566',
  },
};
