'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { SearchInput } from '@/components/SearchInput';
import { Modal } from '@/components/Modal';
import { BoardMultiSelect } from '@/components/BoardMultiSelect';
import { orderBoardsHierarchically } from '@/lib/boardTree';

type AuthorizedUser = {
  id: string;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'DISABLED';
  restrict_devices: boolean;
  account_type: 'paid' | 'trial';
  trial_duration_minutes: number | null;
  trial_started_at: string | null;
  trial_expires_at: string | null;
  created_at: string;
};

const TRIAL_DURATIONS = [5, 10, 15, 20] as const;

/** What the admin panel shows for a user — their saved name if there is
 * one, their email otherwise. Nothing about auth reads `name` (see
 * migration 0012); this is purely so the users table and edit modal
 * aren't just a wall of email addresses. */
function displayName(user: Pick<AuthorizedUser, 'name' | 'email'>): string {
  return user.name?.trim() || user.email;
}

/** Human summary of a trial account's clock, for the users table badge
 * and the edit modal — "not started yet", "expires in 7m", or "expired". */
function describeTrial(user: AuthorizedUser): string {
  if (!user.trial_started_at) return `Trial · not started (${user.trial_duration_minutes}m)`;
  const msLeft = new Date(user.trial_expires_at!).getTime() - Date.now();
  if (msLeft <= 0) return 'Trial · expired';
  const minutesLeft = Math.ceil(msLeft / 60_000);
  return `Trial · expires in ${minutesLeft}m`;
}

