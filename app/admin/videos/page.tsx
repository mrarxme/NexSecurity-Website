'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ThumbnailUpload } from '@/components/ThumbnailUpload';
import { Modal } from '@/components/Modal';
import { CascadingBoardSelect } from '@/components/CascadingBoardSelect';
import { buildBoardTree, idsWithChildren, type BoardNode } from '@/lib/boardTree';

type Board = { id: string; title: string; parent_id: string | null; visibility?: 'universal' | 'restricted' };
type Resource = { id: string; title: string; url: string; sort_order: number };
type Video = {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  provider: string;
  source_ref: string;
  referer_header: string | null;
  board_id: string;
  board: { id: string; title: string } | null;
  video_resources: Resource[];
  sort_order: number;
  download_url: string | null;
};

const RESOURCE_PRESETS = ['Lecture Sheet', 'Note', 'Exam Sheet', 'Practice Sheet'];

// Accepts a full Bunny embed URL and pulls out "{libraryId}/{videoGuid}".
function parseBunnyEmbedUrl(input: string): string | null {
  const match = input.trim().match(/mediadelivery\.net\/embed\/([^/]+)\/([a-f0-9-]+)/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function bunnyEmbedUrlFromSourceRef(sourceRef: string): string {
  return `https://iframe.mediadelivery.net/embed/${sourceRef}`;
}

// Accepts any common YouTube URL shape (watch?v=, youtu.be/, /embed/,
// /shorts/) or a bare 11-character video id pasted directly, and returns
// just the id — what videos.source_ref stores for provider='youtube'.
function parseYoutubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube-nocookie\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const match = trimmed.match(re);
    if (match) return match[1];
  }
  return null;
}

function youtubeWatchUrlFromSourceRef(sourceRef: string): string {
  return `https://www.youtube.com/watch?v=${sourceRef}`;
}

// mp4 ("Direct Stream URL"): source_ref *is* the playable URL — nothing
// to parse out of an embed page, just make sure it's a real https URL
// before it's saved. Despite the field's original name, this URL doesn't
// have to be an actual .mp4 file — a public, unprotected .m3u8 works
// here too (VideoPlayer.tsx detects the extension itself and hands it to
// hls.js automatically); this provider is really just "any direct file
// URL", mp4 or m3u8. Use the 'm3u8' provider instead only when the CDN
// actually requires a Referer header to serve it.
function parseMp4Url(input: string): string | null {
  const trimmed = input.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return trimmed;
}

// m3u8: source_ref *is* the playlist URL, same shape of check as mp4
// above — the Referer that goes with it is a separate field entirely
// (see refererInput in both forms below), not part of source_ref.
function parseM3u8Url(input: string): string | null {
  const trimmed = input.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return trimmed;
}

// Single source of truth for how a provider renders as a badge — was
// three duplicated ternary chains (create list, grouped list, board
// path hints all needed it); now just one, reused everywhere.
function providerBadge(provider: string): { label: string; className: string } {
  switch (provider) {
    case 'youtube':
      return { label: 'YouTube', className: 'text-warn' };
    case 'mp4':
      return { label: 'Direct Stream', className: 'text-signal-glow' };
    case 'm3u8':
      return { label: 'm3u8 with Referer', className: 'text-signal-glow' };
    default:
      return { label: 'Bunny', className: 'text-ok' };
  }
}

