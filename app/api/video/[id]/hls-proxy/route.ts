import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { uuidSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';
import { canAccessBoard } from '@/lib/boardAccess';
import {
  decodeProxyTarget,
  isSafeProxyTarget,
  looksLikePlaylist,
  m3u8FetchHeaders,
  rewritePlaylist,
} from '@/lib/m3u8';

export const dynamic = 'force-dynamic';
// Same reasoning as hls-download's maxDuration — segments are small so
// this is mostly headroom, not an expectation of actually needing it.
export const maxDuration = 60;

// requireAuthorized() re-validates the session against Supabase's Auth
// server on every call (see the getUser() comment in lib/auth.ts) — the
// right call for an ordinary page load or API hit, but HLS turns one
// video into dozens of independent requests (one per segment, every few
// seconds) in quick succession. Running the full check on every single
// one of those was enough to trip Supabase Auth's own rate limit
// (`over_request_rate_limit`), which then made *every* route's session
// check fail at once — logging the viewer out mid-class. This cache
// collapses a burst of segment requests for the same session into one
// real check every AUTH_CACHE_TTL_MS; a revoked/expired session is still
// caught within that same short window, just not on literally every
// segment. Scoped to this route only — nowhere else in the app makes
// anywhere near this many requests per video, so nowhere else needs it.
const AUTH_CACHE_TTL_MS = 20_000;
const authCache = new Map<string, { result: Awaited<ReturnType<typeof requireAuthorized>>; expiresAt: number }>();
// Separate from authCache above: this holds the in-flight PROMISE for a
// cache key that's currently being checked for the first time, so a burst
// of concurrent requests (e.g. hls.js firing several variant/segment
// fetches at once right after a quality switch) all await the SAME
// Supabase call instead of each starting their own. Without this, every
// request in that burst sees a cache miss (nothing's been stored yet —
// the cache is only populated AFTER a check resolves) and independently
// calls requireAuthorized(), and enough of those at once trips Supabase
// Auth's own rate limit (`over_request_rate_limit`, 429) — which then
// reads as "session invalid" for everyone and force-logs the viewer out
// mid-class. Deleted from this map the instant its result lands in
// authCache above, so it never grows and never outlives its own request.
const inFlightAuthChecks = new Map<string, Promise<Awaited<ReturnType<typeof requireAuthorized>>>>();

async function requireAuthorizedCached(request: NextRequest) {
  // The session cookie itself IS the session identity — reading it back
  // out doesn't require calling Supabase, so it's a free cache key.
  const cacheKey = request.headers.get('cookie') ?? '';
  const now = Date.now();
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.result;

  const existingCheck = inFlightAuthChecks.get(cacheKey);
  if (existingCheck) return existingCheck;

  const checkPromise = requireAuthorized().then((result) => {
    authCache.set(cacheKey, { result, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    inFlightAuthChecks.delete(cacheKey);
    return result;
  });
  inFlightAuthChecks.set(cacheKey, checkPromise);

  // Opportunistic cleanup so this doesn't grow unbounded in a long-lived
  // process — runs inline rather than on a timer since there's no
  // background-job runner in this stack (same reasoning as the trial
  // expiry check in lib/auth.ts).
  if (authCache.size > 500) {
    for (const [key, entry] of authCache) {
      if (entry.expiresAt <= now) authCache.delete(key);
    }
  }
  return checkPromise;
}

/**
 * Streams an admin-configured .m3u8 (HLS) playlist and its segments to an
 * authorized viewer, attaching the Referer header the source CDN requires
 * — a header browsers block client-side JS from setting itself (see
 * lib/m3u8.ts), so this proxy is the only place it can actually be
 * attached. The raw source URL and Referer never reach the client:
 * VideoPlayer.tsx only ever gives hls.js this route's own same-origin URL.
 *
 *   GET /api/video/[id]/hls-proxy            -> the root playlist
 *   GET /api/video/[id]/hls-proxy?u=<token>  -> a sub-resource the root
 *     (or a variant) playlist referenced — rewritten to this shape by
 *     rewritePlaylist() below, never constructed by the client itself.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuthorizedCached(request);
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Access denied.' }, { status: 404 });
  const videoId = parsedId.data;

  // Segments/keys/variant playlists can outnumber a page's initial /play
  // call many times over across a single class, so this is deliberately
  // looser than /play's 20/min — still enough to stop abuse without
  // breaking normal seeking/quality-switch bursts.
  const rl = checkRateLimit(`hls_proxy:${auth.user.email}`, 240, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  const adminClient = createSupabaseAdminClient();
  const { data: video } = await adminClient
    .from('videos')
    .select('id, provider, source_ref, referer_header, board:board_id(id, published)')
    .eq('id', videoId)
    .maybeSingle();

  const board = video?.board as unknown as { id: string; published: boolean } | null;

  // Same real gate as /play: authenticated + authorized (above) + the
  // video exists + is actually 'm3u8' + its board is published.
  if (!video || !board || !board.published || video.provider !== 'm3u8') {
    await logAuditEvent('VIDEO_ACCESS_DENIED', auth.user.email, videoId, { reason: 'hls_proxy_denied' });
    return NextResponse.json({ error: 'Access denied.' }, { status: 404 });
  }

  if (!(await canAccessBoard(adminClient, auth.user.email, board.id, auth.user.role === 'ADMIN'))) {
    await logAuditEvent('VIDEO_ACCESS_DENIED', auth.user.email, videoId, { reason: 'board_restricted' });
    return NextResponse.json({ error: 'Access denied.' }, { status: 404 });
  }

  const token = request.nextUrl.searchParams.get('u');
  const targetUrl = token ? decodeProxyTarget(token) : (video.source_ref as string);
  if (!targetUrl) return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  if (!isSafeProxyTarget(targetUrl)) return NextResponse.json({ error: 'Bad request.' }, { status: 400 });

  const referer = (video.referer_header as string | null) ?? null;
  const upstreamHeaders = m3u8FetchHeaders(referer);
  // Byte-range playlists (#EXT-X-BYTERANGE) are rare but forwarding a
  // client Range request costs nothing and keeps those working too.
  const range = request.headers.get('range');

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, {
      cache: 'no-store',
      headers: range ? { ...upstreamHeaders, Range: range } : upstreamHeaders,
    });
  } catch (err) {
    console.error('[hls-proxy] upstream fetch threw', targetUrl, err);
    return NextResponse.json({ error: 'Video stream is not currently available.' }, { status: 502 });
  }

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    console.error('[hls-proxy] upstream fetch failed', upstreamRes.status, targetUrl);
    // A 4xx from the CDN (403/404/410/…) is definitive — the Referer or
    // token is rejected, and retrying the exact same request will just
    // fail the exact same way again. Passing that real status straight
    // through (instead of always answering 502) is what lets the
    // player's own error handling (see the hls.js ERROR handler in
    // components/VideoPlayer.tsx) tell "this is permanently broken" apart
    // from "the CDN had a transient blip, worth retrying" — collapsing
    // both into 502 here made every failure look retriable, so a
    // genuinely broken video just kept silently retrying instead of
    // ever showing the viewer an error.
    const status = upstreamRes.status >= 400 && upstreamRes.status < 500 ? upstreamRes.status : 502;
    return NextResponse.json(
      { error: `Video stream is not currently available. (CDN ${upstreamRes.status})` },
      { status }
    );
  }

  const upstreamContentType = upstreamRes.headers.get('content-type') ?? '';
  const looksLikeM3u8Url = /\.m3u8($|\?)/i.test(targetUrl);

  if (looksLikeM3u8Url || upstreamContentType.includes('mpegurl')) {
    const text = await upstreamRes.text();
    if (!looksLikePlaylist(text)) {
      // Doesn't actually look like a playlist (bad URL, a CDN error page,
      // etc.) — pass it through as-is rather than pretending it rewrote
      // cleanly, so the real problem surfaces instead of a blank player.
      return new NextResponse(text, {
        status: upstreamRes.status,
        headers: { 'Content-Type': upstreamContentType || 'text/plain', 'Cache-Control': 'no-store' },
      });
    }
    const proxyBase = `/api/video/${videoId}/hls-proxy`;
    const rewritten = rewritePlaylist(text, targetUrl, proxyBase);
    return new NextResponse(rewritten, {
      status: upstreamRes.status,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
    });
  }

  // Segment (.ts/.m4s) or AES-128 key — stream straight through without
  // buffering it fully in memory first.
  const passthroughHeaders: Record<string, string> = {
    'Content-Type': upstreamContentType || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
  const contentRange = upstreamRes.headers.get('content-range');
  if (contentRange) passthroughHeaders['Content-Range'] = contentRange;

  return new NextResponse(upstreamRes.body, {
    status: upstreamRes.status,
    headers: passthroughHeaders,
  });
}
