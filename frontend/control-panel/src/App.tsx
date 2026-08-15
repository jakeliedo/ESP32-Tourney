import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import api, {
  getMachines, sendMachineCommand, aftInAll, aftOutAll,
  createTournament, startTournament, endTournament,
  Machine,
} from './services/api';

const APP_VERSION = 'v1.0.0';

interface Settings {
  startCredit: string;
  timeMM: string;
  timeSS: string;
  rounds: string;
  jpInitial: string;
}

function parseTotalSeconds(mm: string, ss: string): number {
  return (parseInt(mm) || 0) * 60 + (parseInt(ss) || 0);
}

export default function App() {
  const [settings, setSettings] = useState<Settings>({
    startCredit: '100', timeMM: '05', timeSS: '00', rounds: '', jpInitial: '1000',
  });
  const [machines, setMachines]        = useState<Machine[]>([]);
  const [enabledSet, setEnabledSet]    = useState<Set<string>>(new Set());
  const [buyInMap, setBuyInMap]        = useState<Record<string, string>>({});
  const [nameMap, setNameMap]          = useState<Record<string, string>>({});
  const [tournamentActive, setTActive] = useState(false);
  const [activeTournId, setActiveTId]  = useState<number | null>(null);
  const [roundsCompleted]              = useState(0);
  const [lbOnline, setLbOnline]        = useState(false);
  const [busy, setBusy]                = useState(false);
  const socketRef                      = useRef<Socket | null>(null);
  const seenMachinesRef                = useRef<Set<string>>(new Set());

  // ── Leaderboard connection status ───────────────────────────
  useEffect(() => {
    const s = io('/leaderboard', { transports: ['websocket'] });
    socketRef.current = s;
    s.on('connect',    () => setLbOnline(true));
    s.on('disconnect', () => setLbOnline(false));
    return () => { s.disconnect(); };
  }, []);

  // ── Machine list — poll every 2s ─────────────────────────────
  const loadMachines = useCallback(() => {
    getMachines().then(list => {
      const sorted = list.sort((a, b) => a.machine_id.localeCompare(b.machine_id));
      setMachines(sorted);
      // pre-populate name map from DB
      setNameMap(prev => {
        const next = { ...prev };
        sorted.forEach(m => {
          if (m.display_name && !next[m.machine_id]) next[m.machine_id] = m.display_name;
        });
        return next;
      });
      // auto-enable only machines appearing for the first time
      const newMachines = sorted.filter(
        m => m.status !== 'offline' && !seenMachinesRef.current.has(m.machine_id),
      );
      sorted.forEach(m => seenMachinesRef.current.add(m.machine_id));
      if (newMachines.length > 0) {
        setEnabledSet(prev => {
          const next = new Set(prev);
          newMachines.forEach(m => next.add(m.machine_id));
          return next;
        });
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadMachines();
    const iv = setInterval(loadMachines, 2000);
    return () => clearInterval(iv);
  }, [loadMachines]);

  // ── Handlers ────────────────────────────────────────────────
  const setSetting = (k: keyof Settings) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setSettings(s => ({ ...s, [k]: e.target.value }));

  const enableAll  = () => setEnabledSet(new Set(machines.filter(m => m.status !== 'offline').map(m => m.machine_id)));
  const disableAll = () => setEnabledSet(new Set());

  const toggleEnable = (id: string) => {
    setEnabledSet(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        sendMachineCommand(id, { type: 'LOCK' }).catch(() => {});
      } else {
        next.add(id);
        sendMachineCommand(id, { type: 'UNLOCK' }).catch(() => {});
      }
      return next;
    });
  };

  const saveName = useCallback((machineId: string, name: string) => {
    api.patch(`/machines/${machineId}`, { display_name: name }).catch(() => {});
  }, []);

  const handleAftIn = async () => {
    const amt = parseInt(settings.startCredit) || 0;
    if (!amt) return;
    setBusy(true);
    try { await aftInAll(amt * 100); } finally { setBusy(false); }
  };

  const handleAftOut = async () => {
    setBusy(true);
    try { await aftOutAll(); } finally { setBusy(false); }
  };

  const handleBuyIn = async (machineId: string) => {
    const amt = parseInt(buyInMap[machineId] || '0');
    if (!amt) return;
    await sendMachineCommand(machineId, { type: 'AFT_PUMP', amount: amt * 100 });
    setBuyInMap(prev => ({ ...prev, [machineId]: '' }));
  };

  const handleStart = async () => {
    const enabled = machines.filter(m => enabledSet.has(m.machine_id));
    if (!enabled.length) return;
    const roundSec = parseTotalSeconds(settings.timeMM, settings.timeSS);
    const rounds   = parseInt(settings.rounds) || 0;
    const duration = rounds ? rounds * roundSec : (roundSec || 86400);
    setBusy(true);
    try {
      const t = await createTournament({
        name: `Tournament ${new Date().toLocaleTimeString('en-GB')}`,
        machine_ids: enabled.map(m => m.machine_id),
        initial_credits: parseInt(settings.startCredit) * 100,
        duration_seconds: duration,
      });
      await startTournament(t.id);
      setActiveTId(t.id);
      setTActive(true);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (!activeTournId) return;
    setBusy(true);
    try {
      await endTournament(activeTournId);
      setActiveTId(null);
      setTActive(false);
    } finally {
      setBusy(false);
    }
  };

  const totalRounds    = parseInt(settings.rounds) || 0;
  const connectedCount = machines.filter(m => m.status !== 'offline').length;
  const roundTime      = parseTotalSeconds(settings.timeMM, settings.timeSS);

  return (
    <div style={s.shell}>

      {/* ── A. Header ────────────────────────────────────────── */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.headerIcon}>◈</span>
          <span style={s.headerTitle}>SLOT TOURNAMENT</span>
        </div>
        <span style={s.headerVer}>{APP_VERSION}</span>
      </div>

      {/* ── B. Initial Settings ──────────────────────────────── */}
      <div style={s.section}>
        <div className="section-label">Initial Settings</div>
        <div style={s.settingsGrid}>

          {/* Start Credit */}
          <div style={s.fieldWrap}>
            <label style={s.fieldLabel}>Start Credit</label>
            <div style={s.fieldRow}>
              <span style={s.fieldUnit}>$</span>
              <input type="number" value={settings.startCredit}
                onChange={setSetting('startCredit')} min="0" />
            </div>
          </div>

          {/* Time per Round — MM:SS */}
          <div style={s.fieldWrap}>
            <label style={s.fieldLabel}>Time per Round</label>
            <div style={s.fieldRow}>
              <input type="number" value={settings.timeMM}
                onChange={setSetting('timeMM')} min="0" max="99"
                style={{ width: 54, textAlign: 'center' }}
                placeholder="MM" />
              <span style={{ color: 'var(--text-2)', fontWeight: 700, fontSize: 16, padding: '0 2px' }}>:</span>
              <input type="number" value={settings.timeSS}
                onChange={setSetting('timeSS')} min="0" max="59"
                style={{ width: 54, textAlign: 'center' }}
                placeholder="SS" />
              <span style={{ ...s.fieldUnit, marginLeft: 2 }}>{roundTime ? `= ${roundTime}s` : ''}</span>
            </div>
          </div>

          {/* Rounds */}
          <div style={s.fieldWrap}>
            <label style={s.fieldLabel}>Rounds / Tournament</label>
            <div style={s.fieldRow}>
              <input type="number" value={settings.rounds}
                onChange={setSetting('rounds')} min="1" placeholder="∞" />
            </div>
          </div>

          {/* JP Initial */}
          <div style={s.fieldWrap}>
            <label style={s.fieldLabel}>JP Initial Value</label>
            <div style={s.fieldRow}>
              <span style={s.fieldUnit}>$</span>
              <input type="number" value={settings.jpInitial}
                onChange={setSetting('jpInitial')} min="0" />
            </div>
          </div>

        </div>
      </div>

      {/* ── C. Controls ──────────────────────────────────────── */}
      <div style={s.section}>
        <div className="section-label">Controls</div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <button className="btn-neutral" onClick={loadMachines}>Refresh</button>
          <button className="btn-neutral" onClick={enableAll}>Enable All</button>
          <button className="btn-neutral" onClick={disableAll}>Disable All</button>
          <div style={{ flex: 1 }} />
          <button className="btn-gold" disabled={busy} onClick={handleAftIn}>AFT IN</button>
          <button className="btn-danger" disabled={busy} onClick={handleAftOut}>AFT OUT</button>
        </div>

        <button
          className={`btn-start${tournamentActive ? ' running' : ''}`}
          disabled={busy || tournamentActive}
          onClick={handleStart}
        >
          {tournamentActive ? '▶  TOURNAMENT RUNNING' : 'START THE TOURNAMENT'}
        </button>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button
            className={`btn-stop${tournamentActive ? ' active' : ''}`}
            disabled={!tournamentActive || busy}
            onClick={handleStop}
          >
            STOP
          </button>
        </div>
      </div>

      {/* ── D. Machine List ──────────────────────────────────── */}
      <div style={s.machineSection}>
        <div style={s.machineHeader}>
          <span className="section-label" style={{ marginBottom: 0 }}>
            Connected Machines
          </span>
          <span style={s.machineCount}>{connectedCount} / {machines.length}</span>
        </div>

        <div style={s.machineList}>
          {(() => {
            const visible = machines.filter(m => m.status.toLowerCase() !== 'offline');
            if (visible.length === 0) return (
              <div style={s.empty}>No machines connected</div>
            );
            return visible.map(m => (
              <MachineRow
                key={m.machine_id}
                machine={m}
              enabled={enabledSet.has(m.machine_id)}
              buyIn={buyInMap[m.machine_id] ?? ''}
              nameValue={nameMap[m.machine_id] ?? ''}
              onToggleEnable={() => toggleEnable(m.machine_id)}
              onBuyInChange={v => setBuyInMap(prev => ({ ...prev, [m.machine_id]: v }))}
              onBuyIn={() => handleBuyIn(m.machine_id)}
              onNameChange={v => setNameMap(prev => ({ ...prev, [m.machine_id]: v }))}
              onNameSave={name => saveName(m.machine_id, name)}
            />
            ));
          })()}
        </div>
      </div>

      {/* ── E. Footer ────────────────────────────────────────── */}
      <div style={s.footer}>
        <span style={s.fi}>{APP_VERSION}</span>
        <span style={s.fd}>|</span>
        <span style={s.fi}>
          <span className={`dot dot-${lbOnline ? 'online' : 'offline'}`} />
          LB {lbOnline ? 'ONLINE' : 'OFFLINE'}
        </span>
        <span style={s.fd}>|</span>
        <span style={s.fi}>{connectedCount} machines</span>
        <span style={s.fd}>|</span>
        <span style={s.fi}>Round {roundsCompleted} / {totalRounds || '∞'}</span>
        <div style={{ flex: 1 }} />
        <span style={s.footerLogo}>◈ GMI</span>
      </div>
    </div>
  );
}

// ── MachineRow ────────────────────────────────────────────────
interface MachineRowProps {
  machine: Machine;
  enabled: boolean;
  buyIn: string;
  nameValue: string;
  onToggleEnable: () => void;
  onBuyInChange: (v: string) => void;
  onBuyIn: () => void;
  onNameChange: (v: string) => void;
  onNameSave: (name: string) => void;
}

function MachineRow({
  machine: m, enabled, buyIn, nameValue,
  onToggleEnable, onBuyInChange, onBuyIn, onNameChange, onNameSave,
}: MachineRowProps) {
  const credits = (m.credits / 100).toFixed(2);
  const st = m.status.toLowerCase();
  const dotCls = ['online', 'offline', 'locked', 'handpay'].includes(st) ? `dot-${st}` : 'dot-offline';

  return (
    <div style={r.wrap}>
      {/* Line 1: status */}
      <div style={r.line1}>
        <span style={r.mid}>{m.machine_id}</span>
        <span style={r.ip}>{m.ip_address || '—'}</span>
        <span style={r.status}>
          <span className={`dot ${dotCls}`} />{m.status.toUpperCase()}
        </span>
        <span style={r.credits}>${credits}</span>
        <span style={{ ...r.enabled, color: enabled ? 'var(--online)' : 'var(--text-3)' }}>
          {enabled ? 'ENABLED' : 'DISABLED'}
        </span>
        <button
          className={enabled ? 'btn-disable' : 'btn-enable'}
          onClick={onToggleEnable}
        >
          {enabled ? 'DISABLE' : 'ENABLE'}
        </button>
      </div>

      {/* Line 2: name + buy-in */}
      <div style={r.line2}>
        <span style={r.label2}>Name:</span>
        <input
          type="text"
          className="input-name"
          value={nameValue}
          onChange={e => onNameChange(e.target.value)}
          onBlur={e => onNameSave(e.target.value)}
          placeholder={m.machine_id}
        />
        <span style={{ ...r.label2, marginLeft: 12 }}>Buy-In&nbsp;$</span>
        <input
          type="number"
          className="input-buyin"
          value={buyIn}
          onChange={e => onBuyInChange(e.target.value)}
          placeholder="0"
          min="0" step="1"
        />
        <button className="btn-buyin" onClick={onBuyIn}>BUY-IN</button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  shell: {
    height: '100%', display: 'flex', flexDirection: 'column',
    maxWidth: 940, margin: '0 auto',
    borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 20px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)', flexShrink: 0,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  headerIcon: { fontSize: 20, color: 'var(--gold)', fontFamily: 'Georgia, serif' },
  headerTitle: {
    fontSize: 14, fontWeight: 700, letterSpacing: '.2em',
    color: 'var(--gold)', fontFamily: 'Georgia, serif',
  },
  headerVer: { fontSize: 10, color: 'var(--text-3)' },
  section: {
    padding: '11px 20px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)', flexShrink: 0,
  },
  settingsGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr 1fr', gap: 10,
  },
  fieldWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldLabel: { fontSize: 10, color: 'var(--text-2)', letterSpacing: '.06em' },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 4 },
  fieldUnit: { fontSize: 11, color: 'var(--text-3)', flexShrink: 0 },
  machineSection: {
    flex: 1, display: 'flex', flexDirection: 'column',
    overflow: 'hidden', background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
  },
  machineHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 20px 5px',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  machineCount: { fontSize: 11, color: 'var(--text-2)' },
  machineList: { flex: 1, overflowY: 'auto' },
  empty: {
    textAlign: 'center', color: 'var(--text-3)', padding: '28px 0', fontSize: 12,
  },
  footer: {
    display: 'flex', alignItems: 'center',
    padding: '7px 20px',
    background: 'var(--surface-2)',
    borderTop: '1px solid var(--border)',
    flexShrink: 0, fontSize: 11,
  },
  fi: { color: 'var(--text-2)', padding: '0 7px' },
  fd: { color: 'var(--border-2)' },
  footerLogo: {
    fontFamily: 'Georgia, serif', color: 'var(--gold-dim)',
    fontWeight: 700, letterSpacing: '.1em', fontSize: 12,
  },
};

const r: Record<string, React.CSSProperties> = {
  wrap: {
    padding: '8px 20px 6px',
    borderBottom: '1px solid var(--border)',
  },
  line1: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginBottom: 5,
  },
  line2: {
    display: 'flex', alignItems: 'center', gap: 4,
  },
  mid: { color: 'var(--gold)', fontWeight: 700, fontSize: 12, width: 60, flexShrink: 0 },
  ip:  { color: 'var(--text-2)', fontSize: 11, width: 108, flexShrink: 0 },
  status: { fontSize: 11, width: 88, flexShrink: 0 },
  credits: {
    fontSize: 12, fontWeight: 600, width: 70, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums', color: 'var(--text)', flexShrink: 0,
  },
  enabled: { fontSize: 11, fontWeight: 700, width: 68, flexShrink: 0 },
  label2: { fontSize: 10, color: 'var(--text-3)', flexShrink: 0 },
};