type Board = { id: string; title: string; parent_id: string | null; visibility: 'universal' | 'restricted' };

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AuthorizedUser[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'USER' | 'ADMIN'>('USER');
  const [newAccountType, setNewAccountType] = useState<'paid' | 'trial'>('paid');
  const [newTrialDuration, setNewTrialDuration] = useState<number>(10);
  const [newUserAccess, setNewUserAccess] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [enforcing, setEnforcing] = useState(false);
  const [enforceResult, setEnforceResult] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filteredUsers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (u) => u.email.toLowerCase().includes(needle) || (u.name?.toLowerCase().includes(needle) ?? false)
    );
  }, [users, search]);

  const restrictedOrdered = useMemo(
    () => orderBoardsHierarchically(boards).filter((b) => b.visibility === 'restricted'),
    [boards]
  );

  const editingUser = useMemo(() => users.find((u) => u.id === editingId) ?? null, [users, editingId]);

  async function load() {
    setLoading(true);
    const [usersRes, boardsRes] = await Promise.all([fetch('/api/admin/users'), fetch('/api/admin/boards')]);
    const usersData = await usersRes.json();
    const boardsData = await boardsRes.json();
    if (usersRes.ok) setUsers(usersData.users);
    if (boardsRes.ok) setBoards(boardsData.boards);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: newEmail,
        name: newName || undefined,
        role: newRole,
        account_type: newAccountType,
        trial_duration_minutes: newAccountType === 'trial' ? newTrialDuration : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Could not add user.');
      setAdding(false);
      return;
    }
    // Board access can be defined right here at creation time — no need
    // to save the user first, then separately open every restricted
    // board just to add them.
    if (newRole !== 'ADMIN' && newUserAccess.size > 0) {
      const email = newEmail.trim().toLowerCase();
      for (const boardId of newUserAccess) {
        const existingRes = await fetch(`/api/admin/boards/${boardId}/access`);
        const existingData = await existingRes.json();
        const existingEmails: string[] = existingRes.ok ? existingData.emails ?? [] : [];
        await fetch(`/api/admin/boards/${boardId}/access`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: Array.from(new Set([...existingEmails, email])) }),
        });
      }
    }
    setNewEmail('');
    setNewName('');
    setNewRole('USER');
    setNewAccountType('paid');
    setNewTrialDuration(10);
    setNewUserAccess(new Set());
    setAdding(false);
    load();
  }

  async function updateUser(id: string, patch: Partial<Pick<AuthorizedUser, 'name' | 'role' | 'status' | 'restrict_devices'>>) {
    setBusyId(id);
    setError(null);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? 'Could not update user.');
    setBusyId(null);
    load();
  }

  async function removeUser(id: string) {
    if (!confirm('Remove this user\'s access? This cannot be undone.')) return;
    setBusyId(id);
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? 'Could not remove user.');
    setBusyId(null);
    load();
  }

  async function enforceDeviceRestriction() {
    if (
      !confirm(
        'Turn on device approval for every account right now?\n\n' +
          'Everyone else currently signed in will be blocked from the app on their ' +
          'very next click, until you approve a device for them from the Devices ' +
          'page. This device (the one you\'re using right now) is auto-approved, ' +
          'so you won\'t be locked out yourself.'
      )
    )
      return;
    setEnforcing(true);
    setError(null);
    setEnforceResult(null);
    const res = await fetch('/api/admin/users/enforce-devices', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Could not enforce device restriction.');
    } else {
      setEnforceResult(
        data.updated === 0
          ? 'Everyone already required device approval — nothing to change.'
          : `Done — ${data.updated} account${data.updated === 1 ? '' : 's'} now require device approval.`
      );
    }
    setEnforcing(false);
    load();
  }

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-signal-glow">Admin</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-ink">Authorized users</h1>
        <button
          onClick={enforceDeviceRestriction}
          disabled={enforcing}
          className="rounded-md border border-signal/30 bg-signal/10 px-3 py-1.5 text-xs font-medium text-signal transition hover:bg-signal/20 disabled:opacity-50"
          title="Turn on device approval for every account and block everyone until their device is approved"
        >
          {enforcing ? 'Working…' : 'Require device approval for everyone'}
        </button>
      </div>
      {enforceResult && <p className="mt-2 text-xs text-ok">{enforceResult}</p>}

      <form
        onSubmit={addUser}
        className="mt-6 grid grid-cols-1 gap-3 rounded-xl border border-vault-border bg-vault-900 p-5 backdrop-blur-xl shadow-glass sm:grid-cols-2"
      >
        <div>
          <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Email</label>
          <input
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="person@company.com"
            className="mt-1 w-full rounded-md border border-vault-border bg-vault-800 px-3 py-2 text-sm text-ink outline-none focus:border-signal"
          />
        </div>
        <div>
          <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            Name (optional)
          </label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="So you can find them by name later, not just email"
            className="mt-1 w-full rounded-md border border-vault-border bg-vault-800 px-3 py-2 text-sm text-ink outline-none focus:border-signal"
          />
        </div>
        <div>
          <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Role</label>
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as 'USER' | 'ADMIN')}
            className="mt-1 w-full rounded-md border border-vault-border bg-vault-800 px-3 py-2 text-sm text-ink outline-none focus:border-signal"
          >
            <option value="USER">USER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </div>
        {newRole !== 'ADMIN' && (
          <>
            <div>
              <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Account type</label>
              <select
                value={newAccountType}
                onChange={(e) => setNewAccountType(e.target.value as 'paid' | 'trial')}
                className="mt-1 w-full rounded-md border border-vault-border bg-vault-800 px-3 py-2 text-sm text-ink outline-none focus:border-signal"
              >
                <option value="paid">Paid — normal account</option>
                <option value="trial">Free Trial</option>
              </select>
            </div>
            {newAccountType === 'trial' && (
              <div>
                <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Trial length</label>
                <select
                  value={newTrialDuration}
                  onChange={(e) => setNewTrialDuration(Number(e.target.value))}
                  className="mt-1 w-full rounded-md border border-vault-border bg-vault-800 px-3 py-2 text-sm text-ink outline-none focus:border-signal"
                >
                  {TRIAL_DURATIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-ink-faint">
                  Starts counting down from their first login, not from now — the account can sit
                  unused for days and their {newTrialDuration} minutes only begin once they actually
                  sign in.
                </p>
              </div>
            )}
          </>
        )}
        {newRole !== 'ADMIN' && restrictedOrdered.length > 0 && (
          <div className="sm:col-span-2">
            <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              Give access to restricted boards (optional — you can also do this later from Edit or Access)
            </label>
            <div className="mt-1">
              <BoardMultiSelect boards={boards} restrictedOrdered={restrictedOrdered} selected={newUserAccess} onChange={setNewUserAccess} />
            </div>
          </div>
        )}
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={adding}
            className="rounded-md bg-signal px-4 py-2 text-sm font-medium text-white transition hover:bg-signal-glow disabled:opacity-60"
          >
            {adding ? 'Adding…' : 'Add user'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      {users.length > 5 && (
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or email…" className="mt-4 max-w-sm" />
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-vault-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-vault-900 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-faint">
                  Loading…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-faint">
                  No authorized users yet.
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-faint">
                  No users match &ldquo;{search}&rdquo;.
                </td>
              </tr>
            ) : (
              filteredUsers.map((u) => (
                <tr key={u.id} className="border-t border-vault-border bg-vault-900/50">
                  <td className="px-4 py-3 text-ink">
                    <div>{displayName(u)}</div>
                    {u.name && <div className="mt-0.5 font-mono text-[10px] text-ink-faint">{u.email}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-ink-dim">{u.role}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`font-mono text-[10px] uppercase tracking-widest ${u.status === 'ACTIVE' ? 'text-ok' : 'text-danger'}`}>
                      {u.status}
                    </span>
                    {u.restrict_devices && (
                      <span className="ml-2 rounded-full border border-signal/30 bg-signal/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-signal">
                        Restricted
                      </span>
                    )}
                    {u.account_type === 'trial' && (
                      <span className="ml-2 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-warn">
                        {describeTrial(u)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingId(u.id)}
                        className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
                      >
                        Edit
                      </button>
                      <button
                        disabled={busyId === u.id}
                        onClick={() => removeUser(u.id)}
                        className="rounded-md border border-danger/30 px-2.5 py-1 text-xs text-danger transition hover:bg-danger/10 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editingUser && (
        <Modal title={displayName(editingUser)} subtitle="Edit user" onClose={() => setEditingId(null)}>
          <UserEditPanel
            user={editingUser}
            boards={boards}
            restrictedOrdered={restrictedOrdered}
            onUpdate={updateUser}
            onError={setError}
            busy={busyId === editingUser.id}
          />
        </Modal>
      )}
    </div>
  );
}

function UserEditPanel({
  user,
  boards,
  restrictedOrdered,
  onUpdate,
  onError,
  busy,
}: {
  user: AuthorizedUser;
  boards: Board[];
  restrictedOrdered: ReturnType<typeof orderBoardsHierarchically<Board>>;
  onUpdate: (id: string, patch: Partial<Pick<AuthorizedUser, 'name' | 'role' | 'status' | 'restrict_devices'>>) => void;
  onError: (msg: string) => void;
  busy: boolean;
}) {
  const [initialGranted, setInitialGranted] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(user.name ?? '');

  // The edit modal is remounted fresh each time it opens (editingUser
  // changes), but React can still reuse this component instance if the
  // same modal briefly re-renders with updated user data (e.g. right
  // after saving) — resync the draft so it doesn't show stale text.
  useEffect(() => {
    setNameDraft(user.name ?? '');
  }, [user.id, user.name]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingAccess(true);
      const res = await fetch(`/api/admin/access-summary?email=${encodeURIComponent(user.email)}`);
      const data = await res.json();
      if (cancelled) return;
      if (res.ok) {
        const ids = new Set((data.grantedBoardIds ?? []) as string[]);
        setInitialGranted(ids);
        setChecked(ids);
      }
      setLoadingAccess(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user.email]);

  const changedIds = useMemo(() => {
    const changed: string[] = [];
    for (const b of restrictedOrdered) {
      if (checked.has(b.id) !== initialGranted.has(b.id)) changed.push(b.id);
    }
    return changed;
  }, [checked, initialGranted, restrictedOrdered]);

  async function saveAccess() {
    if (changedIds.length === 0) return;
    setSaving(true);
    setSaveResult(null);
    try {
      for (const boardId of changedIds) {
        const existingRes = await fetch(`/api/admin/boards/${boardId}/access`);
        const existingData = await existingRes.json();
        const existingEmails: string[] = existingRes.ok ? existingData.emails ?? [] : [];
        const willGrant = checked.has(boardId);
        const nextEmails = willGrant
          ? Array.from(new Set([...existingEmails, user.email]))
          : existingEmails.filter((e) => e.toLowerCase() !== user.email.toLowerCase());
        await fetch(`/api/admin/boards/${boardId}/access`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: nextEmails }),
        });
      }
      setInitialGranted(new Set(checked));
      setSaveResult(`Updated ${changedIds.length} board${changedIds.length === 1 ? '' : 's'}.`);
    } catch {
      onError('Something went wrong partway through saving this user\u2019s access — please check and try again.');
    }
    setSaving(false);
  }

  return (
    <div className="space-y-5">
      {user.account_type === 'trial' && (
        <div className="rounded-md border border-warn/30 bg-warn/10 p-2.5 text-xs text-ink-dim">
          <p>{describeTrial(user)}</p>
          {user.status === 'DISABLED' && user.trial_expires_at && new Date(user.trial_expires_at).getTime() <= Date.now() && (
            <p className="mt-1 text-ink-faint">
              This trial ran out and was auto-disabled. Clicking <strong className="text-ink">Enable</strong> below
              removes the cutoff entirely — it won&rsquo;t re-disable on its own again.
            </p>
          )}
        </div>
      )}
      <div>
        <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Name</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={user.email}
            className="w-full rounded-md border border-vault-border bg-vault-800 px-3 py-2 text-sm text-ink outline-none focus:border-signal"
          />
          <button
            disabled={busy || nameDraft.trim() === (user.name ?? '')}
            onClick={() => onUpdate(user.id, { name: nameDraft.trim() })}
            className="shrink-0 rounded-md bg-signal px-3 py-2 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-50"
          >
            Save
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          Shown instead of the email everywhere in the admin panel — the email itself never
          changes and always stays underneath, so nothing else about the account is affected.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          disabled={busy}
          onClick={() => onUpdate(user.id, { role: user.role === 'ADMIN' ? 'USER' : 'ADMIN' })}
          className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink disabled:opacity-50"
        >
          {user.role === 'ADMIN' ? 'Make USER' : 'Make ADMIN'}
        </button>
        <button
          disabled={busy}
          onClick={() => onUpdate(user.id, { status: user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}
          className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink disabled:opacity-50"
        >
          {user.status === 'ACTIVE' ? 'Disable' : 'Enable'}
        </button>
        <button
          disabled={busy}
          onClick={() => onUpdate(user.id, { restrict_devices: !user.restrict_devices })}
          className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink disabled:opacity-50"
        >
          {user.restrict_devices ? 'Remove device restriction' : 'Require device approval'}
        </button>
        <Link
          href={`/admin/users/${user.id}`}
          className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
        >
          Manage devices
        </Link>
      </div>

      {user.role === 'ADMIN' ? (
        <p className="text-xs text-ink-faint">Admins always have access to every board — there&rsquo;s nothing to grant here.</p>
      ) : (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Restricted-board access</p>
          {loadingAccess ? (
            <p className="mt-2 text-xs text-ink-faint">Loading…</p>
          ) : (
            <div className="mt-2">
              <BoardMultiSelect boards={boards} restrictedOrdered={restrictedOrdered} selected={checked} onChange={setChecked} />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={saveAccess}
                  disabled={saving || changedIds.length === 0}
                  className="rounded-md bg-signal px-3 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-50"
                >
                  {saving ? 'Saving…' : changedIds.length === 0 ? 'No changes' : `Save ${changedIds.length} change${changedIds.length === 1 ? '' : 's'}`}
                </button>
                {saveResult && <span className="text-xs text-ok">{saveResult}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
