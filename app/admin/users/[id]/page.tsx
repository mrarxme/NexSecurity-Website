'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { relativeTime } from '@/lib/relativeTime';

type IpHistoryEntry = { ip: string; at: string };

type LikelySameDevice = {
  label: 'likely-same-device' | 'possibly-same-device' | 'different-device' | 'not-enough-data';
  score: number;
  matched_signals: string[];
  same_browser_fingerprint: boolean;
  matched_device_label: string | null;
} | null;

type Device = {
  id: string;
  device_id: string;
  ip_address: string;
  ip_history: IpHistoryEntry[];
  device_label: string;
  status: 'pending' | 'authorized' | 'restricted' | 'blocked';
  label: string | null;
  approved_by: string | null;
  approved_at: string | null;
  first_seen: string;
  last_seen: string;
  is_active: boolean;
  likely_same_device: LikelySameDevice;
};

// Human-readable names for the raw signal keys lib/deviceSimilarity.ts
// compares — shown to the admin so "Approve" isn't a leap of faith.
const SIGNAL_LABELS: Record<string, string> = {
  screen: 'screen size',
  color_depth: 'color depth',
  timezone: 'timezone',
  hardware_concurrency: 'CPU cores',
  device_memory: 'device memory',
  max_touch_points: 'touch support',
  platform: 'OS',
  languages: 'language',
};

/**
 * "Likely/possibly same device as X" hint for a pending device row —
 * see lib/deviceSimilarity.ts. Deliberately phrased as a hint to check,
 * never a claim of certainty: cookies are browser-scoped (one person
 * opening a second browser on the same laptop looks like a brand-new
 * device by device_id alone), and this compares hardware/OS signals
 * that stay constant across browsers on the same machine to surface
 * that possibility for a human to confirm — it never auto-approves.
 */
function SameDeviceHint({ match }: { match: LikelySameDevice }) {
  if (!match || match.label === 'not-enough-data' || match.label === 'different-device') return null;

  const isLikely = match.label === 'likely-same-device';
  const signalNames = match.matched_signals.map((s) => SIGNAL_LABELS[s] ?? s).join(', ');

  return (
    <p
      className={`mt-1 text-xs ${isLikely ? 'text-ok' : 'text-warn'}`}
      title={signalNames ? `Matched on: ${signalNames}` : undefined}
    >
      {isLikely ? 'Likely' : 'Possibly'} the same device as “{match.matched_device_label ?? 'an authorized device'}”
      {match.same_browser_fingerprint ? ' (same browser — cookie was probably cleared)' : ''}
      {signalNames ? ` · matched on ${signalNames}` : ''}
    </p>
  );
}

/**
 * How this device got its current status, in plain words — so an admin
 * doesn't have to dig through audit_logs just to see whether a device was
 * let in automatically or by a specific person. approved_by/approved_at
 * are only ever set by an admin decision (see the PATCH/POST routes) —
 * an authorized device with neither is the system's own first-device
 * auto-approval (see lib/auth.ts), never a person.
 */
function describeApproval(device: Device): string {
  const verb = device.status === 'authorized' ? 'Approved' : device.status === 'blocked' ? 'Blocked' : device.status === 'restricted' ? 'Rejected' : null;
  if (device.approved_by && verb) {
    return `${verb} by ${device.approved_by}${device.approved_at ? ` · ${relativeTime(device.approved_at)}` : ''}`;
  }
  if (device.status === 'authorized') return 'First device — auto-approved on sign-up';
  return 'Waiting for admin review';
}

type UserRow = {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'DISABLED';
  restrict_devices: boolean;
};

