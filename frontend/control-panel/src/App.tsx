// =============================================================
// App.tsx – Control Panel Root Component
// =============================================================
import React, { useState } from 'react';
import DeviceDashboard from './components/DeviceDashboard';
import TournamentManager from './components/TournamentManager';

type Tab = 'devices' | 'tournaments';

export default function App() {
  const [tab, setTab] = useState<Tab>('devices');

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <header style={{ marginBottom: 24, borderBottom: '1px solid #2a2d3e', paddingBottom: 16 }}>
        <h1 style={{ fontSize: 22 }}>🎰 ESP32 Tourney — Control Panel</h1>
        <nav style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            className={tab === 'devices' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('devices')}
          >
            Devices
          </button>
          <button
            className={tab === 'tournaments' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('tournaments')}
          >
            Tournaments
          </button>
        </nav>
      </header>

      {tab === 'devices'     && <DeviceDashboard />}
      {tab === 'tournaments' && <TournamentManager />}
    </div>
  );
}
