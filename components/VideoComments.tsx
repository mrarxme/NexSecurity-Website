'use client';

import { useEffect, useState } from 'react';
import { relativeTime } from '@/lib/relativeTime';

type Comment = {
  id: string;
  user_email: string;
  user_name: string | null;
  user_avatar_url: string | null;
  body: string;
  created_at: string;
  updated_at: string;
};

/** "student@example.com" -> "student" — fallback for comments posted
 * before user_name existed (migration 0011), or for any account whose
 * Google profile never returned a full name. Not a security boundary,
 * just display code — degrades gracefully instead of throwing. */
function shortName(email: string): string {
  const [local] = email.split('@');
  return local || email;
}

function displayName(comment: Pick<Comment, 'user_name' | 'user_email'>): string {
  return comment.user_name?.trim() || shortName(comment.user_email);
}

/** First letter of the display name, for the fallback avatar circle
 * shown when a comment has no user_avatar_url (older rows, or a Google
 * account with no profile photo). */
function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- external
    // Google profile photo URLs; next/image would require allowlisting
    // every Google avatar host for no real benefit at this size.
    return <img src={url} alt={name} className="h-10 w-10 shrink-0 rounded-full object-cover" />;
  }
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-vault-900 text-sm font-medium text-ink-dim ring-1 ring-vault-border">
      {initial(name)}
    </div>
  );
}

export function VideoComments({
  videoId,
  currentUserEmail,
  currentUserName,
  currentUserAvatarUrl,
  isAdmin,
}: {
  videoId: string;
  currentUserEmail: string;
  currentUserName: string | null;
  currentUserAvatarUrl: string | null;
  isAdmin: boolean;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Which comment (if any) is currently in inline-edit mode, and the
  // text being edited — separate from `draft` above so editing an old
  // comment never clobbers whatever's half-typed in the "new comment"
  // box.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/video/${videoId}/comments`);
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        if (!cancelled) setComments(data.comments ?? []);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || posting) return;

    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/video/${videoId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPostError(data?.error ?? 'Could not post comment.');
        return;
      }
      // Append locally instead of re-fetching the whole list — the
      // server already returned the row it just inserted (with its
      // real id/created_at), so a second round trip would be redundant.
      setComments((prev) => [...(prev ?? []), data.comment]);
      setDraft('');
    } catch {
      setPostError('Could not post comment.');
    } finally {
      setPosting(false);
    }
  }

  async function handleDelete(commentId: string) {
    setDeletingId(commentId);
    try {
      const res = await fetch(`/api/video/${videoId}/comments/${commentId}`, { method: 'DELETE' });
      if (res.ok) {
        setComments((prev) => (prev ?? []).filter((c) => c.id !== commentId));
      }
    } catch {
      // Best-effort — leaving the comment in place on failure is the
      // honest outcome (it wasn't actually removed), no need for a
      // separate error banner over one failed delete.
    } finally {
      setDeletingId(null);
    }
  }

  function startEdit(comment: Comment) {
    setEditingId(comment.id);
    setEditDraft(comment.body);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
    setEditError(null);
  }

  async function handleSaveEdit(commentId: string) {
    const body = editDraft.trim();
    if (!body || savingEdit) return;

    setSavingEdit(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/video/${videoId}/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEditError(data?.error ?? 'Could not save changes.');
        return;
      }
      setComments((prev) => (prev ?? []).map((c) => (c.id === commentId ? data.comment : c)));
      setEditingId(null);
      setEditDraft('');
    } catch {
      setEditError('Could not save changes.');
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="mt-6 border-t border-vault-border pt-5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        Comments{comments && comments.length > 0 ? ` (${comments.length})` : ''}
      </p>

      <form onSubmit={handleSubmit} className="mt-3 flex items-start gap-3">
        <Avatar name={currentUserName || currentUserEmail} url={currentUserAvatarUrl} />
        <div className="min-w-0 flex-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask a question or leave a note for this class…"
            rows={3}
            maxLength={2000}
            className="input resize-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            {postError ? <p className="text-xs text-danger">{postError}</p> : <span />}
            <button
              type="submit"
              disabled={posting || !draft.trim()}
              className="shrink-0 rounded-md bg-signal px-4 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-50"
            >
              {posting ? 'Posting…' : 'Post'}
            </button>
          </div>
        </div>
      </form>

      <div className="mt-4 space-y-3">
        {comments === null && !loadError && <p className="text-sm text-ink-faint">Loading comments…</p>}
        {loadError && <p className="text-sm text-ink-faint">Couldn't load comments.</p>}
        {comments && comments.length === 0 && (
          <p className="text-sm text-ink-faint">No comments yet — be the first to ask something.</p>
        )}
        {comments?.map((comment) => {
          const isOwn = comment.user_email.toLowerCase() === currentUserEmail.toLowerCase();
          const canDelete = isOwn || isAdmin;
          const isEditing = editingId === comment.id;
          const wasEdited = comment.updated_at !== comment.created_at;
          const name = displayName(comment);

          return (
            <div
              key={comment.id}
              className="flex items-start gap-3 rounded-lg border border-vault-border bg-vault-900 px-4 py-3 backdrop-blur-xl shadow-glass"
            >
              <Avatar name={name} url={comment.user_avatar_url} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink">{name}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {relativeTime(comment.created_at)}
                    {wasEdited ? ' · edited' : ''}
                  </span>
                </div>

                {isEditing ? (
                  <div className="mt-2">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      maxLength={2000}
                      autoFocus
                      className="input resize-none"
                    />
                    <div className="mt-2 flex items-center justify-between gap-3">
                      {editError ? <p className="text-xs text-danger">{editError}</p> : <span />}
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={savingEdit}
                          className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-faint transition hover:text-ink disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(comment.id)}
                          disabled={savingEdit || !editDraft.trim()}
                          className="rounded-md bg-signal px-4 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-50"
                        >
                          {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-dim">{comment.body}</p>
                )}
              </div>

              {!isEditing && (isOwn || canDelete) && (
                <div className="flex shrink-0 items-center gap-1">
                  {isOwn && (
                    <button
                      onClick={() => startEdit(comment)}
                      title="Edit your comment"
                      className="rounded-md p-1.5 text-ink-faint transition hover:bg-vault-border hover:text-ink"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                  {canDelete && (
                    <button
                      onClick={() => handleDelete(comment.id)}
                      disabled={deletingId === comment.id}
                      title={isAdmin && !isOwn ? 'Remove comment (moderation)' : 'Delete your comment'}
                      className="rounded-md p-1.5 text-ink-faint transition hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.7 12.1A2 2 0 0 1 14.3 21H9.7a2 2 0 0 1-2-1.9L7 7h10Z"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
