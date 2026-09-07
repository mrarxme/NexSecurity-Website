'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ThumbnailUpload } from '@/components/ThumbnailUpload';
import { SearchInput } from '@/components/SearchInput';
import { Modal } from '@/components/Modal';
import { CascadingBoardSelect } from '@/components/CascadingBoardSelect';
import { UserMultiSelect, type SelectableUser } from '@/components/UserMultiSelect';
import {
  ancestorTitles,
  buildBoardTree,
  idsWithChildren,
  orderBoardsHierarchically,
  subtreeIds,
  type BoardNode,
} from '@/lib/boardTree';

type Board = {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  parent_id: string | null;
  published: boolean;
  sort_order: number;
  board_type: 'normal' | 'routine';
  routine_image_url: string | null;
  visibility: 'universal' | 'restricted';
};

type AdminUser = { email: string; role: 'USER' | 'ADMIN' };

export default function AdminBoardsPage() {
  const searchParams = useSearchParams();
  const openOnLoad = searchParams.get('edit');

  const [boards, setBoards] = useState<Board[]>([]);
  const [accessCounts, setAccessCounts] = useState<Record<string, number>>({});
  const [nonAdminUsers, setNonAdminUsers] = useState<AdminUser[]>([]);
  const [adminCount, setAdminCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [parentId, setParentId] = useState('');
  const [boardType, setBoardType] = useState<'normal' | 'routine'>('normal');
  const [routineImageUrl, setRoutineImageUrl] = useState('');
  const [visibility, setVisibility] = useState<'universal' | 'restricted'>('universal');
  const [newBoardAccess, setNewBoardAccess] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/admin/boards');
    const data = await res.json();
    if (res.ok) setBoards(data.boards);
    setLoading(false);
  }

  async function loadAccessCounts() {
    const res = await fetch('/api/admin/access-summary');
    const data = await res.json();
    if (res.ok) setAccessCounts(data.counts ?? {});
  }

  async function loadUsers() {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (res.ok) {
      const users = (data.users ?? []) as AdminUser[];
      setNonAdminUsers(users.filter((u) => u.role !== 'ADMIN'));
      setAdminCount(users.filter((u) => u.role === 'ADMIN').length);
    }
  }

  useEffect(() => {
    load();
    loadAccessCounts();
    loadUsers();
  }, []);

  // Deep-link support: /admin/boards?edit=<id> (used by the Access page's
  // "manage board" links) opens straight into that board's editor instead
  // of making the admin scroll and find + click Edit themselves.
  useEffect(() => {
    if (openOnLoad) setEditingId(openOnLoad);
  }, [openOnLoad]);

  const tree = useMemo(() => buildBoardTree(boards), [boards]);
  const ordered = useMemo(() => orderBoardsHierarchically(boards), [boards]);
  const parentIds = useMemo(() => idsWithChildren(boards), [boards]);
  const editingBoard = useMemo(() => boards.find((b) => b.id === editingId) ?? null, [boards, editingId]);

  // Everything starts COLLAPSED to just the Top-Level boards — an admin
  // opens up only the section they're working in instead of scrolling
  // past every chapter of every subject at once. This only fires ONCE,
  // the first time boards actually load: later reloads (after an edit)
  // must not stomp on whatever the admin has since expanded/collapsed by
  // hand.
  const didDefaultCollapse = useRef(false);
  useEffect(() => {
    if (!didDefaultCollapse.current && parentIds.size > 0) {
      setCollapsedIds(new Set(parentIds));
      didDefaultCollapse.current = true;
    }
  }, [parentIds]);

  // Search matches by title; a match's ancestors are kept too (even if
  // their own title doesn't match) so the result still reads as a
  // section — e.g. searching "physics" keeps "Class 9" visible above it.
  // While searching we fall back to a FLAT list with a breadcrumb on each
  // row (see renderFlatRow below) because the nested tree view only
  // makes sense when every ancestor is actually present to nest inside.
  const filteredFlat = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    const byId = new Map(boards.map((b) => [b.id, b]));
    const keep = new Set<string>();
    for (const b of ordered) {
      if (b.title.toLowerCase().includes(needle)) {
        let cur: Board | undefined = b;
        while (cur) {
          keep.add(cur.id);
          cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        }
      }
    }
    return ordered.filter((b) => keep.has(b.id));
  }, [ordered, search, boards]);

  const isSearching = search.trim().length > 0;

  function toggleCollapsed(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openCreateModal(defaultParentId: string) {
    setParentId(defaultParentId);
    setTitle('');
    setDescription('');
    setThumbnailUrl('');
    setBoardType('normal');
    setRoutineImageUrl('');
    setVisibility('universal');
    setNewBoardAccess(new Set());
    setError(null);
    setFormOpen(true);
  }

  async function createBoard(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const res = await fetch('/api/admin/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: description || null,
        thumbnail_url: thumbnailUrl || null,
        parent_id: parentId || null,
        published: false,
        sort_order: 0,
        board_type: boardType,
        routine_image_url: boardType === 'routine' ? routineImageUrl || null : null,
        visibility,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Could not create board.');
      setCreating(false);
      return;
    }
    // Access can be set right here at creation time instead of forcing a
    // second trip through Edit — the board only exists once this POST
    // resolves, so the grant list is applied as an immediate follow-up
    // PUT using the id we just got back.
    if (visibility === 'restricted' && newBoardAccess.size > 0 && data.board?.id) {
      await fetch(`/api/admin/boards/${data.board.id}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: Array.from(newBoardAccess) }),
      });
      loadAccessCounts();
    }
    setTitle('');
    setDescription('');
    setThumbnailUrl('');
    setParentId('');
    setBoardType('normal');
    setRoutineImageUrl('');
    setVisibility('universal');
    setNewBoardAccess(new Set());
    setFormOpen(false);
    setCreating(false);
    load();
  }

  async function togglePublished(board: Board) {
    setBusyId(board.id);
    // Optimistic: flip it in place immediately instead of waiting on a
    // full reload — the request still runs, it just doesn't block the
    // click from feeling instant.
    setBoards((prev) => prev.map((b) => (b.id === board.id ? { ...b, published: !b.published } : b)));
    const res = await fetch(`/api/admin/boards/${board.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ published: !board.published }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Could not update board.');
      setBoards((prev) => prev.map((b) => (b.id === board.id ? { ...b, published: board.published } : b)));
    }
    setBusyId(null);
  }

  async function removeBoard(id: string) {
    if (!confirm('Delete this board? Child boards will also be removed.')) return;
    setBusyId(id);
    const res = await fetch(`/api/admin/boards/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? 'Could not delete board.');
    setBusyId(null);
    load();
  }

  function renderRow(node: BoardNode<Board>, opts: { breadcrumb?: string } = {}) {
    const hasChildren = parentIds.has(node.id);
    const isCollapsed = collapsedIds.has(node.id);
    const accessCount = accessCounts[node.id] ?? 0;

    return (
      <div key={node.id} className="overflow-hidden rounded-xl border border-vault-border bg-vault-900 backdrop-blur-xl shadow-glass">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {hasChildren ? (
              <button
                onClick={() => toggleCollapsed(node.id)}
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                className="shrink-0 rounded p-0.5 text-ink-faint transition hover:text-ink"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <span className="w-3.5 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0">
              {opts.breadcrumb && (
                <p className="truncate font-mono text-[10px] uppercase tracking-widest text-ink-faint/70">{opts.breadcrumb}</p>
              )}
              <p className="truncate text-sm text-ink">{node.title}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                {node.depth === 0 ? 'Top-Level' : `Sub-Level · depth ${node.depth}`} ·{' '}
                <span className={node.published ? 'text-ok' : 'text-warn'}>{node.published ? 'Published' : 'Draft'}</span>
                {node.visibility === 'restricted' && (
                  <>
                    {' '}
                    · <span className="text-signal-glow">Restricted · {accessCount} user{accessCount === 1 ? '' : 's'}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button
              onClick={() => openCreateModal(node.id)}
              className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
              title="Add a board nested under this one"
            >
              + Sub-board
            </button>
            <Link
              href={`/admin/videos?board=${node.id}`}
              className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
              title="Add a class under this board"
            >
              + Class
            </Link>
            <button
              disabled={busyId === node.id}
              onClick={() => togglePublished(node)}
              className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink disabled:opacity-50"
            >
              {node.published ? 'Unpublish' : 'Publish'}
            </button>
            <button
              onClick={() => setEditingId(node.id)}
              className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
            >
              Edit
            </button>
            <button
              disabled={busyId === node.id}
              onClick={() => removeBoard(node.id)}
              className="rounded-md border border-danger/30 px-2.5 py-1 text-xs text-danger transition hover:bg-danger/10 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>

        {/* Children render NESTED INSIDE their parent's card — an actual
            folder-tree shape — instead of a flat list where the only clue
            to nesting was indentation plus a repeated breadcrumb line on
            every single row. */}
        {hasChildren && !isCollapsed && (
          <div className="space-y-2 border-t border-vault-border bg-black/20 p-2 pl-5">
            {node.children.map((child) => renderRow(child))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-signal-glow">Admin</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-ink">Boards</h1>
        <button
          onClick={() => openCreateModal('')}
          className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-ink-dim transition hover:border-signal hover:text-ink"
        >
          + New board
        </button>
      </div>

      {formOpen && (
        <Modal title="New board" subtitle="Boards" onClose={() => setFormOpen(false)} wide>
        <form
          onSubmit={createBoard}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <p className="sm:col-span-2 text-xs text-ink-faint">
            Pick the top-level board first, then drill down to the exact spot this belongs
            under — same picker as adding a class. Leave every level empty to create a new
            Top-Level board.
          </p>
          <Field label="Title">
            <input required value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
          </Field>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              Parent board (optional)
            </span>
            <div className="mt-1">
              <CascadingBoardSelect boards={boards} value={parentId} onChange={setParentId} requireSelection={false} />
            </div>
          </div>
          <div className="sm:col-span-2">
            <Field label="Thumbnail">
              <ThumbnailUpload value={thumbnailUrl} onChange={setThumbnailUrl} />
            </Field>
          </div>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
          </Field>
          <Field label="Board type">
            <select value={boardType} onChange={(e) => setBoardType(e.target.value as 'normal' | 'routine')} className="input">
              <option value="normal">Normal (boards / classes)</option>
              <option value="routine">Routine (just an image)</option>
            </select>
          </Field>
          <Field label="Visibility">
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'universal' | 'restricted')} className="input">
              <option value="universal">Universal — everyone can see it</option>
              <option value="restricted">Restricted — only selected users</option>
            </select>
          </Field>
          {visibility === 'restricted' && (
            <div className="sm:col-span-2">
              <Field label="Who can see this board (optional — you can also do this later from Edit)">
                <UserMultiSelect
                  users={nonAdminUsers as SelectableUser[]}
                  selected={newBoardAccess}
                  onChange={setNewBoardAccess}
                  emptyLabel="No non-admin users to grant access to yet."
                />
              </Field>
              <p className="mt-1 text-xs text-ink-faint">
                {adminCount > 0
                  ? `${adminCount} admin${adminCount === 1 ? '' : 's'} not shown — admins always have access to every board.`
                  : 'Admins always have access to every board.'}
              </p>
            </div>
          )}
          {boardType === 'routine' && (
            <div className="sm:col-span-2">
              <Field label="Routine image (16:9 — this IS the routine)">
                <ThumbnailUpload value={routineImageUrl} onChange={setRoutineImageUrl} />
              </Field>
            </div>
          )}
          {error && <p className="sm:col-span-2 text-xs text-danger">{error}</p>}
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={creating}
              className="rounded-md bg-signal px-4 py-2 text-sm font-medium text-white transition hover:bg-signal-glow disabled:opacity-60"
            >
              {creating ? 'Creating…' : 'Create board (unpublished)'}
            </button>
          </div>
        </form>
        </Modal>
      )}

      {error && !formOpen && <p className="mt-3 text-xs text-danger">{error}</p>}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">All boards, by section</h2>
        <div className="flex flex-wrap items-center gap-2">
          {parentIds.size > 0 && !isSearching && (
            <>
              <button
                onClick={() => setCollapsedIds(new Set())}
                className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
              >
                Expand all
              </button>
              <button
                onClick={() => setCollapsedIds(new Set(parentIds))}
                className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
              >
                Collapse all
              </button>
            </>
          )}
          {boards.length > 5 && (
            <SearchInput value={search} onChange={setSearch} placeholder="Search boards…" className="w-full sm:w-64" />
          )}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {loading ? (
          <p className="text-center text-sm text-ink-faint">Loading…</p>
        ) : boards.length === 0 ? (
          <p className="rounded-xl border border-dashed border-vault-border p-6 text-center text-sm text-ink-faint">No boards yet.</p>
        ) : isSearching ? (
          filteredFlat.length === 0 ? (
            <p className="rounded-xl border border-dashed border-vault-border p-6 text-center text-sm text-ink-faint">
              No boards match &ldquo;{search}&rdquo;.
            </p>
          ) : (
            filteredFlat.map((b) => (
              <div key={b.id} style={{ marginLeft: b.depth * 20 }}>
                {renderRow({ ...b, children: [] }, { breadcrumb: b.depth > 0 ? ancestorTitles(boards, b.id).join(' › ') : undefined })}
              </div>
            ))
          )
        ) : (
          tree.map((node) => renderRow(node))
        )}
      </div>

      {editingBoard && (
        <Modal title={`Edit "${editingBoard.title}"`} subtitle="Boards" onClose={() => setEditingId(null)} wide>
          <BoardEditPanel
            board={editingBoard}
            boards={boards}
            onSaved={() => {
              load();
              loadAccessCounts();
            }}
            onError={setError}
          />
        </Modal>
      )}
    </div>
  );
}

function BoardEditPanel({
  board,
  boards,
  onSaved,
  onError,
}: {
  board: Board;
  boards: Board[];
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState(board.title);
  const [description, setDescription] = useState(board.description ?? '');
  const [thumbnailUrl, setThumbnailUrl] = useState(board.thumbnail_url ?? '');
  const [parentId, setParentId] = useState(board.parent_id ?? '');
  const [boardType, setBoardType] = useState<'normal' | 'routine'>(board.board_type ?? 'normal');
  const [routineImageUrl, setRoutineImageUrl] = useState(board.routine_image_url ?? '');
  const [visibility, setVisibility] = useState<'universal' | 'restricted'>(board.visibility ?? 'universal');
  const [saving, setSaving] = useState(false);

  // A board can never become its own parent, nor be reparented under one
  // of its own descendants — either would create a cycle the database
  // won't reject for you, silently corrupting the tree.
  const disallowed = useMemo(() => subtreeIds(boards, board.id), [boards, board.id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch(`/api/admin/boards/${board.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: description || null,
        thumbnail_url: thumbnailUrl || null,
        parent_id: parentId || null,
        board_type: boardType,
        routine_image_url: boardType === 'routine' ? routineImageUrl || null : null,
        visibility,
      }),
    });
    const data = await res.json();
    if (!res.ok) onError(data.error ?? 'Could not update board.');
    setSaving(false);
    onSaved();
  }

  return (
    <form onSubmit={save} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Title">
        <input required value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
      </Field>
      <Field label="Parent board">
        <CascadingBoardSelect boards={boards} value={parentId} onChange={setParentId} excludeIds={disallowed} requireSelection={false} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Thumbnail">
          <ThumbnailUpload value={thumbnailUrl} onChange={setThumbnailUrl} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
        </Field>
      </div>
      <Field label="Board type">
        <select value={boardType} onChange={(e) => setBoardType(e.target.value as 'normal' | 'routine')} className="input">
          <option value="normal">Normal (boards / classes)</option>
          <option value="routine">Routine (just an image)</option>
        </select>
      </Field>
      <Field label="Visibility">
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'universal' | 'restricted')} className="input">
          <option value="universal">Universal — everyone can see it</option>
          <option value="restricted">Restricted — only selected users</option>
        </select>
      </Field>
      {boardType === 'routine' && (
        <div className="sm:col-span-2">
          <Field label="Routine image (16:9 — this IS the routine)">
            <ThumbnailUpload value={routineImageUrl} onChange={setRoutineImageUrl} />
          </Field>
        </div>
      )}
      {visibility === 'restricted' && (
        <div className="sm:col-span-2">
          <Field label="Who can see this board (and everything nested under it)">
            <BoardAccessPicker boardId={board.id} boards={boards} onError={onError} />
          </Field>
        </div>
      )}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-signal px-4 py-2 text-sm font-medium text-white transition hover:bg-signal-glow disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

