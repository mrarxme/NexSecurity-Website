import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the Supabase auth cookie on every request that passes through
 * middleware.ts. This does NOT decide authorization — it only keeps the
 * session valid so that the real, server-side checks in lib/auth.ts have
 * an accurate session to check against.
 *
 * --- Why the lock below exists (random "logout" bug) ---
 * Supabase refresh tokens are single-use/rotating: the first request to
 * redeem one gets a new access+refresh pair, and any OTHER request still
 * holding that same (now-spent) refresh token gets rejected. This app
 * fires several independent background requests (video heartbeat, resume
 * checkpoint, admin polling) — while a tab sits in the background the
 * browser throttles their timers, so when the user switches back after a
 * while they all fire in a burst. If the access token had expired during
 * that idle stretch, every one of those requests hits this middleware at
 * once and each would otherwise try to refresh with the SAME stale
 * refresh token cookie: one wins, the rest fail with an "already used"
 * error, and a failing response can end up wiping the cookies the winner
 * just set — leaving the browser with a broken session, which shows up
 * as a random logout on the very next navigation.
 *
 * The fix: dedupe concurrent refreshes for the same cookie. When several
 * requests arrive holding the identical (not-yet-rotated) auth cookie,
 * only the first actually calls Supabase; the rest await that same
 * in-flight call and reuse whatever cookies it resolves with. This is a
 * best-effort, same-process cache (a module-level Map survives across
 * requests on a warm server/edge instance, but not across cold starts or
 * different instances) — combined with reducing how many background
 * requests fire at once in the first place (see VideoPlayer.tsx /
 * TopNav.tsx), it closes the race for the realistic case that was
 * actually causing the logouts.
 */
type CookieToSet = { name: string; value: string; options: CookieOptions };

const inFlightRefreshes = new Map<string, Promise<CookieToSet[]>>();

function authCookieCacheKey(request: NextRequest): string | null {
  // Supabase's auth cookie is named "sb-<project-ref>-auth-token" and,
  // when the session is large, gets split into "...-auth-token.0",
  // "...-auth-token.1", etc. Grabbing everything that matches and
  // sorting it gives a stable key: two requests that arrived with the
  // exact same (still valid, not-yet-rotated) session cookie produce the
  // same key and can safely share one refresh.
  const relevant = request.cookies
    .getAll()
    .filter((c) => c.name.includes('-auth-token'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${c.name}=${c.value}`);
  return relevant.length ? relevant.join('&') : null;
}

export async function updateSession(request: NextRequest) {
  const cacheKey = authCookieCacheKey(request);
  const cookiesToSet: CookieToSet[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          cookiesToSet.push({ name, value, options });
        },
        remove(name: string, options: CookieOptions) {
          cookiesToSet.push({ name, value: '', options });
        },
      },
    }
  );

  let resolvedCookies: CookieToSet[];

  const inFlight = cacheKey ? inFlightRefreshes.get(cacheKey) : undefined;
  if (inFlight) {
    // Someone else already started a refresh for this exact cookie —
    // piggyback on it instead of racing a second one with the same
    // (about-to-be-invalidated) refresh token.
    resolvedCookies = await inFlight;
  } else {
    // Touching getUser() is what actually validates/refreshes the
    // session server-side (getSession() alone would just trust the
    // cookie as-is).
    const promise = supabase.auth.getUser().then(() => cookiesToSet);
    if (cacheKey) inFlightRefreshes.set(cacheKey, promise);
    try {
      resolvedCookies = await promise;
    } finally {
      // Only this call's own entry should be cleared — if a newer
      // request already overwrote the map key with its own refresh,
      // leave that one alone.
      if (cacheKey && inFlightRefreshes.get(cacheKey) === promise) {
        inFlightRefreshes.delete(cacheKey);
      }
    }
  }

  for (const { name, value, options } of resolvedCookies) {
    request.cookies.set({ name, value, ...options });
  }

  const response = NextResponse.next({ request: { headers: request.headers } });
  for (const { name, value, options } of resolvedCookies) {
    response.cookies.set({ name, value, ...options });
  }

  return response;
}
