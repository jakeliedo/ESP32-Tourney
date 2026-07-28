// =============================================================
// TournamentManager.tsx – Create, start, end tournaments
// =============================================================
import React, { useEffect, useState } from 'react';
import {
  getTournaments, createTournament, startTournament, endTournament,
  Tournament,
} from '../services/api';

export default function TournamentManager() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [form, setForm] = useState({
    name: '',
    machine_ids: '',
    initial_credits: 10000,
    duration_seconds: 300,
  });

  const load = () =>
    getTournaments().then(r => setTournaments(r.data)).catch(console.error);

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await createTournament({
      ...form,
      machine_ids: form.machine_ids.split(',').map(s => s.trim()),
    });
    load();
  };

  const handleStart = async (id: number) => {
    await startTournament(id);
    load();
  };

  const handleEnd = async (id: number) => {
    await endTournament(id);
    load();
  };

  return (
    <section>
      <h2 style={{ marginBottom: 12 }}>Tournament Manager</h2>

      {/* Create Form */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>New Tournament</h3>
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            placeholder="Tournament name"
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            style={inputStyle}
            required
          />
          <input
            placeholder="Machine IDs (comma-separated): GMI-01, GMI-02"
            value={form.machine_ids}
            onChange={e => setForm(p => ({ ...p, machine_ids: e.target.value }))}
            style={inputStyle}
            required
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="number" placeholder="Initial credits"
              value={form.initial_credits}
              onChange={e => setForm(p => ({ ...p, initial_credits: +e.target.value }))}
              style={{ ...inputStyle, flex: 1 }}
            />
            <input
              type="number" placeholder="Duration (seconds)"
              value={form.duration_seconds}
              onChange={e => setForm(p => ({ ...p, duration_seconds: +e.target.value }))}
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>
          <button type="submit" className="btn-primary" style={{ alignSelf: 'flex-start' }}>
            Create Tournament
          </button>
        </form>
      </div>

      {/* Tournament List */}
      {tournaments.map(t => (
        <div key={t.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{t.name}</strong>
            <span className={`badge badge-${t.status}`} style={{ marginLeft: 8 }}>{t.status}</span>
            <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>
              Machines: {t.machine_ids?.join(', ')} | Credits: {t.initial_credits?.toLocaleString()} | {t.duration_seconds}s
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {t.status === 'scheduled' && (
              <button className="btn-success" onClick={() => handleStart(t.id)}>Start</button>
            )}
            {t.status === 'active' && (
              <button className="btn-danger" onClick={() => handleEnd(t.id)}>End</button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  background: '#12151f',
  border: '1px solid #2a2d3e',
  borderRadius: 6,
  padding: '8px 12px',
  color: '#e0e0e0',
  fontSize: 14,
};
