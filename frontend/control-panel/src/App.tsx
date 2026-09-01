import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import api, {
  getMachines, sendMachineCommand, aftInAll, aftOutAll,
  createTournament, startTournament, endTournament, cancelTournament,
  setVirtualJackpotConfig, getVirtualJackpotVideoUrl, uploadJackpotVideo, clearJackpotVideo,
  getJackpotHits,
  Machine, Player, SessionDto, JackpotHit,
  getHistory, getPlayers, upsertPlayer, deletePlayer,
} from './services/api';

const APP_VERSION = 'v1.0.0';

const SESSION_COLORS = [
  '#61afef', '#98c379', '#e06c75', '#c678dd',
  '#e5c07b', '#56b6c2', '#d19a66', '#be5046',
  '#2bbac5', '#f0a45d',
];
function sessionColor(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = Math.imul(31, h) + sessionId.charCodeAt(i) | 0;
  return SESSION_COLORS[Math.abs(h) % SESSION_COLORS.length];
}


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
    startCredit: '100', timeMM: '00', timeSS: '10', rounds: '', jpInitial: '1000',
  });
  const [machines, setMachines]        = useState<Machine[]>([]);
  const [enabledSet, setEnabledSet]    = useState<Set<string>>(new Set());
  const [buyInMap, setBuyInMap]        = useState<Record<string, string>>({});
  const [nameMap, setNameMap]          = useState<Record<string, string>>({});
  const [tournamentActive, setTActive]       = useState(false);
  const [activeTournId, setActiveTId]        = useState<number | null>(null);
  const [timeLeft, setTimeLeft]              = useState<number | null>(null);
  const [roundsCompleted, setRoundsCompleted] = useState(0);
  const [waitingNextRound, setWaitingNextRound] = useState(false);
  const [lbOnline, setLbOnline]              = useState(false);
  const [busy, setBusy]                      = useState(false);
  const [sideTab, setSideTab]                = useState<'machines'|'history'|'players'>('machines');
  const [history, setHistory]                = useState<SessionDto[]>([]);
  const [players, setPlayers]                = useState<Player[]>([]);
  const [newMembership, setNewMembership]    = useState('');
  const [newPlayerName, setNewPlayerName]    = useState('');
  const [sessionName, setSessionName]        = useState('');
  const [vjpEnabled, setVjpEnabled]          = useState(false);
  const [vjpFloor,   setVjpFloor]            = useState('100');
  const [vjpCeiling, setVjpCeiling]          = useState('300');
  const [vjpRate,    setVjpRate]             = useState('1');
  const [vjpVideoName, setVjpVideoName]      = useState<string | null>(null);
  const [vjpVideoUploading, setVjpVideoUploading] = useState(false);
  const [jackpotHits, setJackpotHits]        = useState<JackpotHit[]>([]);
  const vjpVideoRef                          = useRef<HTMLInputElement>(null);
  const socketRef                            = useRef<Socket | null>(null);
  const endTimeRef                           = useRef<number | null>(null);
  const activeTournIdRef                     = useRef<number | null>(null);
  const sessionIdRef                         = useRef<string | null>(null);
  const sessionNameRef                       = useRef('');
  const sessionTotalRoundsRef                = useRef(0);
  const roundsCompletedRef                   = useRef(0);

  // ── Socket.IO: connection status + real-time machine updates ─
  useEffect(() => {
    const s = io('/leaderboard', { transports: ['websocket', 'polling'] });
    socketRef.current = s;
    s.on('connect',    () => setLbOnline(true));
    s.on('disconnect', () => setLbOnline(false));
    s.on('machine_update', (data: any) => {
      setMachines(prev => prev.map(m =>
        m.machine_id === data.machineId
          ? {
              ...m,
              credits:  data.credits  ?? m.credits,
              coin_in:  data.coin_in  ?? m.coin_in,
              coin_out: data.coin_out ?? m.coin_out,
              status:   data.status   ?? m.status,
            }
          : m,
      ));
    });
    // Sync the control-panel countdown to the server's authoritative endsAt.
    // When endsAt=0 the server has ended the tournament (e.g. duration expired
    // server-side) — refresh machine statuses immediately without waiting for
    // the 2-second poll cycle.
    s.on('leaderboard_update', (data: any) => {
      if (data.endsAt > 0 && data.tournamentId === activeTournIdRef.current) {
        if (data.endsAt > Date.now()) endTimeRef.current = data.endsAt;
      } else if (data.endsAt === 0) {
        loadMachines();
      }
    });
    return () => { s.disconnect(); };
  }, []);

  // ── Tournament countdown timer ────────────────────────────────
  useEffect(() => {
    const tick = setInterval(async () => {
      if (endTimeRef.current === null) return;
      const remaining = Math.max(0, Math.floor((endTimeRef.current - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining === 0 && activeTournIdRef.current !== null) {
        const id = activeTournIdRef.current;
        activeTournIdRef.current = null;
        endTimeRef.current = null;
        setBusy(true);
        try {
          await endTournament(id);
          loadMachines();   // refresh machine statuses without waiting for next poll
          setActiveTId(null);
          setTActive(false);
          setTimeLeft(null);
          const newCount = roundsCompletedRef.current + 1;
          roundsCompletedRef.current = newCount;
          setRoundsCompleted(newCount);
          if (sessionTotalRoundsRef.current > 0 && newCount < sessionTotalRoundsRef.current) {
            setWaitingNextRound(true);
          } else {
            setWaitingNextRound(false);
            sessionIdRef.current = null;
            sessionNameRef.current = '';
            sessionTotalRoundsRef.current = 0;
            roundsCompletedRef.current = 0;
            setRoundsCompleted(0);
            setSessionName('');
          }
        } finally {
          setBusy(false);
        }
      }
    }, 1000);
    return () => clearInterval(tick);
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
      // Sync enabledSet with DB status: disabled/offline → remove, anything else → add
      setEnabledSet(prev => {
        const next = new Set(prev);
        sorted.forEach(m => {
          const s = m.status.toLowerCase();
          if (s === 'offline' || s === 'disabled') {
            next.delete(m.machine_id);
          } else {
            next.add(m.machine_id);
          }
        });
        return next;
      });
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

  const enableAll = () => {
    const targets = machines.filter(m => m.status.toLowerCase() !== 'offline');
    setEnabledSet(new Set(targets.map(m => m.machine_id)));
    targets.forEach(m => sendMachineCommand(m.machine_id, { type: 'ENABLE' }).catch(() => {}));
  };
  const disableAll = () => {
    setEnabledSet(new Set());
    machines.filter(m => m.status.toLowerCase() !== 'offline')
      .forEach(m => sendMachineCommand(m.machine_id, { type: 'DISABLE' }).catch(() => {}));
  };

  const toggleEnable = (id: string) => {
    setEnabledSet(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        sendMachineCommand(id, { type: 'DISABLE' }).catch(() => {});
      } else {
        next.add(id);
        sendMachineCommand(id, { type: 'ENABLE' }).catch(() => {});
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
    // Optimistic credit update so machine row reflects buy-in immediately
    setMachines(prev => prev.map(m =>
      m.machine_id === machineId ? { ...m, credits: m.credits + amt * 100 } : m,
    ));
    setBuyInMap(prev => ({ ...prev, [machineId]: '' }));
  };

  const handleStart = async () => {
    // Push virtual jackpot config to backend before starting
    setVirtualJackpotConfig({
      floor:   Math.round((parseFloat(vjpFloor)   || 100) * 100),
      ceiling: Math.round((parseFloat(vjpCeiling) || 300) * 100),
      rate:    parseFloat(vjpRate) || 1,
      enabled: vjpEnabled,
    }).catch(() => {});

    // Auto-select all connected (non-offline) machines — no manual "Enable All" required
    const enabled = machines.filter(m => m.status.toLowerCase() !== 'offline');
    if (!enabled.length) return;
    setEnabledSet(new Set(enabled.map(m => m.machine_id)));
    const roundSec        = parseTotalSeconds(settings.timeMM, settings.timeSS);
    const configuredRounds = parseInt(settings.rounds) || 0;
    const duration        = roundSec || 86400;

    // Initialize session if starting fresh
    if (!sessionIdRef.current) {
      sessionIdRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionNameRef.current = sessionName.trim() || new Date().toLocaleDateString('en-GB');
      sessionTotalRoundsRef.current = configuredRounds;
      roundsCompletedRef.current    = 0;
      setRoundsCompleted(0);
    }

    const roundNumber = roundsCompletedRef.current + 1;
    const totalR      = sessionTotalRoundsRef.current || 1;

    setBusy(true);
    setWaitingNextRound(false);
    try {
      const t = await createTournament({
        name: `Round ${roundNumber} · ${new Date().toLocaleTimeString('en-GB')}`,
        machine_ids: enabled.map(m => m.machine_id),
        initial_credits: 0,
        duration_seconds: duration,
        session_id: sessionIdRef.current!,
        session_name: sessionNameRef.current,
        round_number: roundNumber,
        total_rounds: totalR,
      });
      // Timer starts immediately so display is visible before machines are enabled
      setActiveTId(t.id);
      activeTournIdRef.current = t.id;
      endTimeRef.current = Date.now() + duration * 1000;
      setTActive(true);
      // ENABLE sent 1 second after timer starts
      setTimeout(() => startTournament(t.id).catch(console.error), 1000);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (!activeTournId) return;
    // Disarm the countdown so the auto-end timer doesn't fire after cancel
    activeTournIdRef.current = null;
    endTimeRef.current = null;
    setBusy(true);
    try {
      await cancelTournament(activeTournId);
      loadMachines();
      setActiveTId(null);
      setTActive(false);
      setTimeLeft(null);
      // Round is cancelled — do NOT increment roundsCompleted, keep session alive.
      // The START button will show the same round number so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  const handleNewSession = () => {
    setWaitingNextRound(false);
    sessionIdRef.current = null;
    sessionNameRef.current = '';
    sessionTotalRoundsRef.current = 0;
    roundsCompletedRef.current = 0;
    setRoundsCompleted(0);
    setSessionName('');
  };

  // ── VJP video — load current filename on mount ────────────
  useEffect(() => {
    getVirtualJackpotVideoUrl().then(r => { if (r.name) setVjpVideoName(r.name); }).catch(() => {});
  }, []);

  const handleVjpVideoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVjpVideoUploading(true);
    try {
      const r = await uploadJackpotVideo(file);
      if (r.ok) setVjpVideoName(r.name);
    } catch { /* ignore */ } finally {
      setVjpVideoUploading(false);
      if (vjpVideoRef.current) vjpVideoRef.current.value = '';
    }
  };

  const handleClearVjpVideo = async () => {
    await clearJackpotVideo().catch(() => {});
    setVjpVideoName(null);
  };

  // ── History + Players ─────────────────────────────────────
  const loadHistory = useCallback(() => {
    getHistory().then(setHistory).catch(() => {});
    getJackpotHits().then(setJackpotHits).catch(() => {});
  }, []);

  const loadPlayers = useCallback(() => {
    getPlayers().then(setPlayers).catch(() => {});
  }, []);

  useEffect(() => {
    if (sideTab === 'history') loadHistory();
    if (sideTab === 'players') loadPlayers();
  }, [sideTab, loadHistory, loadPlayers]);

  const handleAddPlayer = async () => {
    if (!newMembership.trim()) return;
    await upsertPlayer({ membership_number: newMembership.trim(), display_name: newPlayerName.trim() });
    setNewMembership(''); setNewPlayerName('');
    loadPlayers();
  };

  const handleDeletePlayer = async (membership: string) => {
    await deletePlayer(membership);
    loadPlayers();
  };

  const configuredTotalRounds = parseInt(settings.rounds) || 0;
  const totalRounds    = sessionTotalRoundsRef.current || configuredTotalRounds;
  const connectedCount = machines.filter(m => m.status !== 'offline').length;
  const roundTime      = parseTotalSeconds(settings.timeMM, settings.timeSS);
  const currentRoundNum = tournamentActive ? roundsCompleted + 1 : (waitingNextRound ? roundsCompleted + 1 : roundsCompleted + 1);
  const isFinalRound    = totalRounds > 0 && currentRoundNum === totalRounds;

  return (
    <div style={s.shell}>

      {/* ── A. Header ────────────────────────────────────────── */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.logoWrap}>
            <img src="/logo.png" alt="JAKELIEDO" style={{ height: 36, width: 'auto' }}/>
          </div>
          <div style={s.headerTitle}>SLOT TOURNAMENT</div>
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
              <input type="number" className="with-spin" value={settings.rounds}
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

        {/* Session Name */}
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ ...s.fieldLabel, flexShrink: 0 }}>Session Name</label>
          <input
            type="text"
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
            placeholder={new Date().toLocaleDateString('en-GB')}
            disabled={!!sessionIdRef.current}
            style={{ flex: 1, opacity: sessionIdRef.current ? 0.4 : 1 }}
          />
        </div>

        {/* Virtual Jackpot Engine */}
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 5,
            fontSize: 11, color: vjpEnabled ? '#5bb8ff' : 'var(--text-2)',
            cursor: 'pointer', flexShrink: 0, fontWeight: vjpEnabled ? 600 : 400,
            transition: 'color .2s',
          }}>
            <input
              type="checkbox"
              checked={vjpEnabled}
              onChange={e => setVjpEnabled(e.target.checked)}
              disabled={tournamentActive}
              style={{ cursor: 'pointer', accentColor: '#5bb8ff' }}
            />
            Virtual Jackpot
          </label>
          {vjpEnabled && <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ ...s.fieldLabel, whiteSpace: 'nowrap' }}>Floor $</span>
              <input type="number" value={vjpFloor}
                onChange={e => setVjpFloor(e.target.value)}
                min="1" disabled={tournamentActive}
                style={{ width: 60, opacity: tournamentActive ? 0.4 : 1 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ ...s.fieldLabel, whiteSpace: 'nowrap' }}>Ceiling $</span>
              <input type="number" value={vjpCeiling}
                onChange={e => setVjpCeiling(e.target.value)}
                min="1" disabled={tournamentActive}
                style={{ width: 60, opacity: tournamentActive ? 0.4 : 1 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ ...s.fieldLabel, whiteSpace: 'nowrap' }}>Rate %</span>
              <input type="number" value={vjpRate}
                onChange={e => setVjpRate(e.target.value)}
                min="0.1" max="100" step="0.1" disabled={tournamentActive}
                style={{ width: 52, opacity: tournamentActive ? 0.4 : 1 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ ...s.fieldLabel, whiteSpace: 'nowrap' }}>Hit Video</span>
              <input
                ref={vjpVideoRef}
                type="file"
                accept="video/*"
                onChange={handleVjpVideoChange}
                style={{ display: 'none' }}
              />
              <button
                className="btn-neutral"
                style={{
                  fontSize: 10, padding: '2px 8px',
                  color: vjpVideoName ? '#5bb8ff' : 'var(--text-2)',
                  maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                title={vjpVideoName ?? 'No video selected'}
                onClick={() => vjpVideoRef.current?.click()}
                disabled={vjpVideoUploading}
              >
                {vjpVideoUploading ? '…' : vjpVideoName ? vjpVideoName : 'Browse…'}
              </button>
              {vjpVideoName && (
                <button
                  onClick={handleClearVjpVideo}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e06060', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
                  title="Remove video"
                >✕</button>
              )}
            </div>
          </>}
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

        {/* Round indicator */}
        {totalRounds > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11 }}>
            <span style={{ color: 'var(--text-2)', letterSpacing: '.06em' }}>SESSION:</span>
            <span style={{ color: 'var(--gold)', fontWeight: 700 }}>
              Round {tournamentActive ? roundsCompleted + 1 : (waitingNextRound ? roundsCompleted + 1 : 1)} / {totalRounds}
            </span>
            {isFinalRound && (
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '.12em',
                color: '#e8b84b', border: '1px solid #e8b84b44',
                padding: '2px 6px', borderRadius: 3,
              }}>FINAL ROUND</span>
            )}
          </div>
        )}

        {waitingNextRound ? (
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <button className="btn-start" disabled={busy} onClick={handleStart} style={{ flex: 1 }}>
              ▶  START ROUND {roundsCompleted + 1}
            </button>
            <button className="btn-neutral" disabled={busy} onClick={handleNewSession}>
              NEW SESSION
            </button>
          </div>
        ) : (
          <button
            className={`btn-start${tournamentActive ? ' running' : ''}`}
            disabled={busy || tournamentActive}
            onClick={handleStart}
          >
            {tournamentActive
              ? `▶  ROUND ${roundsCompleted + 1} RUNNING`
              : (sessionIdRef.current ? `START ROUND ${roundsCompleted + 1}` : 'START THE TOURNAMENT')
            }
          </button>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
          {tournamentActive && timeLeft !== null ? (
            <div style={{ fontSize: 11, color: timeLeft <= 30 ? '#e06060' : 'var(--text-2)' }}>
              <span style={{ letterSpacing: '.08em' }}>TIME LEFT </span>
              <span style={{
                fontFamily: 'Georgia, serif', fontSize: 18, fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                color: timeLeft <= 30 ? '#e06060' : 'var(--gold)',
              }}>
                {String(Math.floor(timeLeft / 60)).padStart(2, '0')}:{String(timeLeft % 60).padStart(2, '0')}
              </span>
            </div>
          ) : <div />}
          <button
            className={`btn-stop${tournamentActive ? ' active' : ''}`}
            disabled={!tournamentActive || busy}
            onClick={handleStop}
          >
            STOP
          </button>
        </div>
      </div>

      {/* ── D. Tabbed Panel ──────────────────────────────────── */}
      <div style={s.machineSection}>
        {/* Tab bar */}
        <div style={s.machineHeader}>
          <div style={{ display: 'flex', gap: 0 }}>
            {(['machines', 'history', 'players'] as const).map(tab => (
              <button
                key={tab}
                className="btn-neutral"
                onClick={() => setSideTab(tab)}
                style={{
                  fontWeight: sideTab === tab ? 700 : 400,
                  color: sideTab === tab ? 'var(--gold)' : 'var(--text-2)',
                  borderBottom: sideTab === tab ? '2px solid var(--gold)' : '2px solid transparent',
                  borderRadius: 0, paddingBottom: 4,
                  textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 10,
                }}
              >
                {tab === 'machines' ? `Machines (${connectedCount})` : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
          {sideTab === 'history' && (
            <button className="btn-neutral" style={{ fontSize: 10 }} onClick={loadHistory}>Refresh</button>
          )}
          {sideTab === 'players' && (
            <button className="btn-neutral" style={{ fontSize: 10 }} onClick={loadPlayers}>Refresh</button>
          )}
        </div>

        <div style={s.machineList}>
          {/* Machines tab */}
          {sideTab === 'machines' && (() => {
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

          {/* History tab */}
          {sideTab === 'history' && (
            <div style={{ padding: '10px 14px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, alignItems: 'start' }}>
              {history.length === 0 && <div style={s.empty}>No completed rounds yet</div>}
              {history
                .flatMap(session => session.rounds.map(round => ({ session, round })))
                .sort((a, b) => new Date(b.round.endedAt).getTime() - new Date(a.round.endedAt).getTime())
                .slice(0, 8)
                .map(({ session, round }) => {
                  const deduped = round.results.filter((r, i, arr) =>
                    arr.findIndex(x => x.machineId === r.machineId) === i
                  );
                  const endDt = round.endedAt ? new Date(round.endedAt) : null;
                  const endTime = endDt
                    ? endDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    : '—';
                  const endDate = endDt
                    ? `${endDt.getDate()}/${endDt.getMonth() + 1}`
                    : '';
                  const clr = sessionColor(session.sessionId);
                  return (
                    <div key={round.tournamentId} style={{ ...s.histCard, borderColor: clr + '50', borderLeftColor: clr, borderLeftWidth: 3 }}>
                      <div style={{ ...s.histCardHead, background: clr + '18' }}>
                        <div style={{ color: clr, fontWeight: 700, fontSize: 11, letterSpacing: '.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {session.sessionName}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 2, fontVariantNumeric: 'tabular-nums', letterSpacing: '.03em' }}>
                          Round {round.roundNumber}/{round.totalRounds} · {endDate} · {endTime}
                        </div>
                      </div>
                      {deduped.length === 0
                        ? <div style={{ color: 'var(--text-3)', fontSize: 10, padding: '8px 12px' }}>No results</div>
                        : deduped.map(r => {
                            const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : null;
                            const rankColor = r.rank === 1 ? 'var(--gold)' : r.rank === 2 ? '#C0C8D0' : r.rank === 3 ? '#D4904A' : 'var(--text-3)';
                            return (
                              <div key={r.machineId} style={s.histRow}>
                                <span style={{ width: 30, flexShrink: 0, color: rankColor, fontWeight: 700, fontSize: 13 }}>
                                  {medal ?? `#${r.rank}`}
                                </span>
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                                  {r.playerDisplay}
                                </span>
                                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 600, color: 'var(--text)', flexShrink: 0 }}>
                                  ${(r.finalScore / 100).toFixed(2)}
                                </span>
                              </div>
                            );
                          })
                      }
                      {/* Jackpot hits for this session */}
                      {(() => {
                        const hits = jackpotHits.filter(h => h.session_id === session.sessionId);
                        if (!hits.length) return null;
                        return (
                          <div style={{ borderTop: '1px solid rgba(91,184,255,0.15)', marginTop: 4 }}>
                            <div style={{ fontSize: 9, color: '#5bb8ff', letterSpacing: '.1em', padding: '4px 12px 2px', fontFamily: 'monospace' }}>
                              ⚡ JACKPOT HITS
                            </div>
                            {hits.map(h => {
                              const t = new Date(h.hit_at);
                              const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
                              return (
                                <div key={h.id} style={{ ...s.histRow, padding: '2px 12px' }}>
                                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {h.machine_id ?? '—'}
                                  </span>
                                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11, fontWeight: 700, color: '#5bb8ff', flexShrink: 0 }}>
                                    ${(Number(h.amount) / 100).toFixed(2)}
                                  </span>
                                  <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 6, flexShrink: 0 }}>{time}</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })
              }
            </div>
          )}

          {/* Players tab */}
          {sideTab === 'players' && (
            <div style={{ padding: '8px 16px' }}>
              {/* Add player form */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                <input
                  type="text" placeholder="Membership #"
                  value={newMembership} onChange={e => setNewMembership(e.target.value)}
                  style={{ width: 100 }}
                />
                <input
                  type="text" placeholder="Display Name"
                  value={newPlayerName} onChange={e => setNewPlayerName(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn-gold" onClick={handleAddPlayer}>ADD</button>
              </div>
              {players.length === 0 && <div style={s.empty}>No players registered</div>}
              {players.map(p => (
                <div key={p.membership_number} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 11,
                }}>
                  <span style={{ color: 'var(--gold)', width: 90, flexShrink: 0, fontFamily: 'monospace' }}>
                    {p.membership_number}
                  </span>
                  <span style={{ flex: 1, color: 'var(--text)' }}>{p.display_name || '—'}</span>
                  <button
                    className="btn-danger"
                    style={{ fontSize: 10, padding: '2px 7px' }}
                    onClick={() => handleDeletePlayer(p.membership_number)}
                  >
                    DEL
                  </button>
                </div>
              ))}
            </div>
          )}
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
        <span style={s.footerLogo}>JAKELIEDO · BRING IT TO LIFE</span>
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
  const dotCls = ['online', 'offline', 'locked', 'handpay', 'disabled', 'playing'].includes(st) ? `dot-${st}` : 'dot-offline';
  const hwEnabled = st !== 'disabled' && st !== 'offline';

  return (
    <div style={r.wrap}>
      <span style={r.mid}>{m.machine_id}</span>
      <span style={r.nameLabel}>Name</span>
      <input
        type="text"
        className="input-name"
        style={{ width: 190, flexShrink: 0 }}
        value={nameValue}
        onChange={e => onNameChange(e.target.value)}
        onBlur={e => onNameSave(e.target.value)}
        placeholder={m.machine_id}
      />
      <span style={r.ip}>{m.ip_address || '—'}</span>
      <span style={r.status}>
        <span className={`dot ${dotCls}`} />{m.status.toUpperCase()}
      </span>
      <span style={r.credits}>${credits}</span>
      <span style={{ ...r.enabled, color: hwEnabled ? 'var(--online)' : 'var(--text-3)' }}>
        {hwEnabled ? 'ENABLED' : 'DISABLED'}
      </span>
      <input
        type="number"
        className="input-buyin"
        style={{ width: 120, flexShrink: 0 }}
        value={buyIn}
        onChange={e => onBuyInChange(e.target.value)}
        placeholder="0"
        min="0" step="1"
      />
      <button className="btn-buyin" onClick={onBuyIn}>BUY-IN</button>
      <button
        className={enabled ? 'btn-disable' : 'btn-enable'}
        onClick={onToggleEnable}
      >
        {enabled ? 'DISABLE' : 'ENABLE'}
      </button>
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
  logoWrap: {
    background: '#fff', borderRadius: 8, padding: '3px 6px',
    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
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
    color: '#2d8820', fontWeight: 700, letterSpacing: '.14em', fontSize: 9,
    fontFamily: 'Arial, sans-serif',
  },
  histCard: {
    border: '1px solid rgba(200,168,75,.18)',
    borderRadius: 4,
    overflow: 'hidden',
    background: 'var(--surface)',
    alignSelf: 'start',
  },
  histCardHead: {
    display: 'flex', flexDirection: 'column',
    padding: '6px 10px',
    background: 'var(--surface-3)',
    borderBottom: '1px solid var(--border-2)',
  },
  histRoundBadge: {
    fontSize: 9, color: 'var(--text-2)', fontWeight: 700,
    background: 'var(--surface)', border: '1px solid var(--border-2)',
    borderRadius: 3, padding: '1px 6px', letterSpacing: '.06em',
  },
  histRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '4px 12px',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text)',
  },
};

const r: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 20px',
    borderBottom: '1px solid var(--border)',
  },
  mid:     { color: 'var(--gold)', fontWeight: 700, fontSize: 12, width: 52, flexShrink: 0 },
  ip:      { color: 'var(--text-2)', fontSize: 11, width: 80, flexShrink: 0 },
  status:  { fontSize: 11, width: 86, flexShrink: 0 },
  credits: {
    fontSize: 12, fontWeight: 600, width: 68, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums', color: 'var(--text)', flexShrink: 0,
  },
  enabled:   { fontSize: 11, fontWeight: 700, width: 64, flexShrink: 0 },
  nameLabel: { fontSize: 10, color: 'var(--text-3)', flexShrink: 0 },
};
