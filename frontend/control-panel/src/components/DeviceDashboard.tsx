// =============================================================
// DeviceDashboard.tsx – Machine grid with real-time status
// =============================================================
import React, { useEffect, useState } from 'react';
import { getMachines, Machine } from '../services/api';
import { io } from 'socket.io-client';

const socket = io('/leaderboard');

export default function DeviceDashboard() {
  const [machines, setMachines] = useState<Machine[]>([]);

  useEffect(() => {
    getMachines().then(r => setMachines(r.data)).catch(console.error);

    socket.on('machine_update', (data: any) => {
      setMachines(prev => prev.map(m =>
        m.machine_id === data.machineId
          ? { ...m, credits: data.credits, status: statusFromState(data.state) }
          : m,
      ));
    });

    return () => { socket.off('machine_update'); };
  }, []);

  return (
    <section>
      <h2 style={{ marginBottom: 12 }}>Device Dashboard</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 12 }}>
        {machines.map(m => (
          <div key={m.machine_id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{m.machine_id}</strong>
              <span className={`badge badge-${m.status}`}>{m.status}</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 13, color: '#aaa' }}>
              <div>Credits: <b style={{ color: '#fff' }}>{m.credits.toLocaleString()}</b></div>
              <div>Coin-in: {m.coin_in.toLocaleString()}</div>
              <div>IP: {m.ip_address ?? '—'}</div>
            </div>
          </div>
        ))}
        {machines.length === 0 && (
          <p style={{ color: '#666' }}>No machines connected.</p>
        )}
      </div>
    </section>
  );
}

function statusFromState(state: number) {
  const map: Record<number, Machine['status']> = {
    0: 'offline', 1: 'online', 2: 'playing', 3: 'locked', 4: 'handpay', 5: 'offline',
  };
  return map[state] ?? 'online';
}