/**
 * Manages board_user_access for one 'restricted' board — separate from
 * the main save button above (its own fetch, its own save action)
 * because the grant list is a different table/endpoint entirely.
 *
 * ADMIN-role accounts are left out of this checklist entirely — the
 * backend already lets every admin see every board regardless of any
 * grant (see lib/boardAccess.ts), so listing them here as if they also
 * needed picking was pure noise.
 */
function BoardAccessPicker({
  boardId,
  boards,
  onError,
}: {
  boardId: string;
  boards: Board[];
  onError: (msg: string) => void;
}) {
  const [allUsers, setAllUsers] = useState<AdminUser[]>([]);
  const [adminCount, setAdminCount] = useState(0);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [copyFromId, setCopyFromId] = useState('');
  const [applyingToSubBoards, setApplyingToSubBoards] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const otherRestrictedBoards = useMemo(
    () => boards.filter((b) => b.visibility === 'restricted' && b.id !== boardId),
    [boards, boardId]
  );
  const restrictedDescendantIds = useMemo(
    () =>
      Array.from(subtreeIds(boards, boardId)).filter((id) => {
        if (id === boardId) return false;
        const b = boards.find((bb) => bb.id === id);
        return b?.visibility === 'restricted';
      }),
    [boards, boardId]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [usersRes, accessRes] = await Promise.all([fetch('/api/admin/users'), fetch(`/api/admin/boards/${boardId}/access`)]);
      const usersData = await usersRes.json();
      const accessData = await accessRes.json();
      if (cancelled) return;
      if (usersRes.ok) {
        const users = (usersData.users ?? []) as AdminUser[];
        setAllUsers(users.filter((u) => u.role !== 'ADMIN'));
        setAdminCount(users.filter((u) => u.role === 'ADMIN').length);
      }
      if (accessRes.ok) setGranted(new Set((accessData.emails ?? []) as string[]));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  async function copyFrom(otherBoardId: string) {
    if (!otherBoardId) return;
    const res = await fetch(`/api/admin/boards/${otherBoardId}/access`);
    const data = await res.json();
    if (!res.ok) {
      onError(data.error ?? 'Could not load that board\u2019s access list.');
      return;
    }
    setGranted((prev) => new Set([...prev, ...((data.emails ?? []) as string[])]));
    setSavedOnce(false);
  }

  async function saveAccess() {
    setSaving(true);
    const res = await fetch(`/api/admin/boards/${boardId}/access`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: Array.from(granted) }),
    });
    const data = await res.json();
    if (!res.ok) onError(data.error ?? 'Could not update access list.');
    else setSavedOnce(true);
    setSaving(false);
  }

  // Additive only, on purpose: this ADDS the currently-checked people to
  // every restricted board nested under this one, without touching
  // anyone already granted there.
  async function applyToSubBoards() {
    if (restrictedDescendantIds.length === 0 || granted.size === 0) return;
    setApplyingToSubBoards(true);
    setApplyResult(null);
    try {
      for (const id of restrictedDescendantIds) {
        const existingRes = await fetch(`/api/admin/boards/${id}/access`);
        const existingData = await existingRes.json();
        const existingEmails: string[] = existingRes.ok ? existingData.emails ?? [] : [];
        const merged = Array.from(new Set([...existingEmails, ...Array.from(granted)]));
        await fetch(`/api/admin/boards/${id}/access`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: merged }),
        });
      }
      setApplyResult(`Added to ${restrictedDescendantIds.length} nested restricted board${restrictedDescendantIds.length === 1 ? '' : 's'}.`);
    } catch {
      onError('Could not apply access to every nested board — some may not have updated.');
    }
    setApplyingToSubBoards(false);
  }

  if (loading) return <p className="text-xs text-ink-faint">Loading users…</p>;

  return (
    <div>
      {otherRestrictedBoards.length > 0 && (
        <select
          value={copyFromId}
          onChange={(e) => {
            copyFrom(e.target.value);
            setCopyFromId('');
          }}
          className="input mb-2 !w-auto text-[11px]"
        >
          <option value="">Copy access from…</option>
          {otherRestrictedBoards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
      )}
      <UserMultiSelect users={allUsers} selected={granted} onChange={setGranted} emptyLabel="No non-admin users to grant access to yet." />
      {adminCount > 0 && (
        <p className="mt-1.5 text-xs text-ink-faint">
          {adminCount} admin{adminCount === 1 ? '' : 's'} not shown — admins always have access to every board.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={saveAccess}
          disabled={saving}
          className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink disabled:opacity-50"
        >
          {saving ? 'Saving access…' : 'Save access list'}
        </button>
        {savedOnce && <span className="font-mono text-[10px] uppercase tracking-widest text-ok">saved</span>}
      </div>
      {restrictedDescendantIds.length > 0 && (
        <div className="mt-3 rounded-md border border-vault-border/60 bg-vault-900/40 p-2.5">
          <p className="text-xs text-ink-dim">
            This board has {restrictedDescendantIds.length} restricted board{restrictedDescendantIds.length === 1 ? '' : 's'} nested
            under it. Access doesn&rsquo;t cascade automatically — each one needs its own grant.
          </p>
          <button
            type="button"
            onClick={applyToSubBoards}
            disabled={applyingToSubBoards || granted.size === 0}
            className="mt-1.5 rounded-md border border-signal/30 bg-signal/10 px-2.5 py-1 text-[11px] font-medium text-signal transition hover:bg-signal/20 disabled:opacity-50"
          >
            {applyingToSubBoards ? 'Applying…' : `Also add the ${granted.size} selected user${granted.size === 1 ? '' : 's'} to those`}
          </button>
          {applyResult && <p className="mt-1 text-xs text-ok">{applyResult}</p>}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
