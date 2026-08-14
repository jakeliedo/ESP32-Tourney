import React, { useState, useEffect } from 'react';
import { getMachines, Machine } from '../services/api';

const STATUS_ORDER = ['playing', 'locked', 'handpay', 'online', 'offline'];

function statusPriority(s: string) {
  const i = STATUS_ORDER.indexOf(s.toLowerCase());
  return i === -1 ? 99 : i;
}

export default function DeviceDashboard() {
  const [machines, setMachines] = useState<Machine[]>([]);

  useEffect(() => {
    getMachines().then(setMachines);
    const iv = setInterval(() => getMachines().then(setMachines), 4000);
    return () => clearInterval(iv);
  }, []);

  const sorted = [...machines].sort(
    (a, b) => statusPriority(a.status) - statusPriority(b.status),
  );

  const counts = machines.reduce<Record<string, number>>((acc, m) => {
    const k = m.status.toLowerCase();
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={st.root}>
      {/* Summary bar */}
      {machines.length > 0 && (
        <div style={st.summaryBar}>
          {Object.entries(counts).map(([k, v]) => (
            <span key={k} className={`badge badge-${k}`} style={{ marginRight: 5 }}>
              {v} {k}
            </span>
          ))}
        </div>
      )}

      {/* Machine grid */}
      <div style={st.grid}>
        {sorted.length === 0 ? (
          <div style={st.empty}>No machines online</div>
        ) : sorted.map(m => (
          <MachineCard key={m.machine_id} machine={m} />
        ))}
      </div>
    </div>
  );
}

function MachineCard({ machine: m }: { machine: Machine }) {
  const s = m.status.toLowerCase();
  const colorMap: Record<string, string> = {
    online: 'var(--online)',
    playing: 'var(--playing)',
    locked: 'var(--locked)',
    handpay: 'var(--handpay)',
    offline: 'var(--offline)',
  };
  const accentColor = colorMap[s] ?? 'var(--offline)';

  return (
    <div style={{ ...st.card, borderTop: `2px solid ${accentColor}` }}>
      <div style={st.cardTop}>
        <span style={st.machineId}>{m.machine_id}</span>
        <span className={`badge badge-${s}`}>{m.status}</span>
      </div>
      <div style={st.credits}>
        {(m.credits ?? 0).toLocaleString()}
        <span style={st.creditLabel}>CR</span>
      </div>
      <div style={st.stats}>
        <div style={st.stat}>
          <span style={st.statLabel}>IN</span>
          <span style={st.statVal}>{(m.coin_in ?? 0).toLocaleString()}</span>
        </div>
        <div style={st.statDivider} />
        <div style={st.stat}>
          <span style={st.statLabel}>OUT</span>
          <span style={st.statVal}>{(m.coin_out ?? 0).toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', padding: '10px 14px', flex: 1, minHeight: 0 },
  summaryBar: { marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 4 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: 8,
    overflowY: 'auto', flex: 1,
  },
  empty: { fontSize: 13, color: 'var(--text-3)', gridColumn: '1/-1', textAlign: 'center', paddingTop: 24 },
  card: {
    background: 'var(--surface-2)',
    borderRadius: 6,
    padding: '10px 10px 8px',
    display: 'flex', flexDirection: 'column', gap: 4,
    border: '1px solid var(--border)',
  },
  cardTop: {
    display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 2,
  },
  machineId: { fontSize: 12, fontWeight: 700, color: 'var(--text-2)', letterSpacing: '.04em' },
  credits: {
    fontFamily: 'Georgia, serif',
    fontSize: 20, fontWeight: 700,
    color: 'var(--text)',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.1,
  },
  creditLabel: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: 10, fontWeight: 400,
    color: 'var(--text-2)', marginLeft: 3,
  },
  stats: {
    display: 'flex', alignItems: 'center', gap: 6,
    marginTop: 2,
  },
  stat: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1 },
  statLabel: { fontSize: 9, color: 'var(--text-3)', letterSpacing: '.08em', fontWeight: 700 },
  statVal: { fontSize: 11, color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' },
  statDivider: { width: 1, height: 22, background: 'var(--border)' },
};
