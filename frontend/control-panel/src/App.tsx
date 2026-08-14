import React, { useState } from 'react';
import LiveLeaderboard from './components/LiveLeaderboard';
import TournamentManager from './components/TournamentManager';
import DeviceDashboard from './components/DeviceDashboard';

type Panel = 'tournament' | 'devices';

export default function App() {
  const [panel, setPanel] = useState<Panel>('tournament');

  return (
    <div style={st.shell}>
      {/* ── Leaderboard (left, takes remaining space) ── */}
      <div style={st.leaderboardPane}>
        <LiveLeaderboard />
      </div>

      {/* ── Sidebar (right, fixed width) ── */}
      <div style={st.sidebar}>
        {/* Sidebar nav */}
        <div style={st.nav}>
          <div style={st.navBrand}>CONTROL</div>
          <div style={st.navTabs}>
            <button
              style={{ ...st.navBtn, ...(panel === 'tournament' ? st.navBtnActive : {}) }}
              onClick={() => setPanel('tournament')}
            >
              Tournament
            </button>
            <button
              style={{ ...st.navBtn, ...(panel === 'devices' ? st.navBtnActive : {}) }}
              onClick={() => setPanel('devices')}
            >
              Devices
            </button>
          </div>
        </div>

        {/* Panel content */}
        <div style={st.panelContent}>
          {panel === 'tournament' ? <TournamentManager /> : <DeviceDashboard />}
        </div>
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  shell: {
    height: '100%',
    display: 'flex',
    background: 'var(--bg)',
    overflow: 'hidden',
  },
  leaderboardPane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    position: 'relative',
    borderRight: '1px solid var(--border)',
  },
  sidebar: {
    width: 'var(--sidebar)',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--surface)',
  },
  nav: {
    padding: '14px 16px 0',
    borderBottom: '1px solid var(--border)',
  },
  navBrand: {
    fontSize: 9, fontWeight: 700, letterSpacing: '.2em',
    color: 'var(--gold)', marginBottom: 10,
  },
  navTabs: {
    display: 'flex',
    gap: 2,
    marginBottom: -1,
  },
  navBtn: {
    background: 'transparent',
    border: '1px solid transparent',
    borderBottom: 'none',
    borderRadius: '4px 4px 0 0',
    padding: '6px 14px',
    fontSize: 12, fontWeight: 600,
    color: 'var(--text-2)',
    letterSpacing: '.03em',
    transition: 'color .15s, background .15s',
  },
  navBtnActive: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderBottom: '1px solid var(--surface-2)',
    color: 'var(--text)',
  },
  panelContent: {
    flex: 1,
    overflowY: 'auto',
    background: 'var(--surface-2)',
  },
};
