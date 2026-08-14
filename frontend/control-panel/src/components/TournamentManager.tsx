import React, { useState, useEffect } from 'react';
import { getTournaments, createTournament, startTournament, endTournament, Tournament } from '../services/api';

export default function TournamentManager() {
  const [list, setList]   = useState<Tournament[]>([]);
  const [name, setName]   = useState('');
  const [ids, setIds]     = useState('');
  const [credits, setCredits] = useState(10000);
  const [duration, setDuration] = useState(300);
  const [open, setOpen]   = useState(false);

  const load = () => getTournaments().then(setList);
  useEffect(() => { load(); }, []);

  const active = list.find(t => t.status === 'active');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await createTournament({
      name, machine_ids: ids.split(',').map(s => s.trim()).filter(Boolean),
      initial_credits: credits, duration_seconds: duration,
    });
    setName(''); setIds(''); setOpen(false);
    load();
  };

  const statusClass = (s: string) => `badge badge-${s}`;

  return (
    <div style={st.root}>
      {/* Active tournament */}
      <div style={st.section}>
        <div style={st.sectionLabel}>ACTIVE TOURNAMENT</div>
        {active ? (
          <div style={st.activeTourney}>
            <div style={st.activeName}>{active.name}</div>
            <div style={st.activeMeta}>
              {active.machine_ids.length} machines · {active.duration_seconds}s
            </div>
            <div style={st.activeCredits}>
              {active.initial_credits.toLocaleString()} credits/machine
            </div>
            <button className="btn-end" style={{ marginTop: 10, width: '100%' }}
              onClick={() => endTournament(active.id).then(load)}>
              End Tournament
            </button>
          </div>
        ) : (
          <div style={st.noActive}>No active tournament</div>
        )}
      </div>

      {/* Create */}
      <div style={st.section}>
        <button
          className="btn-ghost"
          style={{ width: '100%', marginBottom: open ? 10 : 0 }}
          onClick={() => setOpen(o => !o)}
        >
          {open ? '▴ Cancel' : '＋ New Tournament'}
        </button>

        {open && (
          <form onSubmit={handleCreate} style={st.form}>
            <input placeholder="Tournament name" value={name}
              onChange={e => setName(e.target.value)} required style={{ marginBottom: 6 }} />
            <input placeholder="Machine IDs (comma-separated)" value={ids}
              onChange={e => setIds(e.target.value)} required style={{ marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={st.inputLabel}>Credits</div>
                <input type="number" value={credits}
                  onChange={e => setCredits(+e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={st.inputLabel}>Duration (s)</div>
                <input type="number" value={duration}
                  onChange={e => setDuration(+e.target.value)} />
              </div>
            </div>
            <button type="submit" className="btn-gold" style={{ width: '100%' }}>
              Create Tournament
            </button>
          </form>
        )}
      </div>

      {/* History */}
      <div style={st.section}>
        <div style={st.sectionLabel}>HISTORY</div>
        <div style={st.historyList}>
          {list.filter(t => t.status !== 'active').slice(0, 8).map(t => (
            <div key={t.id} style={st.historyRow}>
              <div style={st.historyLeft}>
                <span style={st.historyName}>{t.name}</span>
                <span style={st.historyMeta}>{t.machine_ids.length} machines</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {t.status === 'scheduled' && (
                  <button className="btn-start" style={{ fontSize: 11, padding: '4px 10px' }}
                    onClick={() => startTournament(t.id).then(load)}>
                    Start
                  </button>
                )}
                <span className={statusClass(t.status)}>{t.status}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 0 },
  section: {
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
  },
  sectionLabel: {
    fontSize: 9, fontWeight: 700, letterSpacing: '.12em',
    color: 'var(--text-3)', marginBottom: 10,
    textTransform: 'uppercase',
  },
  activeTourney: {
    background: 'var(--surface-2)',
    border: '1px solid var(--gold-border)',
    borderRadius: 6, padding: '12px 14px',
  },
  activeName: {
    fontFamily: 'Georgia, serif',
    fontSize: 16, color: 'var(--gold)', fontWeight: 700,
  },
  activeMeta: { fontSize: 12, color: 'var(--text-2)', marginTop: 3 },
  activeCredits: { fontSize: 12, color: 'var(--text-2)', marginTop: 1 },
  noActive: { fontSize: 13, color: 'var(--text-3)', textAlign: 'center', padding: '8px 0' },
  form: { display: 'flex', flexDirection: 'column' },
  inputLabel: { fontSize: 10, color: 'var(--text-3)', marginBottom: 3, letterSpacing: '.04em' },
  historyList: { display: 'flex', flexDirection: 'column', gap: 2 },
  historyRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '7px 0',
    borderBottom: '1px solid var(--border)',
  },
  historyLeft: { display: 'flex', flexDirection: 'column', gap: 1 },
  historyName: { fontSize: 13, color: 'var(--text)' },
  historyMeta: { fontSize: 11, color: 'var(--text-2)' },
};