export default function AdminVideosPage() {
  const searchParams = useSearchParams();
  const boardFromQuery = searchParams.get('board');

  const [videos, setVideos] = useState<Video[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create form
  const [boardId, setBoardId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [createProvider, setCreateProvider] = useState<'bunny' | 'youtube' | 'mp4' | 'm3u8'>('bunny');
  const [embedInput, setEmbedInput] = useState('');
  const [refererInput, setRefererInput] = useState('');
  const [sortOrder, setSortOrder] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState('');

  // Resources (Lecture Sheet, Note, etc.) queued up while filling out the
  // create form — the video doesn't have an id yet, so these can't be
  // POSTed to /api/admin/resources until createVideo() actually creates
  // it; held here in the meantime and attached right after.
  const [pendingResourceTitle, setPendingResourceTitle] = useState('');
  const [pendingResourceUrl, setPendingResourceUrl] = useState('');
  const [pendingResources, setPendingResources] = useState<{ title: string; url: string }[]>([]);

  function addPendingResource(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingResourceTitle || !pendingResourceUrl) return;
    setPendingResources([...pendingResources, { title: pendingResourceTitle, url: pendingResourceUrl }]);
    setPendingResourceTitle('');
    setPendingResourceUrl('');
  }

  function removePendingResource(index: number) {
    setPendingResources(pendingResources.filter((_, i) => i !== index));
  }

  // Which video's edit modal is open
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingVideo = useMemo(() => videos.find((v) => v.id === editingId) ?? null, [videos, editingId]);

  // Board-grouped list below: which board sections are collapsed, and the
  // title search that temporarily overrides collapse state so a match
  // buried three boards deep is never hidden by whatever was collapsed
  // before the search started.
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const didDefaultCollapse = useRef(false);

  const tree = useMemo(() => buildBoardTree(boards), [boards]);
  const parentIds = useMemo(() => idsWithChildren(boards), [boards]);
  const videosByBoard = useMemo(() => {
    const map = new Map<string, Video[]>();
    for (const v of videos) {
      if (!map.has(v.board_id)) map.set(v.board_id, []);
      map.get(v.board_id)!.push(v);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [videos]);
  // Every board id that actually needs a collapse toggle — either it has
  // sub-boards, or it has classes of its own directly attached to it.
  const collapsibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of boards) {
      if (parentIds.has(b.id) || (videosByBoard.get(b.id)?.length ?? 0) > 0) ids.add(b.id);
    }
    return ids;
  }, [boards, parentIds, videosByBoard]);
  const boardIds = useMemo(() => new Set(boards.map((b) => b.id)), [boards]);
  // Classes whose board was since deleted — shouldn't happen, but if it
  // does, they'd otherwise vanish from this page with no way to find or
  // fix them.
  const orphanVideos = useMemo(
    () => videos.filter((v) => !boardIds.has(v.board_id)),
    [videos, boardIds]
  );

  // Collapse every board with something to hide the first time boards
  // actually load — an admin returning to a page with 40 classes across
  // a dozen boards wants the lay of the land first, not everything
  // expanded at once. A ref (not state) so this fires exactly once and
  // doesn't fight with the admin's own later expand/collapse clicks.
  useEffect(() => {
    if (!didDefaultCollapse.current && collapsibleIds.size > 0) {
      setCollapsedIds(new Set(collapsibleIds));
      didDefaultCollapse.current = true;
    }
  }, [collapsibleIds]);

  function toggleCollapsed(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const trimmedQuery = searchQuery.trim().toLowerCase();
  // null = no search active, so every board renders and collapse state
  // is respected as normal; a Set = only these video ids should show,
  // and every ancestor of a match forces itself open regardless of
  // collapsedIds.
  const matchingVideoIds = useMemo(() => {
    if (!trimmedQuery) return null;
    return new Set(videos.filter((v) => v.title.toLowerCase().includes(trimmedQuery)).map((v) => v.id));
  }, [videos, trimmedQuery]);

  function nodeHasMatch(node: BoardNode<Board>): boolean {
    if (!matchingVideoIds) return true;
    if ((videosByBoard.get(node.id) ?? []).some((v) => matchingVideoIds.has(v.id))) return true;
    return node.children.some((child) => nodeHasMatch(child));
  }

  function renderVideoRow(v: Video) {
    const badge = providerBadge(v.provider);
    return (
      <div
        key={v.id}
        className="overflow-hidden rounded-xl border border-vault-border bg-vault-900/60 backdrop-blur-xl"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-ink">
              <span className="mr-2 font-mono text-[10px] text-signal-glow">#{v.sort_order}</span>
              {v.title}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {v.video_resources?.length ?? 0} resource{v.video_resources?.length === 1 ? '' : 's'} ·{' '}
              <span className={badge.className}>{badge.label}</span>
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => setEditingId(v.id)}
              className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
            >
              Edit
            </button>
            <button
              disabled={busyId === v.id}
              onClick={() => removeVideo(v.id)}
              className="rounded-md border border-danger/30 px-2.5 py-1 text-xs text-danger transition hover:bg-danger/10 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderBoardNode(node: BoardNode<Board>) {
    if (!nodeHasMatch(node)) return null;
    const hasChildren = node.children.length > 0;
    const nodeVideos = (videosByBoard.get(node.id) ?? []).filter(
      (v) => !matchingVideoIds || matchingVideoIds.has(v.id)
    );
    const isSearching = !!matchingVideoIds;
    const isCollapsed = !isSearching && collapsedIds.has(node.id);
    const showToggle = hasChildren || nodeVideos.length > 0;

    return (
      <div
        key={node.id}
        className="overflow-hidden rounded-xl border border-vault-border bg-vault-900 backdrop-blur-xl shadow-glass"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {showToggle ? (
              <button
                onClick={() => toggleCollapsed(node.id)}
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                className="shrink-0 rounded p-0.5 text-ink-faint transition hover:text-ink"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                >
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <span className="w-3.5 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{node.title}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                {nodeVideos.length} class{nodeVideos.length === 1 ? '' : 'es'}
                {hasChildren
                  ? ` · ${node.children.length} sub-board${node.children.length === 1 ? '' : 's'}`
                  : ''}
              </p>
            </div>
          </div>
        </div>

        {/* Sub-boards render NESTED INSIDE their parent's card, same as
            the Boards admin page — an actual folder-tree shape, so which
            board a class sits under is legible at a glance instead of
            needing to open every class's edit modal to find out. */}
        {!isCollapsed && (nodeVideos.length > 0 || hasChildren) && (
          <div className="space-y-2 border-t border-vault-border bg-black/20 p-2 pl-5">
            {nodeVideos.map((v) => renderVideoRow(v))}
            {node.children.map((child) => renderBoardNode(child))}
          </div>
        )}
      </div>
    );
  }

  async function load() {
    setLoading(true);
    const [videosRes, boardsRes] = await Promise.all([
      fetch('/api/admin/videos'),
      fetch('/api/admin/boards'),
    ]);
    const videosData = await videosRes.json();
    const boardsData = await boardsRes.json();
    if (videosRes.ok) setVideos(videosData.videos);
    if (boardsRes.ok) setBoards(boardsData.boards);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  // Deep-link support: /admin/videos?board=<id> (used by the "+ Class"
  // button on a board's row in the Boards admin page) pre-selects that
  // board in the create form instead of making the admin re-drill down
  // through the same cascading picker they just navigated away from.
  useEffect(() => {
    if (boardFromQuery) setBoardId(boardFromQuery);
  }, [boardFromQuery]);

  async function createVideo(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const sourceRef =
      createProvider === 'bunny'
        ? parseBunnyEmbedUrl(embedInput)
        : createProvider === 'youtube'
          ? parseYoutubeVideoId(embedInput)
          : createProvider === 'm3u8'
            ? parseM3u8Url(embedInput)
            : parseMp4Url(embedInput);
    if (!sourceRef) {
      setError(
        createProvider === 'bunny'
          ? "Couldn't read that as a Bunny embed URL. It should look like https://iframe.mediadelivery.net/embed/LIBRARY_ID/VIDEO_ID"
          : createProvider === 'youtube'
            ? "Couldn't read that as a YouTube link. Paste the full video URL (youtube.com/watch?v=... or youtu.be/...) or just the 11-character video id."
            : createProvider === 'm3u8'
              ? "Couldn't read that as an HLS playlist URL. It needs to be a full https link straight to the .m3u8 file."
              : "Couldn't read that as a direct stream URL. It needs to be a full https link straight to the video file or .m3u8 playlist."
      );
      return;
    }
    if (!boardId) {
      setError('Choose which board this class belongs to.');
      return;
    }
    if (createProvider === 'm3u8' && !refererInput.trim()) {
      setError('Enter the Referer this stream requires.');
      return;
    }

    const res = await fetch('/api/admin/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        board_id: boardId,
        title,
        description: description || null,
        thumbnail_url: thumbnailUrl || null,
        provider: createProvider,
        source_ref: sourceRef,
        referer_header: createProvider === 'm3u8' ? refererInput.trim() : null,
        sort_order: sortOrder,
        download_url: downloadUrl || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Could not add class.');
      return;
    }

    // Attach whatever resources were queued up while filling out the
    // form — now that the video has a real id. Best-effort: the class
    // itself is already created at this point, so one failed resource
    // attach shouldn't read as the whole "Add class" action having
    // failed (same non-blocking stance the edit panel's addResource
    // takes on its own errors).
    if (pendingResources.length > 0) {
      const results = await Promise.all(
        pendingResources.map((r, index) =>
          fetch('/api/admin/resources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: data.video.id, title: r.title, url: r.url, sort_order: index }),
          })
        )
      );
      if (results.some((r) => !r.ok)) {
        setError('Class was created, but one or more resources could not be attached. Add them from Edit.');
      }
    }

    setBoardId('');
    setTitle('');
    setDescription('');
    setThumbnailUrl('');
    setEmbedInput('');
    setRefererInput('');
    setCreateProvider('bunny');
    setSortOrder(0);
    setDownloadUrl('');
    setPendingResources([]);
    setPendingResourceTitle('');
    setPendingResourceUrl('');
    load();
  }

  async function removeVideo(id: string) {
    if (!confirm('Remove this class? Members will no longer be able to play it.')) return;
    setBusyId(id);
    const res = await fetch(`/api/admin/videos/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? 'Could not remove class.');
    setBusyId(null);
    load();
  }

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-signal-glow">Admin</p>
      <h1 className="mt-2 font-display text-2xl font-semibold text-ink">Classes</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-dim">
        Attach a class (video) to a board — pick the top-level board first, then drill down to
        the exact one it belongs under. The list below is grouped the same way: collapse a board
        to hide everything under it, or search by title if you already know the class. You can
        attach a Lecture Sheet, Note, Exam Sheet, or Practice Sheet while creating the class below,
        or click <strong className="text-ink">Edit</strong> on it afterward to add or change one.
      </p>

      <form
        onSubmit={createVideo}
        className="mt-6 grid grid-cols-1 gap-3 rounded-xl border border-vault-border bg-vault-900 p-5 sm:grid-cols-2 backdrop-blur-xl shadow-glass"
      >
        <div className="sm:col-span-2">
          <Field label="Board">
            <CascadingBoardSelect boards={boards} value={boardId} onChange={setBoardId} />
          </Field>
        </div>
        <Field label="Title">
          <input required value={title} onChange={(e) => setTitle(e.target.value)} className="input" />
        </Field>
        <Field label="Part number (order within this board)">
          <input
            type="number"
            min={0}
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value))}
            className="input"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Video source">
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name="create-provider"
                  checked={createProvider === 'bunny'}
                  onChange={() => {
                    setCreateProvider('bunny');
                    setEmbedInput('');
                  }}
                />
                Bunny (protected)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name="create-provider"
                  checked={createProvider === 'youtube'}
                  onChange={() => {
                    setCreateProvider('youtube');
                    setEmbedInput('');
                  }}
                />
                YouTube (free, unlisted)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name="create-provider"
                  checked={createProvider === 'mp4'}
                  onChange={() => {
                    setCreateProvider('mp4');
                    setEmbedInput('');
                  }}
                />
                Direct Stream URL
              </label>
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name="create-provider"
                  checked={createProvider === 'm3u8'}
                  onChange={() => {
                    setCreateProvider('m3u8');
                    setEmbedInput('');
                    setRefererInput('');
                  }}
                />
                m3u8 with Referer
              </label>
            </div>
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field
            label={
              createProvider === 'bunny'
                ? 'Bunny embed URL'
                : createProvider === 'youtube'
                  ? 'YouTube video URL'
                  : createProvider === 'm3u8'
                    ? 'HLS playlist URL (.m3u8)'
                    : 'Direct video URL (.mp4 or public .m3u8)'
            }
          >
            <input
              required
              value={embedInput}
              onChange={(e) => setEmbedInput(e.target.value)}
              placeholder={
                createProvider === 'bunny'
                  ? 'https://iframe.mediadelivery.net/embed/503487/df2a65b4-…'
                  : createProvider === 'youtube'
                    ? 'https://www.youtube.com/watch?v=… (make sure it is Unlisted, not Public)'
                    : createProvider === 'm3u8'
                      ? 'https://example.com/path/playlist.m3u8'
                      : 'https://example.com/path/video.mp4 (or .m3u8, if it needs no Referer)'
              }
              className="input font-mono text-xs"
            />
          </Field>
        </div>
        {createProvider === 'm3u8' && (
          <div className="sm:col-span-2">
            <Field label="Referer header">
              <input
                required
                value={refererInput}
                onChange={(e) => setRefererInput(e.target.value)}
                placeholder="https://example.com/"
                className="input font-mono text-xs"
              />
              <p className="mt-1 text-xs text-ink-faint">
                Sent server-side only, when fetching the playlist and its segments — never exposed
                to the viewer's browser.
              </p>
            </Field>
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label="Thumbnail">
            <ThumbnailUpload value={thumbnailUrl} onChange={setThumbnailUrl} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Download link (optional, https)">
            <input
              value={downloadUrl}
              onChange={(e) => setDownloadUrl(e.target.value)}
              placeholder="https://…"
              className="input"
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input"
            />
          </Field>
        </div>
        <div className="sm:col-span-2 border-t border-vault-border pt-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            Resources (optional — Lecture Sheet, Note, Exam Sheet, Practice Sheet…)
          </span>

          {pendingResources.length > 0 && (
            <ul className="mt-2 space-y-2">
              {pendingResources.map((r, index) => (
                <li
                  key={`${r.title}-${index}`}
                  className="flex items-center justify-between rounded-md border border-vault-border bg-vault-900 px-3 py-2 text-sm backdrop-blur-xl shadow-glass"
                >
                  <div className="min-w-0">
                    <span className="text-ink">{r.title}</span>
                    <span className="ml-2 truncate font-mono text-[10px] text-ink-faint">{r.url}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePendingResource(index)}
                    className="ml-3 shrink-0 text-xs text-danger hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Name</span>
              <input
                value={pendingResourceTitle}
                onChange={(e) => setPendingResourceTitle(e.target.value)}
                placeholder="Lecture Sheet"
                className="input mt-1 w-40"
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {RESOURCE_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset}
                    onClick={() => setPendingResourceTitle(preset)}
                    className="rounded border border-vault-border px-1.5 py-0.5 text-[10px] text-ink-faint hover:border-signal hover:text-ink"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-[240px] flex-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Link (https)</span>
              <input
                value={pendingResourceUrl}
                onChange={(e) => setPendingResourceUrl(e.target.value)}
                placeholder="https://…"
                className="input mt-1"
              />
            </div>
            <button
              type="button"
              onClick={addPendingResource}
              className="rounded-md border border-vault-border px-3 py-2 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
            >
              Queue resource
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-faint">
            Queued here, attached automatically once you click{' '}
            <strong className="text-ink">Add class</strong> below.
          </p>
        </div>
        <div className="sm:col-span-2">
          <button
            type="submit"
            className="rounded-md bg-signal px-4 py-2 text-sm font-medium text-white transition hover:bg-signal-glow"
          >
            Add class
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      <div className="mt-6 space-y-3">
        {loading ? (
          <p className="text-center text-sm text-ink-faint">Loading…</p>
        ) : videos.length === 0 ? (
          <p className="rounded-xl border border-dashed border-vault-border p-6 text-center text-sm text-ink-faint">
            No classes yet.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search classes by title…"
                className="input max-w-xs"
              />
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setCollapsedIds(new Set())}
                  className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={() => setCollapsedIds(new Set(collapsibleIds))}
                  className="rounded-md border border-vault-border px-2.5 py-1 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
                >
                  Collapse all
                </button>
              </div>
            </div>

            {matchingVideoIds && matchingVideoIds.size === 0 ? (
              <p className="rounded-xl border border-dashed border-vault-border p-6 text-center text-sm text-ink-faint">
                No classes match &quot;{searchQuery}&quot;.
              </p>
            ) : (
              <div className="space-y-3">
                {tree.map((node) => renderBoardNode(node))}
                {(() => {
                  const visibleOrphans = orphanVideos.filter(
                    (v) => !matchingVideoIds || matchingVideoIds.has(v.id)
                  );
                  return (
                    visibleOrphans.length > 0 && (
                      <div className="overflow-hidden rounded-xl border border-dashed border-warn/40 bg-vault-900 p-2 pl-4">
                        <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-warn">
                          Not attached to any existing board
                        </p>
                        <div className="space-y-2">{visibleOrphans.map((v) => renderVideoRow(v))}</div>
                      </div>
                    )
                  );
                })()}
              </div>
            )}
          </>
        )}
      </div>

      {editingVideo && (
        <Modal title={`Edit "${editingVideo.title}"`} subtitle="Classes" onClose={() => setEditingId(null)} wide>
          <VideoEditPanel video={editingVideo} boards={boards} onSaved={load} onError={setError} />
        </Modal>
      )}
    </div>
  );
}

function VideoEditPanel({
  video,
  boards,
  onSaved,
  onError,
}: {
  video: Video;
  boards: Board[];
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState(video.title);
  const [boardId, setBoardId] = useState(video.board_id);
  const currentBoard = useMemo(() => boards.find((b) => b.id === boardId), [boards, boardId]);
  const [description, setDescription] = useState(video.description ?? '');
  const [thumbnailUrl, setThumbnailUrl] = useState(video.thumbnail_url ?? '');
  const [editProvider, setEditProvider] = useState<'bunny' | 'youtube' | 'mp4' | 'm3u8'>(
    video.provider === 'youtube'
      ? 'youtube'
      : video.provider === 'mp4'
        ? 'mp4'
        : video.provider === 'm3u8'
          ? 'm3u8'
          : 'bunny'
  );
  const [embedInput, setEmbedInput] = useState(
    video.provider === 'youtube'
      ? youtubeWatchUrlFromSourceRef(video.source_ref)
      : video.provider === 'mp4' || video.provider === 'm3u8'
        ? video.source_ref
        : bunnyEmbedUrlFromSourceRef(video.source_ref)
  );
  const [refererInput, setRefererInput] = useState(
    video.provider === 'm3u8' ? (video.referer_header ?? '') : ''
  );
  const [sortOrder, setSortOrder] = useState(video.sort_order ?? 0);
  const [downloadUrl, setDownloadUrl] = useState(video.download_url ?? '');
  const [saving, setSaving] = useState(false);

  const [resourceTitle, setResourceTitle] = useState('');
  const [resourceUrl, setResourceUrl] = useState('');
  const [addingResource, setAddingResource] = useState(false);
  const [resources, setResources] = useState<Resource[]>(video.video_resources ?? []);

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    const sourceRef =
      editProvider === 'bunny'
        ? parseBunnyEmbedUrl(embedInput)
        : editProvider === 'youtube'
          ? parseYoutubeVideoId(embedInput)
          : editProvider === 'm3u8'
            ? parseM3u8Url(embedInput)
            : parseMp4Url(embedInput);

    // Switching provider (or re-pasting the URL) requires a URL that
    // actually parses — otherwise this would silently keep the OLD
    // provider's source_ref while the provider field itself changes,
    // breaking playback with no visible error until a student hits it.
    if (editProvider !== video.provider && !sourceRef) {
      onError(
        editProvider === 'bunny'
          ? "Couldn't read that as a Bunny embed URL. Paste the full embed URL to switch providers."
          : editProvider === 'youtube'
            ? "Couldn't read that as a YouTube link. Paste the video URL or id to switch providers."
            : editProvider === 'm3u8'
              ? "Couldn't read that as an HLS playlist URL. Paste a full https .m3u8 link to switch providers."
              : "Couldn't read that as a direct stream URL. Paste a full https link to switch providers."
      );
      return;
    }
    if (editProvider === 'm3u8' && !refererInput.trim()) {
      onError('Enter the Referer this stream requires.');
      return;
    }

    setSaving(true);
    const patch: Record<string, unknown> = {
      title,
      board_id: boardId,
      description: description || null,
      thumbnail_url: thumbnailUrl || null,
      sort_order: sortOrder,
      download_url: downloadUrl || null,
      provider: editProvider,
      referer_header: editProvider === 'm3u8' ? refererInput.trim() : null,
    };
    if (sourceRef) patch.source_ref = sourceRef;

    const res = await fetch(`/api/admin/videos/${video.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) onError(data.error ?? 'Could not update class.');
    setSaving(false);
    onSaved();
  }

  async function addResource(e: React.FormEvent) {
    e.preventDefault();
    if (!resourceTitle || !resourceUrl) return;
    setAddingResource(true);
    const res = await fetch('/api/admin/resources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: video.id,
        title: resourceTitle,
        url: resourceUrl,
        sort_order: resources.length,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      onError(data.error ?? 'Could not add resource.');
    } else {
      setResources([...resources, data.resource]);
      setResourceTitle('');
      setResourceUrl('');
    }
    setAddingResource(false);
    onSaved();
  }

  async function removeResource(id: string) {
    setResources(resources.filter((r) => r.id !== id));
    const res = await fetch(`/api/admin/resources/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) onError(data.error ?? 'Could not remove resource.');
    onSaved();
  }

  return (
    <div>
      <form onSubmit={saveDetails} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" required />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Board (this class belongs to)">
            <CascadingBoardSelect boards={boards} value={boardId} onChange={setBoardId} />
          {/* Classes don't have their own access list — who can watch this
              one follows whichever board it's attached to. Restricted per
              board, not per class, so this is a status readout + a link
              rather than another checklist to keep in sync. */}
          <p className="mt-1 text-xs text-ink-faint">
            {currentBoard?.visibility === 'restricted' ? (
              <>
                Restricted — access is managed on the board, not the class.{' '}
                <Link href={`/admin/access`} className="underline decoration-dotted hover:text-signal">
                  Manage who can see it
                </Link>
              </>
            ) : (
              'Universal — visible to every authorized user, via this board.'
            )}
          </p>
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Video source">
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name={`edit-provider-${video.id}`}
                  checked={editProvider === 'bunny'}
                  onChange={() => {
                    setEditProvider('bunny');
                    setEmbedInput(video.provider === 'bunny' ? bunnyEmbedUrlFromSourceRef(video.source_ref) : '');
                  }}
                />
                Bunny (protected)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name={`edit-provider-${video.id}`}
                  checked={editProvider === 'youtube'}
                  onChange={() => {
                    setEditProvider('youtube');
                    setEmbedInput(video.provider === 'youtube' ? youtubeWatchUrlFromSourceRef(video.source_ref) : '');
                  }}
                />
                YouTube (free, unlisted)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name={`edit-provider-${video.id}`}
                  checked={editProvider === 'mp4'}
                  onChange={() => {
                    setEditProvider('mp4');
                    setEmbedInput(video.provider === 'mp4' ? video.source_ref : '');
                  }}
                />
                Direct Stream URL
              </label>
              <label className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="radio"
                  name={`edit-provider-${video.id}`}
                  checked={editProvider === 'm3u8'}
                  onChange={() => {
                    setEditProvider('m3u8');
                    setEmbedInput(video.provider === 'm3u8' ? video.source_ref : '');
                    setRefererInput(video.provider === 'm3u8' ? (video.referer_header ?? '') : '');
                  }}
                />
                m3u8 with Referer
              </label>
            </div>
          </Field>
        </div>
        <Field
          label={
            editProvider === 'bunny'
              ? 'Bunny embed URL'
              : editProvider === 'youtube'
                ? 'YouTube video URL'
                : editProvider === 'm3u8'
                  ? 'HLS playlist URL (.m3u8)'
                  : 'Direct video URL (.mp4 or public .m3u8)'
          }
        >
          <input
            value={embedInput}
            onChange={(e) => setEmbedInput(e.target.value)}
            className="input font-mono text-xs"
          />
        </Field>
        {editProvider === 'm3u8' && (
          <Field label="Referer header">
            <input
              value={refererInput}
              onChange={(e) => setRefererInput(e.target.value)}
              placeholder="https://example.com/"
              className="input font-mono text-xs"
            />
          </Field>
        )}
        <Field label="Part number (order within this board)">
          <input
            type="number"
            min={0}
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value))}
            className="input"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Thumbnail">
            <ThumbnailUpload value={thumbnailUrl} onChange={setThumbnailUrl} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Download link (optional, https)">
            <input
              value={downloadUrl}
              onChange={(e) => setDownloadUrl(e.target.value)}
              placeholder="https://…"
              className="input"
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input"
            />
          </Field>
        </div>
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

      <div className="mt-6 border-t border-vault-border pt-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          Resources (Lecture Sheet, Exam Sheet, Practice Sheet…)
        </p>

        {resources.length > 0 && (
          <ul className="mt-3 space-y-2">
            {resources.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between rounded-md border border-vault-border bg-vault-900 px-3 py-2 text-sm backdrop-blur-xl shadow-glass"
              >
                <div className="min-w-0">
                  <span className="text-ink">{r.title}</span>
                  <span className="ml-2 truncate font-mono text-[10px] text-ink-faint">{r.url}</span>
                </div>
                <button
                  onClick={() => removeResource(r.id)}
                  className="ml-3 shrink-0 text-xs text-danger hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={addResource} className="mt-4 flex flex-wrap items-end gap-2">
          <div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              Name
            </span>
            <input
              value={resourceTitle}
              onChange={(e) => setResourceTitle(e.target.value)}
              placeholder="Lecture Sheet"
              className="input mt-1 w-40"
            />
            <div className="mt-1 flex gap-1">
              {RESOURCE_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset}
                  onClick={() => setResourceTitle(preset)}
                  className="rounded border border-vault-border px-1.5 py-0.5 text-[10px] text-ink-faint hover:border-signal hover:text-ink"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
          <div className="min-w-[240px] flex-1">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              Link (https)
            </span>
            <input
              value={resourceUrl}
              onChange={(e) => setResourceUrl(e.target.value)}
              placeholder="https://…"
              className="input mt-1"
            />
          </div>
          <button
            type="submit"
            disabled={addingResource}
            className="rounded-md border border-vault-border px-3 py-2 text-xs text-ink-dim transition hover:border-signal hover:text-ink disabled:opacity-50"
          >
            {addingResource ? 'Adding…' : 'Add resource'}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
