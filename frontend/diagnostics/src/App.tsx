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

// `wide`: lay the section's own Rows out as a multi-column grid instead of
// a single stacked column -- for a section with many rows (Enabled
// Features) given the full window width, so it uses that width instead of
// turning into one long vertical list on a wide monitor.
function Section({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, height: '100%' }}>
      <div style={{
        fontSize: 15, fontWeight: 700, letterSpacing: '.14em', color: 'var(--gold)',
        borderBottom: '1px solid var(--border)', padding: '7px 14px', textTransform: 'uppercase',
      }}>
        {title}
      </div>
      <div style={wide ? {
        padding: '8px 20px', display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        columnGap: 32,
      } : { padding: '6px 14px' }}>
        {children}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 16, padding: '5px 0', borderBottom: '1px solid var(--border-2)',
      fontSize: 17,
    }}>
      <span style={{ color: 'var(--text-2)' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function MachineDetail({ m }: { m: Machine }) {
  const features = m.enabled_features;
  const validationStyle = features != null ? (features >> 5) & 0x03 : null;
  const meterModel = features != null ? (features >> 8) & 0x03 : null;

  return (
    <>
      <div style={{
        display: 'grid', gap: 16, alignItems: 'start', marginBottom: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
      }}>
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
          <Row label="Slot Door">
            {m.door_open == null ? <Value state="unknown" /> : m.door_open ? (
              <span style={{ color: 'var(--handpay)', fontWeight: 700 }}>OPEN</span>
            ) : (
              <span style={{ color: 'var(--online)', fontWeight: 700 }}>CLOSED</span>
            )}
          </Row>
          <Row label="Bill Validator (LP 0x06/0x07)">
            <Value state={tri(m.bv_enabled)} yes="ENABLED" no="DISABLED" />
          </Row>
          <Row label="Ticket Printer (LP 0x7B)">
            <Value state={tri(m.printer_enabled)} yes="ENABLED" no="DISABLED" />
          </Row>
          <Row label="RTE Reporting OFF Guard (LP 0x0E)"><Value state={tri(m.rte_guard_ok)} yes="OFF (OK)" no="FAILED" /></Row>
          <Row label="Bill Config Write ACK'd (LP 0x08)"><Value state={tri(m.bill_config_ok)} yes="OK" no="FAILED" /></Row>
          <Row label="Cash Out Limit (LP 0xA4, hopper only)">
            {m.cash_out_limit_cents != null ? `$${(m.cash_out_limit_cents / 100).toFixed(2)}` : <Value state="unknown" />}
          </Row>
          <Row label="AFT Transfer Limit (LP 0x74)">
            {m.aft_transfer_limit_cents != null ? `$${(m.aft_transfer_limit_cents / 100).toFixed(2)}` : <Value state="unknown" />}
          </Row>
          <Row label="Poll Cycle (40ms budget)">
            {m.last_cycle_overrun_ms ? (
              <span style={{ color: 'var(--disabled)', fontWeight: 700 }}>{m.last_cycle_overrun_ms}ms OVERRUN</span>
            ) : (
              <Value state="yes" yes="OK" />
            )}
          </Row>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
            Cash Out Limit = máy trả tối đa bao nhiêu <em>từ hopper xu</em> (SAS Table 7.16) —
            $0.00 là bình thường trên máy TITO không có hopper vật lý, không phải lỗi đọc dữ liệu.
            AFT Transfer Limit (LP 0x74) mới là số quyết định 1 lần trả AFT có bị từ chối
            (status 0x84, phải chuyển sang handpay) hay không.
          </div>
        </Section>
      </div>

      <Section title="Enabled Features (LP 0xA0) — full bit breakdown" wide>
        {features == null ? (
          <div style={{ color: 'var(--text-3)', fontSize: 16, padding: '4px 0' }}>Not yet queried — press Refresh</div>
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
    <div style={{ maxWidth: 1800, margin: '0 auto', padding: '20px 32px 40px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 20,
        marginBottom: 20,
      }}>
        <h1 style={{ fontSize: 24, letterSpacing: '.1em', color: 'var(--gold)', whiteSpace: 'nowrap' }}>
          MACHINE DIAGNOSTICS
        </h1>

        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value)}
          style={{
            padding: '9px 14px', minWidth: 320,
            background: 'var(--surface-3)', color: 'var(--text)',
            border: '1px solid var(--border-2)', borderRadius: 4,
            fontFamily: 'inherit', fontSize: 18,
          }}
        >
          {machines.length === 0 && <option value="">No machines connected</option>}
          {machines.map(m => (
            <option key={m.machine_id} value={m.machine_id}>
              {m.machine_id}{m.display_name ? ` — ${m.display_name}` : ''} [{m.status}]
            </option>
          ))}
        </select>

        {selected && (
          <>
            <span style={{ fontSize: 16, color: 'var(--text-3)', marginLeft: 'auto' }}>
              Last updated: {new Date(selected.updated_at).toLocaleString()}
            </span>
            <button disabled={busy} onClick={doRefresh}>{busy ? 'Refreshing…' : 'Refresh This Machine'}</button>
          </>
        )}
      </div>

      {selected ? (
        <MachineDetail m={selected} />
      ) : (
        <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 40 }}>No machine selected</div>
      )}
    </div>
  );
}
