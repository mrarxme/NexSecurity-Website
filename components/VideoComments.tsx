'use client';

import { useEffect, useState } from 'react';
import { relativeTime } from '@/lib/relativeTime';

type Comment = {
  id: string;
  user_email: string;
  body: string;
  created_at: string;
};

/** "student@example.com" -> "student" — enough to identify who's
 * talking without printing a full email address next to every comment.
 * Falls back to the full address if it's somehow shaped unlike an
 * email (shouldn't happen — user_email always comes from an
 * authenticated Google identity — but this is display code, not a
 * security boundary, so it just degrades gracefully instead of
 * throwing). */
function shortName(email: string): string {
  const [local] = email.split('@');
  return local || email;
}

export function VideoComments({
  videoId,
  currentUserEmail,
  isAdmin,
}: {
  videoId: string;
  currentUserEmail: string;
  isAdmin: boolean;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  return (
    <div className="mt-6 border-t border-vault-border pt-5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        Comments{comments && comments.length > 0 ? ` (${comments.length})` : ''}
      </p>

      <form onSubmit={handleSubmit} className="mt-3">
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
          return (
            <div
              key={comment.id}
              className="flex items-start gap-3 rounded-lg border border-vault-border bg-vault-900 px-4 py-3 backdrop-blur-xl shadow-glass"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink">{shortName(comment.user_email)}</span>
                  <span className="shrink-0 text-xs text-ink-faint">{relativeTime(comment.created_at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-dim">{comment.body}</p>
              </div>
              {canDelete && (
                <button
                  onClick={() => handleDelete(comment.id)}
                  disabled={deletingId === comment.id}
                  title={isAdmin && !isOwn ? 'Remove comment (moderation)' : 'Delete your comment'}
                  className="shrink-0 rounded-md p-1.5 text-ink-faint transition hover:bg-danger/10 hover:text-danger disabled:opacity-50"
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
          );
        })}
      </div>
    </div>
  );
}
