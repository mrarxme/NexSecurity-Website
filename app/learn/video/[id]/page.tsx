import Link from 'next/link';
import Image from 'next/image';
import { redirect, notFound } from 'next/navigation';
import { getAuth } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { uuidSchema } from '@/lib/validation';
import { buildBunnyEmbedUrl } from '@/lib/bunny';
import { buildYoutubeEmbedUrl } from '@/lib/youtube';
import { logAuditEvent } from '@/lib/audit';
import { canAccessBoard } from '@/lib/boardAccess';
import { VideoPlayer } from '@/components/VideoPlayer';
import { PartsList } from '@/components/PartsList';
import { ShareButton } from '@/components/ShareButton';
import { VideoComments } from '@/components/VideoComments';
import { resourceVisual } from '@/lib/resourceVisual';

export const dynamic = 'force-dynamic';

export default async function VideoPage({ params }: { params: { id: string } }) {
  const auth = await getAuth();
  if (auth.state === 'UNAUTHENTICATED') redirect('/login');
  if (auth.state === 'UNAUTHORIZED') redirect('/login?error=access_denied');
  if (auth.state === 'DEVICE_BLOCKED') redirect('/login?error=device_blocked');

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) notFound();
  const videoId = parsedId.data;

  // Same fields /api/video/[id]/play reads (provider + source_ref included)
  // — the page now builds the SAME embed URL that route would return, so
  // the player's iframe can start loading on the very first paint instead
  // of waiting on a client-side round trip after hydration for a URL
  // that's already knowable server-side. This does NOT change what data
  // reaches the client: that route already hands this exact URL to the
  // browser on every heartbeat re-check (see components/VideoPlayer.tsx);
  // this just stops making the browser wait for a follow-up fetch to get
  // it the first time. The heartbeat keeps re-verifying access every 4
  // minutes exactly as before — this only shortcuts the very first load.
  const adminClient = createSupabaseAdminClient();
  const { data: video } = await adminClient
    .from('videos')
    .select(
      'id, title, description, download_url, provider, source_ref, thumbnail_url, board:board_id(id, title, published, parent_id), video_resources(id, title, url, sort_order)'
    )
    .eq('id', videoId)
    .maybeSingle();

  const board = video?.board as unknown as {
    id: string;
    title: string;
    published: boolean;
    parent_id: string | null;
  } | null;

  if (!video || !board || !board.published) notFound();

  // "Restricted" board visibility — same cascading ancestor-chain check
  // as app/learn/board/[id]/page.tsx. A video's own board might be
  // 'universal', but if any ancestor above it is 'restricted' and this
  // user has no grant for that ancestor, the video is just as locked as
  // the board listing page itself.
  if (!(await canAccessBoard(adminClient, auth.user.email, board.id, auth.user.role === 'ADMIN'))) {
    notFound();
  }

  let initialPlaybackUrl: string | null = null;
  if (video.provider === 'bunny') {
    const [libraryId, bunnyVideoId] = video.source_ref.split('/');
    if (libraryId && bunnyVideoId) {
      initialPlaybackUrl = buildBunnyEmbedUrl(libraryId, bunnyVideoId);
      // Fire-and-forget, same event the /play route logs on every
      // successful check — keeps the audit trail consistent between the
      // initial server-rendered load and every later heartbeat call.
      void logAuditEvent('VIDEO_ACCESS_GRANTED', auth.email, videoId);
    }
  } else if (video.provider === 'youtube') {
    initialPlaybackUrl = buildYoutubeEmbedUrl(video.source_ref);
    void logAuditEvent('VIDEO_ACCESS_GRANTED', auth.email, videoId);
  }
  // If neither branch set a URL (bad provider/malformed source_ref),
  // initialPlaybackUrl stays null and VideoPlayer falls back to its own
  // client-side fetch to /play, which surfaces the real error message —
  // no error-handling logic duplicated here.

  // "Resume playback" — same lookup /api/video/[id]/play does on a
  // client-side load; done here too so the very first server-rendered
  // paint already knows where to seek, instead of a flash-then-jump once
  // hydration catches up. Best-effort: null on any lookup issue just
  // means "start from 0:00", same as a first-time watch.
  let initialResumeSeconds: number | null = null;
  const { data: progress } = await adminClient
    .from('video_progress')
    .select('position_seconds')
    .eq('user_email', auth.email)
    .eq('video_id', videoId)
    .maybeSingle();
  if (progress?.position_seconds && progress.position_seconds > 5) {
    initialResumeSeconds = progress.position_seconds;
  }

  const resources = (video.video_resources ?? []).sort(
    (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
  );

  // Parent board (breadcrumb) and sibling parts (Course Content) don't
  // depend on each other — run them together instead of one after another.
  // "You may also like" needs siblingBoards' ids first, so it stays a
  // second wave rather than a third sequential round trip on its own.
  const [{ data: parentBoard }, { data: siblingBoardsRaw }, { data: siblingVideos }] = await Promise.all([
    board.parent_id
      ? adminClient.from('boards').select('id, title').eq('id', board.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    adminClient
      .from('boards')
      .select('id, title')
      .eq('parent_id', board.parent_id ?? board.id)
      .eq('published', true)
      .neq('id', board.id)
      .limit(6),
    adminClient
      .from('videos')
      .select('id, title, thumbnail_url, sort_order')
      .eq('board_id', board.id)
      .order('sort_order', { ascending: true }),
  ]);
  const siblingBoards = siblingBoardsRaw ?? [];
  const parts = siblingVideos ?? [];

  let recommended: { id: string; title: string; thumbnail_url: string | null; boardTitle: string }[] = [];
  if (siblingBoards.length > 0) {
    const { data: recRaw } = await adminClient
      .from('videos')
      .select('id, title, thumbnail_url, board_id, created_at')
      .in(
        'board_id',
        siblingBoards.map((b) => b.id)
      )
      .order('created_at', { ascending: false })
      .limit(3);
    const boardTitleById = new Map(siblingBoards.map((b) => [b.id, b.title]));
    recommended = (recRaw ?? []).map((v) => ({
      id: v.id,
      title: v.title,
      thumbnail_url: v.thumbnail_url,
      boardTitle: boardTitleById.get(v.board_id) ?? '',
    }));
  }

  return (
    <main className="mx-auto max-w-screen-2xl px-6 py-8">
      <nav className="flex flex-wrap items-center gap-1.5 text-sm text-ink-faint">
        <Link href="/learn" className="text-signal hover:underline">
          Learn
        </Link>
        {parentBoard && (
          <>
            <span>›</span>
            <Link href={`/learn/board/${parentBoard.id}`} className="text-signal hover:underline">
                {parentBoard.title}
              </Link>
            </>
          )}
          <span>›</span>
          <span className="text-ink-dim">{board.title}</span>
        </nav>

        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">
            <VideoPlayer
              videoId={video.id}
              initialUrl={initialPlaybackUrl}
              initialProvider={video.provider}
              initialResumeSeconds={initialResumeSeconds}
              thumbnailUrl={video.thumbnail_url}
            />

            <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
              <h1 className="font-display text-xl font-semibold text-ink">{video.title}</h1>
              {/* Download button intentionally removed: video downloads are
                  disabled for class pages per current policy. */}
              <ShareButton />
            </div>

            {resources.length > 0 && (
              <div className="mt-6 border-t border-vault-border pt-5">
                <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">Resources</p>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4">
                  {resources.map((r: { id: string; title: string; url: string }) => {
                    const visual = resourceVisual(r.title);
                    return (
                      <a
                        key={r.id}
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group relative block overflow-hidden rounded-xl border border-vault-border bg-vault-900 p-4 text-center shadow-glass backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-signal hover:shadow-lg"
                      >
                        {/* Soft color-matched glow in the corner, same
                            "hint of the icon's color bleeding into the
                            card" touch as the reference design — just
                            dialed down to work on a dark card instead of
                            a white one. */}
                        <div
                          className={`absolute -right-8 -top-8 h-20 w-20 rounded-full bg-gradient-to-br ${visual.gradient} opacity-20 blur-2xl transition-transform duration-500 group-hover:scale-150`}
                          aria-hidden="true"
                        />
                        <div className="relative z-10 flex flex-col items-center gap-3">
                          <div
                            className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${visual.gradient} shadow-lg transition-transform duration-300 group-hover:scale-110`}
                          >
                            {visual.icon}
                          </div>
                          <h4 className="line-clamp-2 text-sm font-semibold leading-tight text-ink">{r.title}</h4>
                          <div className="flex items-center gap-1 text-xs text-ink-faint transition-colors group-hover:text-signal-glow">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <path
                                d="M7 17 17 7M17 7H9M17 7v8"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                            <span>Open</span>
                          </div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {video.description && (
              <div className="mt-6 border-t border-vault-border pt-5">
                <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">Description</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-dim">{video.description}</p>
              </div>
            )}

            <VideoComments
              videoId={video.id}
              currentUserEmail={auth.email}
              currentUserName={auth.profile.fullName}
              currentUserAvatarUrl={auth.profile.avatarUrl}
              isAdmin={auth.user.role === 'ADMIN'}
            />
          </div>

          <div className="space-y-6">
            {parts.length > 1 && (
              <div className="rounded-xl border border-vault-border bg-vault-900 p-4 backdrop-blur-xl shadow-glass">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">Course Content</p>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                    {parts.length} parts
                  </span>
                </div>
                <div className="mt-3">
                  <PartsList parts={parts} activeId={video.id} />
                </div>
              </div>
            )}

            {recommended.length > 0 && (
              <div className="rounded-xl border border-vault-border bg-vault-900 p-4 backdrop-blur-xl shadow-glass">
                <p className="text-sm font-semibold text-ink">You may also like</p>
                <div className="mt-3 space-y-3">
                  {recommended.map((r) => (
                    <Link key={r.id} href={`/learn/video/${r.id}`} className="flex items-center gap-3 group">
                      <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md bg-vault-800">
                        {r.thumbnail_url ? (
                          <Image src={r.thumbnail_url} alt="" fill sizes="80px" className="object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-ink-faint" aria-hidden="true">
                              <path d="M8 5v14l11-7-11-7Z" fill="currentColor" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink group-hover:text-signal">{r.title}</p>
                        <p className="truncate text-xs text-ink-faint">{r.boardTitle}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
  );
}
