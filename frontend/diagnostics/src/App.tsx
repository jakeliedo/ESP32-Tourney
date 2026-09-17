import { useState, useEffect, useCallback, useMemo } from 'react';
import { getMachines, refreshDiagnostics, Machine } from './services/api';

// ── SAS 6.02 LP 0xA0 "Send Enabled Features" bit tables (Tables 7.14c/d/e) ──
// Combined bit position = table bit number + 0 (Features1) / 8 (Features2)
// / 16 (Features3), matching sas_parse_enabled_features()'s packing in
// firmware/src/sas/sas_commands.cpp.
const FEATURE_BITS: { bit: number; label: string }[] = [
  { bit: 0,  label: 'Jackpot multiplier' },
  { bit: 1,  label: 'AFT bonus awards' },
  { bit: 2,  label: 'Legacy bonus awards' },
  { bit: 3,  label: 'Tournament' },
  { bit: 4,  label: 'Validation extensions' },
  { bit: 7,  label: 'Ticket redemption' },
  { bit: 10, label: 'Tickets counted in drop/cancelled credits' },
  { bit: 11, label: 'Extended meters' },
  { bit: 12, label: 'Component Authentication' },
  { bit: 14, label: 'Advanced Funds Transfer (AFT)' },
  { bit: 15, label: 'Multi-denomination extensions' },
  { bit: 16, label: 'Guarantees 40ms poll rate' },
  { bit: 17, label: 'Multiple SAS progressive win reporting (LP 0x87)' },
];
const VALIDATION_STYLES: Record<number, string> = {
  0: 'Standard / none', 1: 'System', 2: 'Secure Enhanced', 3: 'Reserved',
};
const METER_MODELS: Record<number, string> = {
  0: 'Not specified', 1: 'Won when won', 2: 'Won when played/paid', 3: 'Reserved',
};

type TriState = 'yes' | 'no' | 'unknown';

function tri(v: boolean | null | undefined): TriState {
  return v == null ? 'unknown' : v ? 'yes' : 'no';
}