export default function UserDevicesPage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;

  const [user, setUser] = useState<UserRow | null>(null);
  const [pending, setPending] = useState<Device[]>([]);
  const [authorized, setAuthorized] = useState<Device[]>([]);
  const [restricted, setRestricted] = useState<Device[]>([]);
  const [blocked, setBlocked] = useState<Device[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [usersRes, devicesRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch(`/api/admin/users/${userId}/devices`),
    ]);
    const usersData = await usersRes.json();
    const devicesData = await devicesRes.json();
    if (usersRes.ok) {
      const found = (usersData.users as UserRow[]).find((u) => u.id === userId);
      setUser(found ?? null);
    }
    if (devicesRes.ok) {
      setPending(devicesData.pending);
      setAuthorized(devicesData.authorized);
      setRestricted(devicesData.restricted);
      setBlocked(devicesData.blocked);
      setActiveCount(devicesData.active_count);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (userId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function decide(rowId: string, status: 'authorized' | 'restricted' | 'blocked') {
    setBusy(rowId);
    setError(null);
    const res = await fetch(`/api/admin/users/${userId}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: rowId, status }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? 'Could not save decision.');
    setBusy(null);
    load();
  }

  async function rename(rowId: string, label: string) {
    setError(null);
    const res = await fetch(`/api/admin/users/${userId}/devices/${rowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || null }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? 'Could not rename.');
    load();
  }

  async function remove(rowId: string) {
    setBusy(rowId);
    setError(null);
    const res = await fetch(`/api/admin/users/${userId}/devices/${rowId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? 'Could not remove.');
    setBusy(null);
    load();
  }

  return (
    <div>
      <Link
        href="/admin/users"
        className="font-mono text-[11px] uppercase tracking-widest text-ink-dim transition hover:text-ink"
      >
        ← Users
      </Link>
      <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.2em] text-signal-glow">Admin</p>
      <h1 className="mt-2 font-display text-2xl font-semibold text-ink">
        {loading ? 'Loading…' : user?.email ?? 'User'}
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-dim">
        Unlimited devices per account — but every new device needs your approval before it can
        sign in. Devices are identified by a persistent id, not IP address, so a phone switching
        from wifi to mobile data stays the same device instead of triggering a new request. IP is
        kept as history only, for your review.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!loading && user?.restrict_devices && (
          <p className="inline-flex items-center gap-2 rounded-full border border-signal/30 bg-signal/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-signal">
            Restriction active
          </p>
        )}
        {!loading && (
          <p className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-900 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
            {activeCount} active session{activeCount === 1 ? '' : 's'}
          </p>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      <Section title="New Device Requests" emptyText="No pending sign-in attempts.">
        {pending.map((d) => (
          <div
            key={d.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-vault-border bg-vault-900 px-4 py-3 backdrop-blur-xl"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">{d.device_label}</p>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                {d.ip_address} · first seen {relativeTime(d.first_seen)}
              </p>
              <p className="mt-0.5 text-xs text-ink-faint">Waiting for admin review</p>
              <SameDeviceHint match={d.likely_same_device} />
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                disabled={busy === d.id}
                onClick={() => decide(d.id, 'authorized')}
                className="rounded-md bg-signal px-3 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-50"
              >
                Approve
              </button>
              <button
                disabled={busy === d.id}
                onClick={() => decide(d.id, 'restricted')}
                className="rounded-md border border-danger/30 px-2.5 py-1 text-xs text-danger transition hover:bg-danger/10 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Authorized Devices" emptyText="No authorized devices yet.">
        {authorized.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            busy={busy === d.id}
            onRename={(label) => rename(d.id, label)}
            actions={
              <div className="flex gap-2">
                <button
                  disabled={busy === d.id}
                  onClick={() => decide(d.id, 'restricted')}
                  className="rounded-md border border-danger/30 px-2.5 py-1 text-xs text-danger transition hover:bg-danger/10 disabled:opacity-50"
                  title="Revoke — this device will need to be re-approved to sign in again"
                >
                  Revoke
                </button>
                <button
                  disabled={busy === d.id}
                  onClick={() => decide(d.id, 'blocked')}
                  className="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger transition hover:bg-danger/10 disabled:opacity-50"
                  title="Block — deny this device permanently, without opening it back up for reconsideration"
                >
                  Block
                </button>
              </div>
            }
          />
        ))}
      </Section>

      <Section title="Rejected Devices" emptyText="No rejected devices.">
        {restricted.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            busy={busy === d.id}
            onRename={(label) => rename(d.id, label)}
            actions={
              <div className="flex gap-2">
                <button
                  disabled={busy === d.id}
                  onClick={() => decide(d.id, 'authorized')}
                  className="rounded-md bg-signal px-3 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  disabled={busy === d.id}
                  onClick={() => remove(d.id)}
                  className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:text-ink disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            }
          />
        ))}
      </Section>

      <Section title="Blocked Devices" emptyText="No blocked devices.">
        {blocked.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            busy={busy === d.id}
            onRename={(label) => rename(d.id, label)}
            actions={
              <div className="flex gap-2">
                <button
                  disabled={busy === d.id}
                  onClick={() => decide(d.id, 'authorized')}
                  className="rounded-md bg-signal px-3 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-50"
                >
                  Unblock
                </button>
                <button
                  disabled={busy === d.id}
                  onClick={() => remove(d.id)}
                  className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:text-ink disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            }
          />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  emptyText,
  children,
}: {
  title: string;
  emptyText: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  const isEmpty = items.flat().length === 0;
  return (
    <div className="mt-8">
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">{title}</p>
      {isEmpty ? (
        <p className="mt-3 rounded-xl border border-dashed border-vault-border p-6 text-center text-sm text-ink-faint">
          {emptyText}
        </p>
      ) : (
        <div className="mt-3 space-y-2">{children}</div>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  actions,
  onRename,
}: {
  device: Device;
  busy: boolean;
  actions: React.ReactNode;
  onRename: (label: string) => void;
}) {
  const [label, setLabel] = useState(device.label ?? '');
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  function save() {
    setEditing(false);
    if (label !== (device.label ?? '')) onRename(label);
  }

  const history = [...(device.ip_history ?? [])].reverse();

  return (
    <div className="rounded-xl border border-vault-border bg-vault-900 px-4 py-3 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {editing ? (
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                placeholder="Name this device (e.g. Home laptop)"
                className="w-full rounded-md border border-vault-border bg-vault-800/70 px-2 py-1 text-sm text-ink outline-none focus:border-signal"
              />
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="text-left text-sm text-ink hover:underline"
                title="Click to rename"
              >
                {device.label || device.device_label}
              </button>
            )}
            {device.is_active && (
              <span className="inline-flex items-center gap-1 rounded-full border border-signal/30 bg-signal/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-signal">
                Active
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            {device.device_label} · {device.ip_address} · last seen {relativeTime(device.last_seen)}
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">{describeApproval(device)}</p>
          {history.length > 0 && (
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint underline-offset-2 hover:text-ink hover:underline"
            >
              {historyOpen ? 'Hide' : 'Show'} IP history ({history.length})
            </button>
          )}
          {historyOpen && (
            <ul className="mt-2 space-y-0.5 border-l border-vault-border pl-3">
              {history.map((entry, i) => (
                <li key={i} className="font-mono text-[10px] text-ink-faint">
                  {entry.ip} · {relativeTime(entry.at)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="shrink-0">{actions}</div>
      </div>
    </div>
  );
}