function Value({ state, yes = 'YES', no = 'NO' }: { state: TriState; yes?: string; no?: string }) {
  const color = state === 'yes' ? 'var(--online)' : state === 'no' ? 'var(--handpay)' : 'var(--text-3)';
  const label = state === 'yes' ? yes : state === 'no' ? no : '— unknown —';
  return <span style={{ color, fontWeight: 700 }}>{label}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginBottom: 12 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: 'var(--gold)',
        borderBottom: '1px solid var(--border)', padding: '6px 12px', textTransform: 'uppercase',
      }}>
        {title}
      </div>
      <div style={{ padding: '8px 12px' }}>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 12, padding: '4px 0', borderBottom: '1px solid var(--border-2)',
      fontSize: 13,
    }}>
      <span style={{ color: 'var(--text-2)' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function MachineDetail({ m, onRefresh, busy }: { m: Machine; onRefresh: () => void; busy: boolean }) {
  const features = m.enabled_features;
  const validationStyle = features != null ? (features >> 5) & 0x03 : null;
  const meterModel = features != null ? (features >> 8) & 0x03 : null;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          Last updated: {new Date(m.updated_at).toLocaleString()}
        </span>
        <button disabled={busy} onClick={onRefresh}>{busy ? 'Refreshing…' : 'Refresh This Machine'}</button>
      </div>

      <Section title="Identity">
        <Row label="Machine ID">{m.machine_id}</Row>
        <Row label="Display Name">{m.display_name || '—'}</Row>
        <Row label="SAS Version">{m.sas_version || <Value state="unknown" />}</Row>
        <Row label="Serial Number">{m.serial_number || <Value state="unknown" />}</Row>
        <Row label="Asset Number (LP 0x73)">{m.asset_number ?? <Value state="unknown" />}</Row>
        <Row label="AFT Registered"><Value state={tri(m.aft_registered)} /></Row>
      </Section>

      <Section title="Denomination (LP 0x1F)">
        <Row label="Denom Code">{m.denom_code != null ? `0x${m.denom_code.toString(16).padStart(2, '0').toUpperCase()}` : <Value state="unknown" />}</Row>
        <Row label="Denom Value">
          {m.denom_value_x10000 ? `$${(m.denom_value_x10000 / 10000).toFixed(4)}` : <Value state="unknown" />}
        </Row>
      </Section>

      <Section title="Live State">
        <Row label="Status">{m.status.toUpperCase()}</Row>
        <Row label="Credits">${(m.credits / 100).toFixed(2)}</Row>
        <Row label="Coin In">{m.coin_in.toLocaleString()}</Row>
        <Row label="Coin Out">{m.coin_out.toLocaleString()}</Row>
      </Section>

      <Section title="Guards / Config Checks">
        <Row label="Bill Validator Enabled (LP 0x06/0x07)"><Value state={tri(m.bv_enabled)} /></Row>
        <Row label="Printer/Ticket Locked Down (LP 0x7B)">
          <Value state={tri(m.printer_enabled)} yes="UNLOCKED" no="LOCKED (expected)" />
        </Row>
        <Row label="RTE Reporting OFF Guard (LP 0x0E)"><Value state={tri(m.rte_guard_ok)} yes="OFF (OK)" no="FAILED" /></Row>
        <Row label="Bill Config Write ACK'd (LP 0x08)"><Value state={tri(m.bill_config_ok)} yes="OK" no="FAILED" /></Row>
        <Row label="Cash Out Limit (LP 0xA4)">
          {m.cash_out_limit_cents != null ? `$${(m.cash_out_limit_cents / 100).toFixed(2)}` : <Value state="unknown" />}
        </Row>
        <Row label="Poll Cycle (40ms budget)">
          {m.last_cycle_overrun_ms ? (
            <span style={{ color: 'var(--disabled)', fontWeight: 700 }}>{m.last_cycle_overrun_ms}ms OVERRUN</span>
          ) : (
            <Value state="yes" yes="OK" />
          )}
        </Row>
      </Section>

      <Section title="Enabled Features (LP 0xA0) — full bit breakdown">
        {features == null ? (
          <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '4px 0' }}>Not yet queried — press Refresh</div>
        ) : (
          <>
            <Row label="Raw value">0x{features.toString(16).toUpperCase().padStart(6, '0')}</Row>
            <Row label="Validation style">{VALIDATION_STYLES[validationStyle ?? 0]}</Row>
            <Row label="Meter model">{METER_MODELS[meterModel ?? 0]}</Row>
            {FEATURE_BITS.map(({ bit, label }) => (
              <Row key={bit} label={label}>
                <Value state={(features & (1 << bit)) ? 'yes' : 'no'} yes="✓" no="✗" />
              </Row>
            ))}
          </>
        )}
      </Section>
    </>
  );
}

export default function App() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getMachines().then(list => {
      setMachines(list);
      setSelectedId(prev => prev && list.some(m => m.machine_id === prev) ? prev : (list[0]?.machine_id ?? ''));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 3000);
    return () => clearInterval(iv);
  }, [load]);

  const selected = useMemo(
    () => machines.find(m => m.machine_id === selectedId) ?? null,
    [machines, selectedId],
  );

  const doRefresh = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await refreshDiagnostics(selectedId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px' }}>
      <h1 style={{ fontSize: 15, letterSpacing: '.1em', color: 'var(--gold)', marginBottom: 14 }}>
        MACHINE DIAGNOSTICS
      </h1>

      <select
        value={selectedId}
        onChange={e => setSelectedId(e.target.value)}
        style={{
          width: '100%', padding: '10px 12px', marginBottom: 16,
          background: 'var(--surface-3)', color: 'var(--text)',
          border: '1px solid var(--border-2)', borderRadius: 4,
          fontFamily: 'inherit', fontSize: 14,
        }}
      >
        {machines.length === 0 && <option value="">No machines connected</option>}
        {machines.map(m => (
          <option key={m.machine_id} value={m.machine_id}>
            {m.machine_id}{m.display_name ? ` — ${m.display_name}` : ''} [{m.status}]
          </option>
        ))}
      </select>

      {selected ? (
        <MachineDetail m={selected} onRefresh={doRefresh} busy={busy} />
      ) : (
        <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 40 }}>No machine selected</div>
      )}
    </div>
  );
}
