'use client';

import Script from 'next/script';
import { useCallback, useEffect, useRef, useState } from 'react';
import { extractYoutubeId } from '@/lib/youtube';

declare global {
  interface Window {
    playerjs?: {
      Player: new (iframe: HTMLIFrameElement) => PlayerJsInstance;
    };
    // YouTube's IFrame Player API — loaded from https://www.youtube.com/iframe_api,
    // which calls this global once it's ready. Types kept minimal (only
    // what's actually used below); see
    // https://developers.google.com/youtube/iframe_api_reference.
    YT?: {
      Player: new (el: HTMLElement, options: YtPlayerOptions) => YtPlayerInstance;
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; BUFFERING: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type PlayerJsInstance = {
  on: (event: string, cb: (data?: unknown) => void) => void;
  play: () => void;
  pause: () => void;
  getCurrentTime: (cb: (seconds: number) => void) => void;
  setCurrentTime: (seconds: number) => void;
  getDuration: (cb: (seconds: number) => void) => void;
  // Standard player.js spec methods (https://github.com/embedplus/player.js
  // — Bunny's embed implements this spec) — used once, right after
  // 'ready', to make sure autoplay never starts muted. Optional/best-effort
  // the same way setPlaybackRate below is: harmless no-op if a given
  // embed doesn't implement them.
  mute?: () => void;
  unmute?: () => void;
  // Not part of the documented player.js/Bunny spec — calling it is a
  // harmless no-op if unsupported, so it's used as a best-effort "try it,
  // don't rely on it" call. See the space-hold handler below.
  setPlaybackRate?: (rate: number) => void;
};

type YtPlayerOptions = {
  videoId: string;
  host?: string;
  playerVars?: Record<string, number | string>;
  events?: {
    onReady?: (e: { target: YtPlayerInstance }) => void;
    onStateChange?: (e: { data: number; target: YtPlayerInstance }) => void;
  };
};

type YtPlayerInstance = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  setPlaybackRate: (rate: number) => void;
  getPlaybackRate: () => number;
  getAvailablePlaybackRates: () => number[];
  // Quality controls: YouTube largely auto-manages quality server-side now
  // and may ignore setPlaybackQuality, but the API is still there and this
  // keeps the menu functional wherever it is honored.
  getAvailableQualityLevels: () => string[];
  getPlaybackQuality: () => string;
  setPlaybackQuality: (level: string) => void;
  getVolume: () => number;
  setVolume: (volume: number) => void;
  getVideoLoadedFraction: () => number;
  destroy: () => void;
};

const QUALITY_LABELS: Record<string, string> = {
  auto: 'Auto',
  highres: 'Highres',
  hd2160: '2160p 4K',
  hd1440: '1440p',
  hd1080: '1080p',
  hd720: '720p',
  large: '480p',
  medium: '360p',
  small: '240p',
  tiny: '144p',
};

// YouTube's IFrame API officially deprecated manual quality control:
// getPlaybackQuality, setPlaybackQuality, and getAvailableQualityLevels are
// documented as "no longer supported" — setPlaybackQuality is now a no-op
// with zero effect on playback, for every embed everywhere, not just this
// one. See https://developers.google.com/youtube/iframe_api_reference
// ("Deprecations and changes"). There is no client-side fix for that; it's
// a platform restriction, not a bug in this player. The quality submenu
// below reflects the real, live-polled resolution instead of pretending a
// manual picker works.

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const SEEK_SECONDS = 10;
const HOLD_THRESHOLD_MS = 320;
const HEARTBEAT_MS = 4 * 60 * 1000; // well inside the ~10-minute token expiry
const YT_TIME_POLL_MS = 400; // YT's API has no timeupdate event, only polling
const PROGRESS_SAVE_MS = 15 * 1000; // "resume playback" checkpoint cadence — YouTube only now (see effect below); Bunny/mp4/HLS already save themselves on pause/end/unload.

// A background tab has its timers throttled by the browser, so several
// independent intervals (this heartbeat, the YouTube progress checkpoint,
// admin polling elsewhere) all become "due" at once and fire in the same
// burst the moment the user switches back to the tab. That burst is what
// was landing several concurrent session-refresh attempts on the server
// at once (see lib/supabase/middleware.ts for the actual fix), and it's
// also just needless simultaneous load either way. jitteredInterval
// re-randomizes its own delay by up to ±20% on every tick (recursive
// setTimeout, not setInterval) so independent timers drift apart instead
// of staying phase-locked together.
function jitteredInterval(callback: () => void, baseMs: number): () => void {
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const jitter = baseMs * 0.2 * (Math.random() * 2 - 1); // ±20%
    timeoutId = setTimeout(() => {
      if (cancelled) return;
      callback();
      if (!cancelled) schedule();
    }, Math.max(1000, baseMs + jitter));
  };
  schedule();
  return () => {
    cancelled = true;
    clearTimeout(timeoutId);
  };
}

// Shared per-button styling for the custom control bar — a small hit-area
// with a hover highlight, matching the reference bar's button treatment
// instead of bare unstyled icons.
const CTRL_BTN_CLASS =
  'flex items-center justify-center rounded-lg p-1.5 text-white/90 transition hover:bg-white/10 hover:text-white';

// Branded loading indicator — a thin ring in the site's signal-blue
// spins on top of a soft pulsing glow behind it, instead of a bare
// generic spinner or plain text with nothing to look at. Shared by the
// pre-player "verifying access" state and the YouTube/mp4 buffering
// overlay so the whole player only ever shows ONE loading motif.
function PlayerLoadingSpinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative h-10 w-10">
        <span className="absolute inset-0 rounded-full border-2 border-white/10" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-signal border-r-signal nex-player-spin" />
      </div>
      {label && <span className="font-mono text-xs uppercase tracking-widest text-ink-faint">{label}</span>}
    </div>
  );
}

// Turns whatever raw string ended up in `error` — some are our own fixed
// copy (see the setError() call sites below), others are passed straight
// through from the /play API's { error: "..." } response — into an
// actually actionable toast: what happened, in plain language, plus one
// concrete thing to try. Falls back to just showing the raw text rather
// than inventing an explanation for a message this doesn't recognize.
function explainPlaybackError(raw: string): { title: string; message: string; fixLabel: string } {
  const lower = raw.toLowerCase();
  if (lower.includes('too many requests') || lower.includes('rate limit')) {
    return {
      title: 'Too many requests',
      message: 'This class was requested too many times in a short window. Wait a few seconds and try again.',
      fixLabel: 'Try again',
    };
  }
  if (lower.includes('access denied') || lower.includes('not authorized') || lower.includes('restricted')) {
    return {
      title: "You don't have access to this class",
      message: 'Your account may not be enrolled on this board, or your session may need refreshing.',
      fixLabel: 'Refresh page',
    };
  }
  if (lower.includes('broken') || lower.includes('expired') || lower.includes('cannot play') || lower.includes('not currently available')) {
    return { title: 'This video failed to load', message: raw, fixLabel: 'Refresh page' };
  }
  return { title: 'Something went wrong', message: raw, fixLabel: 'Refresh page' };
}

// The "something's wrong" card — shown over the class's own thumbnail
// (see the background layer in the main render below) instead of a bare
// line of red text on black, with one button that actually does
// something rather than just naming the problem and leaving the viewer
// to guess what to do about it.
function PlayerProblemToast({
  title,
  message,
  fixLabel = 'Refresh page',
  onFix,
}: {
  title: string;
  message: string;
  fixLabel?: string;
  onFix?: () => void;
}) {
  return (
    <div className="absolute inset-x-0 bottom-4 z-30 mx-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-white/10 bg-vault-950/90 p-4 text-left shadow-2xl backdrop-blur-md sm:bottom-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-dim">{message}</p>
          <button
            onClick={onFix ?? (() => window.location.reload())}
            className="mt-2.5 rounded-md bg-signal px-3 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow"
          >
            {fixLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Bunny's embed player accepts autoplay as a URL param directly
// (https://docs.bunny.net/docs/stream-embedding-videos). Deliberately
// autoplay-ONLY, no muted=true: Bunny's own player (like YouTube's)
// generally already knows how to fall back to muted itself when the
// browser blocks sound-on autoplay, and forcing muted here would mean
// it NEVER even tries with sound for a visitor the browser would
// actually have allowed it for. `url` already carries a short-lived
// signed token in its own query string (see /api/video/[id]/play), so
// this parses it rather than string-concatenating a second `?`.
function withBunnyAutoplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set('autoplay', 'true');
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function VideoPlayer({
  videoId,
  initialUrl,
  initialProvider,
  initialResumeSeconds,
  thumbnailUrl,
}: {
  videoId: string;
  initialUrl?: string | null;
  initialProvider?: string | null;
  initialResumeSeconds?: number | null;
  thumbnailUrl?: string | null;
}) {
  const [url, setUrl] = useState<string | null>(initialUrl ?? null);
  const [provider, setProvider] = useState<string | null>(initialProvider ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialUrl);
  const [revoked, setRevoked] = useState(false);
  const [playerJsReady, setPlayerJsReady] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const isBunny = provider === 'bunny';
  const isYoutube = provider === 'youtube';
  const isMp4 = provider === 'mp4';
  const isM3u8 = provider === 'm3u8';
  // "Direct Stream URL" (provider='mp4') is really just "any file URL the
  // admin pasted in" — some CDNs serve perfectly public, unprotected HLS
  // with no Referer requirement at all, so there's nothing for the
  // m3u8-with-Referer provider or its hls-proxy to add there; the admin
  // pastes the .m3u8 straight into this provider instead, and it needs
  // the exact same hls.js treatment as the m3u8 provider gets — just
  // fed the raw url directly, with no proxy in front of it (see isHls'
  // effect below, and note play/route.ts already returns source_ref
  // as-is, unproxied, for this provider).
  const isDirectHls = isMp4 && /\.m3u8(?:[?#]|$)/i.test(url ?? '');
  const isHls = isM3u8 || isDirectHls;
  // mp4 and m3u8 both play through the same plain <video> element and
  // the same custom control bar below — they only differ in how the
  // source gets loaded into that element (a plain `src=` vs hls.js). See
  // the two effects that read isMp4/isHls individually further down.
  const isNativeVideo = isMp4 || isM3u8;

  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<PlayerJsInstance | null>(null);
  const isPlayingRef = useRef(false);
  const spaceDownRef = useRef(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingFastRef = useRef(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Press-and-hold-to-2x on the video itself (touch or mouse), mirroring
  // the space-hold shortcut above but for a direct press on the frame.
  const touchHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchHoldingFastRef = useRef(false);
  const suppressNextVideoClickRef = useRef(false);

  // --- "Resume playback": last watched position for this (user, video),
  // read either from the server-rendered page (initialResumeSeconds) or
  // from this component's own client-side /play fetch below. Applied
  // (seeked to) exactly once per mount via resumeAppliedRef — after
  // that, normal playback/seeking takes over and this is never consulted
  // again until the page is reloaded. Refs (not just the ytCurrentTime /
  // Bunny timeupdate state) track the live position so an unload/tab-close
  // flush always has an up-to-date value to send without waiting on an
  // async getCurrentTime callback.
  const [resumeSeconds, setResumeSeconds] = useState<number | null>(initialResumeSeconds ?? null);
  const resumeAppliedRef = useRef(false);
  // Guards the one-time autoplay kick per provider (mp4/m3u8 path
  // below) — YouTube's own playerVars.autoplay + onReady fallback handle
  // themselves, and Bunny gets autoplay via a URL param (see
  // withBunnyAutoplay), so this ref is only actually read by the native
  // <video> path.
  const autoplayAttemptedRef = useRef(false);
  const ytCurrentTimeRef = useRef(0);
  const ytDurationRef = useRef(0);
  const bunnyPositionRef = useRef(0);
  const bunnyDurationRef = useRef(0);

  // --- YouTube (IFrame Player API) state ---
  const [ytApiReady, setYtApiReady] = useState(false);
  const [ytPlaying, setYtPlaying] = useState(false);
  const [ytBuffering, setYtBuffering] = useState(true);
  const [ytMuted, setYtMuted] = useState(false);
  const [ytVolume, setYtVolume] = useState(1);
  const [ytCurrentTime, setYtCurrentTime] = useState(0);
  const [ytDuration, setYtDuration] = useState(0);
  const [ytBufferedFraction, setYtBufferedFraction] = useState(0);
  const ytMountRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<YtPlayerInstance | null>(null);
  const ytSeekingRef = useRef(false);

  // --- Direct Stream (native <video>) state ---
  // Reuses the same yt* state above the custom control bar already reads
  // from — this component was written so those represent "custom-bar
  // media state" generically, fed either by YouTube's IFrame API (above)
  // or by native <video> events (see the effect below), never both at
  // once. Only the source element and how it's driven differ.
  const mp4VideoRef = useRef<HTMLVideoElement>(null);

  // --- HLS (.m3u8 with Referer) state ---
  // Typed loosely (the real hls.js type) rather than `any` from a static
  // import, kept dynamic below so hls.js's bytes only ever load for a
  // class that's actually this provider.
  const hlsRef = useRef<import('hls.js').default | null>(null);
  // Maps a quality label ("720p") back to the hls.js level index that
  // produced it, so changeQuality() below can call hls.currentLevel = idx
  // without re-deriving it from the label every time.
  const hlsLevelIndexRef = useRef<Map<string, number>>(new Map());

  // --- Settings menu (gear icon): Speed + Quality submenus ---
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<'main' | 'speed' | 'quality'>('main');
  const [speed, setSpeedState] = useState(1);
  const [quality, setQualityState] = useState('auto');
  const [qualityLevels, setQualityLevels] = useState<string[]>([]);
  const settingsRef = useRef<HTMLDivElement>(null);

  // --- Custom control bar auto-hide ---
  // Driven entirely by JS state instead of CSS :hover, because :hover
  // never fires on touch devices — that's why the bar used to get stuck
  // visible on phones (a tap can leave a "sticky hover" until something
  // else is tapped) and never hid itself while simply paused (e.g. a
  // student pausing to copy something down). Any interaction with the
  // player — pointer/touch movement, a tap, a keypress — "wakes" the bar
  // and restarts the same countdown, whether the video is playing or
  // paused; only the open settings menu suspends it.
  const CONTROLS_HIDE_DELAY_MS = 2800;
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsHideTimerRef.current) clearTimeout(controlsHideTimerRef.current);
    if (settingsOpen) return; // menu open: stays up until it's closed (see effect below)
    controlsHideTimerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY_MS);
  }, [settingsOpen]);

  // Settings menu opening/closing directly drives visibility: force the
  // bar up (and cancel any pending hide) while the menu is open, then let
  // wakeControls() restart the normal countdown the instant it closes —
  // this is what makes the bar finally hide itself right after picking a
  // playback speed, instead of only then by coincidence.
  useEffect(() => {
    wakeControls();
    return () => {
      if (controlsHideTimerRef.current) clearTimeout(controlsHideTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  // Restart the countdown whenever playback starts/stops, so pressing
  // play (or pause, to jot down a note) always gets a fresh window before
  // the bar fades — not just mouse/touch movement.
  useEffect(() => {
    wakeControls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytPlaying]);

  // Any real interaction over the player wakes the bar. touchstart/
  // pointerdown cover phones (no mousemove there); mousemove covers
  // desktop without requiring :hover.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onActivity() {
      wakeControls();
    }
    el.addEventListener('mousemove', onActivity);
    el.addEventListener('pointerdown', onActivity);
    el.addEventListener('touchstart', onActivity, { passive: true });
    el.addEventListener('keydown', onActivity);
    return () => {
      el.removeEventListener('mousemove', onActivity);
      el.removeEventListener('pointerdown', onActivity);
      el.removeEventListener('touchstart', onActivity);
      el.removeEventListener('keydown', onActivity);
    };
  }, [wakeControls]);

  // Reports the current watch position to /api/video/[id]/progress —
  // fire-and-forget, best-effort (a failed save just means next load
  // starts from the previous checkpoint instead of the latest one, never
  // blocks or interrupts playback). Uses sendBeacon when available (works
  // even during page unload/tab close, unlike a normal fetch), falling
  // back to a keepalive fetch otherwise.
  const reportProgress = useCallback(
    (position: number, duration?: number) => {
      if (!Number.isFinite(position) || position < 0) return;
      const payload: { position_seconds: number; duration_seconds?: number } = {
        position_seconds: Math.floor(position),
      };
      if (Number.isFinite(duration) && (duration ?? 0) > 0) {
        payload.duration_seconds = Math.floor(duration as number);
      }
      const body = JSON.stringify(payload);
      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          navigator.sendBeacon(`/api/video/${videoId}/progress`, new Blob([body], { type: 'application/json' }));
        } else {
          fetch(`/api/video/${videoId}/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {});
        }
      } catch {
        // best-effort — a dropped progress report is never worth surfacing
      }
    },
    [videoId]
  );

  // Flush whichever provider is currently active on tab close/hide —
  // covers the common case of a student just closing the tab mid-class
  // without ever hitting pause. Also flushed on unmount for in-app (SPA)
  // navigation away from the page, which never fires beforeunload/pagehide.
  useEffect(() => {
    function flush() {
      if (isYoutube && ytPlayerRef.current) {
        reportProgress(ytCurrentTimeRef.current, ytDurationRef.current);
      } else if (isNativeVideo && mp4VideoRef.current) {
        reportProgress(ytCurrentTimeRef.current, ytDurationRef.current);
      } else if (isBunny && playerRef.current) {
        reportProgress(bunnyPositionRef.current, bunnyDurationRef.current);
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [isYoutube, isBunny, isNativeVideo, reportProgress]);

  const fetchPlaybackUrl = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/video/${videoId}/play`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Playback unavailable.');
      if (data.provider) setProvider(data.provider);
      return true;
    } catch {
      return false;
    }
  }, [videoId]);

  // Initial load — skipped when the server already rendered the URL
  // (initialUrl prop, from app/learn/video/[id]/page.tsx): that's the same
  // authorization check, already done server-side, so re-fetching it
  // again immediately on mount would just be a redundant round trip. The
  // heartbeat below still re-verifies on its normal schedule either way.
  useEffect(() => {
    if (initialUrl) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRevoked(false);
    (async () => {
      try {
        const res = await fetch(`/api/video/${videoId}/play`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Playback unavailable.');
        if (!cancelled) {
          setUrl(data.url);
          setProvider(data.provider ?? null);
          if (typeof data.resumeSeconds === 'number') setResumeSeconds(data.resumeSeconds);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Playback unavailable.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Heartbeat: re-checks authorization in the background while the tab
  // stays open, WITHOUT touching the already-loaded iframe on success (so
  // playback is never interrupted for a still-valid session). Only acts
  // on failure — e.g. an admin just revoked this device/IP, or disabled
  // the account — by stopping playback immediately instead of leaving an
  // already-open tab playing indefinitely until it's refreshed.
  useEffect(() => {
    if (!url) return;
    return jitteredInterval(async () => {
      const ok = await fetchPlaybackUrl();
      if (!ok) {
        setRevoked(true);
        setUrl(null);
        ytPlayerRef.current?.destroy();
        ytPlayerRef.current = null;
        mp4VideoRef.current?.pause();
      }
    }, HEARTBEAT_MS);
  }, [url, fetchPlaybackUrl]);

  // Wire up player.js once both the library and the iframe exist. Bunny
  // only — YouTube gets its own IFrame Player API setup below instead.
  useEffect(() => {
    if (!isBunny || !playerJsReady || !url || !iframeRef.current || !window.playerjs) return;
    const player = new window.playerjs.Player(iframeRef.current);
    playerRef.current = player;
    player.on('ready', () => {
      // Force unmuted — autoplay should always start with sound, on
      // every provider, never quietly muted. Bunny's own player would
      // otherwise sometimes decide on its own to autoplay muted.
      player.unmute?.();
      player.on('play', () => {
        isPlayingRef.current = true;
      });
      player.on('pause', () => {
        isPlayingRef.current = false;
        // Save the moment playback pauses — the most common natural
        // checkpoint (student steps away, switches tabs, etc).
        reportProgress(bunnyPositionRef.current, bunnyDurationRef.current);
      });
      // player.js's Bunny implementation fires this continuously during
      // playback with { seconds, duration } — used both to keep the refs
      // above current (for the unload flush) and to drive the periodic
      // save interval below, without polling getCurrentTime ourselves.
      player.on('timeupdate', (data: unknown) => {
        const d = data as { seconds?: number; duration?: number } | undefined;
        if (typeof d?.seconds === 'number') bunnyPositionRef.current = d.seconds;
        if (typeof d?.duration === 'number' && d.duration > 0) bunnyDurationRef.current = d.duration;
      });
      // Resume playback — apply the saved position exactly once, and
      // only if it's not trivially close to the start or the very end
      // (near-end resume would just replay the last few seconds, which
      // reads as broken rather than helpful).
      if (!resumeAppliedRef.current && resumeSeconds && resumeSeconds > 5) {
        resumeAppliedRef.current = true;
        player.getDuration((duration) => {
          if (!duration || duration - resumeSeconds > 10) {
            player.setCurrentTime(resumeSeconds);
            bunnyPositionRef.current = resumeSeconds;
          }
        });
      }
    });
    return () => {
      playerRef.current = null;
    };
  }, [isBunny, playerJsReady, url, resumeSeconds, reportProgress]);

  // No periodic interval-based save for Bunny: player.js already fires
  // 'pause' (saved above) and the tab-hide/unload flush effect already
  // covers the "walked away without pausing" case, so a 15s ticker here
  // was just an extra background request with nothing it alone protects
  // against — removed to cut down on simultaneous request bursts (see
  // jitteredInterval's comment above and lib/supabase/middleware.ts).

  // --- YouTube: load the IFrame Player API script once, globally ---
  useEffect(() => {
    if (!isYoutube) return;
    if (window.YT?.Player) {
      setYtApiReady(true);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      setYtApiReady(true);
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
    }
  }, [isYoutube]);

  // --- YouTube: create the player once the API and a video id are both
  // ready. controls=0 hides EVERY piece of YouTube's own UI — the title
  // bar, the share/link icon, the "Watch on YouTube" logo, all of it —
  // replaced entirely by the custom control bar rendered below. This is
  // the policy-compliant way to do that: YouTube's own IFrame API
  // explicitly supports building a fully custom player this way. Simply
  // overlaying invisible elements on top of YouTube's default UI to
  // selectively block just the branding/link pieces, while leaving the
  // rest of YouTube's native controls in place, is NOT compliant — see
  // "Required Minimum Functionality": blocking a link that would
  // normally appear in the YouTube player is explicitly called out as
  // prohibited. Building a complete replacement UI via the sanctioned
  // API, as done here, is the difference.
  useEffect(() => {
    if (!isYoutube || !ytApiReady || !url || !ytMountRef.current || !window.YT) return;
    const videoGuid = extractYoutubeId(url);
    if (!videoGuid) return;

    setYtBuffering(true);
    const player = new window.YT.Player(ytMountRef.current, {
      videoId: videoGuid,
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        controls: 0,
        rel: 0,
        iv_load_policy: 3,
        playsinline: 1,
        fs: 0, // fullscreen handled by our own button (toggleFullscreen)
        disablekb: 1, // keyboard handled by our own onKeyDown below
        modestbranding: 1,
        origin: window.location.origin,
        // Autoplay on landing, WITH sound first — see the matching
        // comment on the native <video> path below for why this isn't
        // automatically blocked for every visitor. onReady below checks
        // shortly after whether it actually started; if the browser
        // silently refused, THEN it falls back to muted so playback still
        // begins automatically either way.
        autoplay: 1,
      },
      events: {
        onReady: (e) => {
          ytPlayerRef.current = e.target;
          const duration = e.target.getDuration();
          setYtDuration(duration);
          ytDurationRef.current = duration;
          setYtMuted(e.target.isMuted());
          setYtVolume((e.target.getVolume?.() ?? 100) / 100);
          setYtBuffering(false);
          setQualityLevels(e.target.getAvailableQualityLevels?.() ?? []);
          setQualityState(e.target.getPlaybackQuality?.() ?? 'auto');
          setSpeedState(e.target.getPlaybackRate?.() ?? 1);
          // Resume playback — same "not trivially close to start or end"
          // rule as the Bunny path above, applied exactly once per mount.
          if (!resumeAppliedRef.current && resumeSeconds && resumeSeconds > 5) {
            resumeAppliedRef.current = true;
            if (!duration || duration - resumeSeconds > 10) {
              e.target.seekTo(resumeSeconds, true);
              setYtCurrentTime(resumeSeconds);
              ytCurrentTimeRef.current = resumeSeconds;
            }
          }
          // Belt-and-suspenders: playerVars.autoplay should already start
          // this, but calling it explicitly too costs nothing and covers
          // any browser/embed edge case where the declarative flag alone
          // doesn't fire inside an iframe.
          e.target.playVideo();
          // Deliberately NO muted-autoplay fallback here: if the browser
          // silently refuses sound-on autoplay, the class just stays
          // paused on the play-button overlay instead of quietly playing
          // muted — one click starts it normally, with sound, same as
          // the native <video> path above.
        },
        onStateChange: (e) => {
          setYtPlaying(e.data === window.YT?.PlayerState.PLAYING);
          setYtBuffering(e.data === window.YT?.PlayerState.BUFFERING);
          if (e.data === window.YT?.PlayerState.PLAYING) {
            const duration = e.target.getDuration();
            setYtDuration(duration);
            ytDurationRef.current = duration;
          }
          // Save the moment playback pauses or ends — same reasoning as
          // the Bunny 'pause' handler above.
          if (e.data === window.YT?.PlayerState.PAUSED || e.data === window.YT?.PlayerState.ENDED) {
            reportProgress(ytCurrentTimeRef.current, ytDurationRef.current);
          }
        },
      },
    });

    return () => {
      player.destroy?.();
      ytPlayerRef.current = null;
    };
  }, [isYoutube, ytApiReady, url, resumeSeconds, reportProgress]);

  // --- YouTube: poll current time while playing to drive the seek bar.
  // There's no push-based "timeupdate" event in this API — polling is
  // the documented way to track progress.
  useEffect(() => {
    if (!isYoutube || !ytPlaying) return;
    const interval = setInterval(() => {
      if (ytSeekingRef.current) return; // don't fight an in-progress drag
      const yp = ytPlayerRef.current;
      if (!yp) return;
      const t = yp.getCurrentTime();
      setYtCurrentTime(t);
      ytCurrentTimeRef.current = t;
      const buffered = yp.getVideoLoadedFraction?.();
      if (typeof buffered === 'number') setYtBufferedFraction(buffered);
      // Also re-read the real playback quality — YouTube can silently
      // switch this on its own (bandwidth changes, or just overriding a
      // manual selection), so this keeps the settings menu honest instead
      // of showing whatever was last clicked.
      const liveQuality = yp.getPlaybackQuality?.();
      if (liveQuality) setQualityState(liveQuality);
    }, YT_TIME_POLL_MS);
    return () => clearInterval(interval);
  }, [isYoutube, ytPlaying]);

  // Periodic "resume playback" checkpoint while a YouTube class is
  // actually playing — YouTube only. Its IFrame API only tells us about
  // play/pause/end state changes (handled above), not a steady stream of
  // position updates, so without this ticker a crash/power-loss mid-play
  // would lose more progress than the other providers risk losing.
  // mp4/HLS (isNativeVideo) get real 'pause'/'ended' DOM events on the
  // native <video> element itself (see the effect below) and Bunny gets
  // the same from player.js — both already save on those, plus the
  // tab-hide/unload flush effect, so they don't need this extra ticker.
  useEffect(() => {
    if (!isYoutube || !ytPlaying) return;
    return jitteredInterval(() => {
      reportProgress(ytCurrentTimeRef.current, ytDurationRef.current);
    }, PROGRESS_SAVE_MS);
  }, [isYoutube, ytPlaying, reportProgress]);

  // --- Direct Stream / m3u8: wire native <video> events into the same media
  // state the custom control bar reads (see the comment by mp4VideoRef
  // above). No polling needed here — timeupdate/progress/waiting/playing
  // are all real push events, unlike the YouTube IFrame API above. Works
  // identically whichever way the source got into the element — a plain
  // `src=` (mp4) or hls.js feeding MediaSource (m3u8, see the dedicated
  // loading effect right below this one).
  useEffect(() => {
    if (!isNativeVideo || !url) return;
    const v = mp4VideoRef.current;
    if (!v) return;

    function onLoadedMetadata() {
      const duration = v!.duration || 0;
      ytDurationRef.current = duration;
      setYtDuration(duration);
      setYtMuted(v!.muted);
      setYtVolume(v!.volume);
      // Resume playback — same "not trivially close to start or end" rule
      // as the Bunny/YouTube paths above, applied exactly once per mount.
      if (!resumeAppliedRef.current && resumeSeconds && resumeSeconds > 5) {
        resumeAppliedRef.current = true;
        if (!duration || duration - resumeSeconds > 10) {
          v!.currentTime = resumeSeconds;
          ytCurrentTimeRef.current = resumeSeconds;
          setYtCurrentTime(resumeSeconds);
        }
      }
      // Autoplay on landing — WITH sound. Browsers only block
      // autoplay-with-sound when the site doesn't have "media engagement"
      // with this visitor yet (roughly: they haven't played sound here
      // before) — for a returning student who's already watched classes
      // with sound on, this genuinely just plays normally. If the browser
      // does refuse it, we deliberately do NOT fall back to a muted
      // autoplay — that used to auto-mute the class without the student
      // noticing. Instead it just stays paused on the big play-button
      // overlay, same as if autoplay had never been attempted; one click
      // starts it normally, with sound.
      if (!autoplayAttemptedRef.current) {
        autoplayAttemptedRef.current = true;
        v!.muted = false;
        v!.play().catch(() => {
          // Refused — left paused (unmuted) rather than silently
          // retrying muted. The play-button overlay handles it from here.
        });
      }
    }
    function onTimeUpdate() {
      if (ytSeekingRef.current) return; // don't fight an in-progress drag
      const t = v!.currentTime;
      ytCurrentTimeRef.current = t;
      setYtCurrentTime(t);
    }
    function onProgress() {
      const duration = v!.duration || 0;
      if (!duration || v!.buffered.length === 0) return;
      const end = v!.buffered.end(v!.buffered.length - 1);
      setYtBufferedFraction(Math.min(1, end / duration));
    }
    function onPlay() {
      setYtPlaying(true);
    }
    function onPause() {
      setYtPlaying(false);
      // Save the moment playback pauses — same reasoning as the Bunny
      // 'pause' handler above.
      reportProgress(v!.currentTime, v!.duration);
    }
    function onWaiting() {
      setYtBuffering(true);
    }
    function onPlaying() {
      setYtBuffering(false);
    }
    function onVolumeChange() {
      setYtMuted(v!.muted);
      setYtVolume(v!.volume);
    }
    function onEnded() {
      reportProgress(v!.duration, v!.duration);
    }
    // A genuine load failure (CSP block, source down, unsupported
    // format, the host's link expired, etc.) — without this, the element
    // just silently stops, buffering never resolves, and the UI is stuck
    // on "Loading…" forever with no signal to the student or the admin
    // about what actually went wrong.
    function onError() {
      setYtBuffering(false);
      setError('This video failed to load. The source link may be broken or expired.');
    }

    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('progress', onProgress);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('volumechange', onVolumeChange);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('volumechange', onVolumeChange);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNativeVideo, url]);

  // --- HLS playback — two different providers land here:
  //   - 'm3u8' (with a custom Referer, proxied — see
  //     app/api/video/[id]/hls-proxy/route.ts for why the proxy exists):
  //     `url` is already this app's own hls-proxy endpoint, never the
  //     admin's original CDN URL — the browser never learns the real
  //     source or the Referer it took to reach it.
  //   - 'mp4' ("Direct Stream URL") when the admin pasted a .m3u8 link
  //     directly rather than an actual video file — some CDNs serve
  //     perfectly public HLS with no Referer needed at all, so `url`
  //     here is just that raw CDN link, unproxied (isDirectHls above).
  // Either way it's the same hls.js wiring from here on — isHls covers
  // both.
  useEffect(() => {
    if (!isHls || !url) return;
    const v = mp4VideoRef.current;
    if (!v) return;

    // NOTE: this used to branch on v.canPlayType('application/vnd.apple.mpegurl')
    // first and hand playback straight to the native <video> element whenever
    // that returned truthy — which is correct for Safari (no MSE-based HLS
    // engine at all) but ALSO fires "maybe"/"probably" on some Windows
    // Chrome/Edge installs that have an OS-level HEVC/media-extension
    // component registered. Those installs *can* play the stream natively,
    // but native playback exposes zero JS hooks for level count or level
    // switching — so hls.js (and therefore MANIFEST_PARSED, and therefore
    // the whole qualityLevels/Quality-menu state) never even loads, and the
    // Quality submenu permanently shows "only one rendition available"
    // regardless of how many renditions the playlist actually has. hls.js
    // itself is always MSE-based and gives real level data everywhere it's
    // supported, so it's now tried first unconditionally; native src is only
    // the fallback for the genuine "no MSE HLS support" case (real Safari).
    let cancelled = false;
    let hls: import('hls.js').default | null = null;
    let usedNativeSrc = false;
    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = url;
          usedNativeSrc = true;
          return;
        }
        setError('This browser cannot play this video stream.');
        return;
      }
      // Worker disabled deliberately: hls.js's default worker is spun up
      // from a blob: URL, which this site's script-src CSP
      // (next.config.js) doesn't allow — running on the main thread
      // avoids needing to loosen that policy for one feature.
      hls = new Hls({ enableWorker: false });
      hls.loadSource(url);
      hls.attachMedia(v);
      // hls.js marks plenty of genuinely transient hiccups "fatal" too —
      // a single slow/dropped segment request during an ABR quality
      // switch, a manifest reload that timed out once, momentary CDN
      // flakiness — not just an actually-broken stream. hls.js's own
      // docs recommend trying its built-in recovery calls before giving
      // up: startLoad() for network errors, recoverMediaError() for
      // media errors. Only after a few recovery attempts in a row fail
      // to help do we actually tell the viewer to reload — this was
      // previously calling that a dead stream on the very first fatal
      // event, which is what made the "reload page" toast pop up on
      // classes that would have kept playing fine on their own.
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        const instance = hls;
        if (!instance) return;
        // A definitive HTTP client error (403/404/410/…) means retrying
        // the exact same request will just fail the exact same way
        // again — show the real problem right away instead of quietly
        // retrying it first and only surfacing the error a couple of
        // backoff cycles later (which, for a genuinely broken link,
        // looked from the outside like "the error toast never shows").
        const status = data.response?.code;
        const isPermanentHttpError =
          typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (!isPermanentHttpError) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
            networkRecoveries++;
            instance.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
            mediaRecoveries++;
            instance.recoverMediaError();
            return;
          }
        }
        setError('This video failed to load. The stream link may be broken or expired.');
      });
      // A fragment actually made it into the buffer, so the connection
      // is healthy right now — refills the recovery budget above rather
      // than letting a handful of blips early in a 2-hour lecture
      // permanently use it up for the rest of the video.
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        networkRecoveries = 0;
        mediaRecoveries = 0;
      });
      // Populates the same Speed/Quality settings menu the YouTube path
      // uses, driven by real variants this specific playlist advertises
      // (a source with only one rendition just won't have a Quality
      // submenu worth showing — see the qualityLevels.length check where
      // the menu renders).
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        // eslint-disable-next-line no-console
        console.debug(
          '[hls] levels reported by this playlist:',
          data.levels.map((l) => ({ height: l.height, width: l.width, bitrate: l.bitrate }))
        );
        const seen = new Set<string>();
        const map = new Map<string, number>();
        data.levels.forEach((level, idx) => {
          // Most CDNs (including Bunny's) tag every variant with a
          // RESOLUTION, which hls.js exposes as height/width — but a
          // playlist that only sets BANDWIDTH still counts as a real,
          // switchable quality, so this falls back to a "~N kbps" label
          // instead of silently dropping it (which is what left the
          // Quality menu empty before this fallback existed).
          const label = level.height ? `${level.height}p` : level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : null;
          if (!label || seen.has(label)) return; // same resolution at a different bitrate — keep the first
          seen.add(label);
          map.set(label, idx);
        });
        hlsLevelIndexRef.current = map;
        if (map.size > 1) {
          setQualityLevels(['auto', ...Array.from(map.keys())]);
        }
        setQualityState('auto');
      });
      // hls.js decides the actual resolution itself in auto mode — this
      // keeps the displayed quality honest (the real thing currently
      // playing) instead of frozen on whatever "auto" resolved to first.
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = hls?.levels?.[data.level];
        if (level?.height && hls?.autoLevelEnabled) {
          setQualityState(`${level.height}p`);
        }
      });
      hlsRef.current = hls;
    });

    return () => {
      cancelled = true;
      hls?.destroy();
      hlsRef.current = null;
      if (usedNativeSrc) {
        v.removeAttribute('src');
        v.load();
      }
      hlsLevelIndexRef.current = new Map();
      setQualityLevels([]);
      setQualityState('auto');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHls, url]);

  function showHint(text: string) {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), 650);
  }

  function seek(deltaSeconds: number) {
    if (isYoutube) {
      const yp = ytPlayerRef.current;
      if (!yp) return;
      const next = Math.max(0, yp.getCurrentTime() + deltaSeconds);
      yp.seekTo(next, true);
      setYtCurrentTime(next);
    } else if (isNativeVideo) {
      const v = mp4VideoRef.current;
      if (!v) return;
      const next = Math.max(0, v.currentTime + deltaSeconds);
      v.currentTime = next;
      setYtCurrentTime(next);
    } else {
      const player = playerRef.current;
      if (!player) return;
      player.getCurrentTime((current) => {
        player.setCurrentTime(Math.max(0, current + deltaSeconds));
      });
    }
    showHint(deltaSeconds > 0 ? `+${deltaSeconds}s` : `${deltaSeconds}s`);
  }

  function toggleFullscreen() {
    // Deliberately NOT part of either player SDK — fullscreening the
    // wrapping element is a plain browser API and works regardless of
    // what's embedded inside it.
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen?.();
    }
  }

  // The Screen Orientation API's lock() only succeeds in a fullscreen
  // context in most browsers, so this runs off the fullscreenchange
  // event rather than inside toggleFullscreen() itself — requestFullscreen()
  // is async and the element isn't actually fullscreen yet the instant
  // toggleFullscreen() returns. Best-effort throughout: iOS Safari has no
  // Screen Orientation API at all, and unlock() during teardown can throw
  // if the document is already leaving fullscreen — neither should ever
  // surface as a visible error to someone just trying to watch a class.
  useEffect(() => {
    function onFullscreenChange() {
      const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
      if (document.fullscreenElement) {
        orientation?.lock?.('landscape')?.catch(() => {});
      } else {
        try {
          orientation?.unlock?.();
        } catch {
          // ignore — see comment above
        }
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  function togglePlayPause() {
    if (isYoutube) {
      const yp = ytPlayerRef.current;
      if (!yp) return;
      if (yp.getPlayerState() === window.YT?.PlayerState.PLAYING) {
        yp.pauseVideo();
      } else {
        yp.playVideo();
      }
      return;
    }
    if (isNativeVideo) {
      const v = mp4VideoRef.current;
      if (!v) return;
      // .play() returns a promise that can reject for reasons that don't
      // need a visible error — e.g. a play() immediately followed by a
      // pause() (AbortError), which is exactly what a fast double-tap or
      // the hold-to-2x release path can trigger. A genuine failure (CSP
      // block, unsupported source, network error) still shows up via the
      // `error` event → onVideoError below, so it's never silently lost.
      if (v.paused) v.play().catch(() => {});
      else v.pause();
      return;
    }
    const player = playerRef.current;
    if (!player) return;
    if (isPlayingRef.current) {
      player.pause();
    } else {
      player.play();
    }
  }

  function setPlaybackRateNow(rate: number) {
    if (isYoutube) ytPlayerRef.current?.setPlaybackRate(rate);
    else if (isNativeVideo) {
      if (mp4VideoRef.current) mp4VideoRef.current.playbackRate = rate;
    } else playerRef.current?.setPlaybackRate?.(rate);
  }

  // Press-and-hold anywhere on the video: past HOLD_THRESHOLD_MS it jumps
  // to 2× for as long as it's held, like the space-hold shortcut but for
  // touch/mouse directly on the frame. A quick tap/click is unaffected —
  // it still falls through to togglePlayPause via onClick. Only a press
  // that actually crossed the hold threshold suppresses the trailing
  // click, so it doesn't also toggle play/pause on release.
  function handleVideoPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (touchHoldTimerRef.current) clearTimeout(touchHoldTimerRef.current);
    touchHoldTimerRef.current = setTimeout(() => {
      touchHoldingFastRef.current = true;
      setPlaybackRateNow(2);
      showHint('2×');
    }, HOLD_THRESHOLD_MS);
  }

  function endVideoHold() {
    if (touchHoldTimerRef.current) {
      clearTimeout(touchHoldTimerRef.current);
      touchHoldTimerRef.current = null;
    }
    if (touchHoldingFastRef.current) {
      touchHoldingFastRef.current = false;
      setPlaybackRateNow(1);
      showHint('1×');
      suppressNextVideoClickRef.current = true;
    }
  }

  function handleVideoClick() {
    if (suppressNextVideoClickRef.current) {
      suppressNextVideoClickRef.current = false;
      return;
    }
    togglePlayPause();
  }

  // Close the settings menu on any click outside it (mirrors the pattern
  // used by VideoDownloadButton's own menu).
  useEffect(() => {
    if (!settingsOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
        setSettingsPanel('main');
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [settingsOpen]);

  function changeSpeed(rate: number) {
    setPlaybackRateNow(rate);
    setSpeedState(rate);
    setSettingsOpen(false);
    setSettingsPanel('main');
    showHint(rate === 1 ? 'Normal speed' : `${rate}×`);
  }

  // NOTE: as of Google's own IFrame API docs, getPlaybackQuality,
  // setPlaybackQuality, and getAvailableQualityLevels are officially
  // "no longer supported" — setPlaybackQuality is now a documented no-op
  // with zero effect on what the viewer sees, for every YouTube embed,
  // not just this one. There is no client-side workaround for that half
  // of this function; see https://developers.google.com/youtube/iframe_api_reference
  // ("Deprecations and changes"). It's still called for the rare case
  // where the embed itself reports more than one real level (see the
  // qualityLevels.length > 1 branch below) — best-effort only. For HLS
  // (m3u8 provider or a direct .m3u8 URL under mp4 — see isHls above),
  // this is the real thing: hls.currentLevel actually switches the
  // rendition immediately — no platform restriction like YouTube's,
  // since this app controls the player end-to-end either way.
  function changeQuality(level: string) {
    if (isHls) {
      const hls = hlsRef.current;
      if (hls) {
        hls.currentLevel = level === 'auto' ? -1 : (hlsLevelIndexRef.current.get(level) ?? -1);
      }
    } else {
      ytPlayerRef.current?.setPlaybackQuality(level);
    }
    setQualityState(level);
    setSettingsOpen(false);
    setSettingsPanel('main');
  }

  function toggleMute(): boolean {
    if (isNativeVideo) {
      const v = mp4VideoRef.current;
      if (!v) return ytMuted;
      v.muted = !v.muted;
      setYtMuted(v.muted);
      return v.muted;
    }
    const yp = ytPlayerRef.current;
    if (!yp) return ytMuted;
    if (yp.isMuted()) {
      yp.unMute();
      setYtMuted(false);
      return false;
    }
    yp.mute();
    setYtMuted(true);
    return true;
  }

  function changeVolume(value: number) {
    const clamped = Math.min(1, Math.max(0, value));
    if (isNativeVideo) {
      const v = mp4VideoRef.current;
      if (!v) return;
      v.volume = clamped;
      setYtVolume(clamped);
      v.muted = clamped === 0;
      setYtMuted(clamped === 0);
      return;
    }
    const yp = ytPlayerRef.current;
    if (!yp) return;
    yp.setVolume(clamped * 100);
    setYtVolume(clamped);
    if (clamped === 0) {
      if (!yp.isMuted()) yp.mute();
      setYtMuted(true);
    } else if (yp.isMuted()) {
      yp.unMute();
      setYtMuted(false);
    }
  }

  function onSeekBarChange(value: number) {
    ytSeekingRef.current = true;
    setYtCurrentTime(value);
  }

  function commitSeekBar(value: number) {
    if (isNativeVideo) {
      if (mp4VideoRef.current) mp4VideoRef.current.currentTime = value;
    } else {
      ytPlayerRef.current?.seekTo(value, true);
    }
    setYtCurrentTime(value);
    // Small delay before resuming the poll-driven sync, so the just-set
    // value doesn't get immediately overwritten by a still-in-flight
    // getCurrentTime() call from before the seek actually landed.
    setTimeout(() => {
      ytSeekingRef.current = false;
    }, 300);
  }

  // Drag-to-seek on the custom track below (a plain <input type=range>
  // can't easily grow a buffered-bar + hover-thumb visual across
  // browsers, so this is a bare div + pointer events instead).
  function handleSeekPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const track = e.currentTarget;
    const duration = ytDuration || 0;
    if (!duration) return;
    ytSeekingRef.current = true;
    const ratioFromEvent = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    };
    onSeekBarChange(ratioFromEvent(e.clientX) * duration);
    track.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => onSeekBarChange(ratioFromEvent(ev.clientX) * duration);
    const onUp = (ev: PointerEvent) => {
      commitSeekBar(ratioFromEvent(ev.clientX) * duration);
      track.releasePointerCapture(ev.pointerId);
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
    };
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
  }

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      const hasPlayer = isYoutube
        ? !!ytPlayerRef.current
        : isNativeVideo
          ? !!mp4VideoRef.current
          : !!playerRef.current;
      if (isTypingTarget(e.target) || !hasPlayer) return;

      if (e.code === 'ArrowRight') {
        e.preventDefault();
        seek(SEEK_SECONDS);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seek(-SEEK_SECONDS);
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        showHint(toggleMute() ? 'Muted' : 'Unmuted');
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (spaceDownRef.current) return; // ignore OS key-repeat
        spaceDownRef.current = true;
        holdTimerRef.current = setTimeout(() => {
          // Held past the threshold: switch to fast playback instead of
          // toggling play/pause.
          holdingFastRef.current = true;
          setPlaybackRateNow(2);
          showHint('2×');
        }, HOLD_THRESHOLD_MS);
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== 'Space') return;
      // Same typing-target guard as onKeyDown: without this, a space
      // pressed while focused in a text field (e.g. the comment box on
      // the class page) never toggles playback on keydown (that's
      // already guarded), but its matching keyup still fired
      // unconditionally and DID toggle play/pause — because keydown
      // never ran for it, spaceDownRef was never set, but this handler
      // didn't check that either, so it just went straight to
      // togglePlayPause(). Bailing out here the same way keydown does
      // closes that gap.
      if (isTypingTarget(e.target)) return;
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      spaceDownRef.current = false;

      if (holdingFastRef.current) {
        holdingFastRef.current = false;
        setPlaybackRateNow(1);
        showHint('1×');
      } else {
        togglePlayPause();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (touchHoldTimerRef.current) clearTimeout(touchHoldTimerRef.current);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isYoutube, isNativeVideo]);

  return (
    <div ref={containerRef} className="group relative aspect-video w-full overflow-hidden rounded-xl border border-vault-border bg-vault-800">
      {isBunny && (
        <Script
          src="https://assets.mediadelivery.net/playerjs/playerjs-latest.min.js"
          strategy="afterInteractive"
          onLoad={() => setPlayerJsReady(true)}
        />
      )}

      {/* Class's own thumbnail as the backdrop for every "nothing is
          playing yet" state (verifying access, revoked, failed) — same
          idea as a native <video poster>, but also covering the iframe
          providers (Bunny/YouTube) which have no poster attribute of
          their own. Never shown once a provider actually has something
          on screen — see the !loading && !error && !revoked guards below. */}
      {(loading || error || revoked) && thumbnailUrl && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${thumbnailUrl})` }}
        >
          {/* Plain semi-transparent overlay, not backdrop-blur — blurring
              the whole frame behind the spinner every frame is expensive
              (this is what made the spinner feel laggy after this was
              first added), and a video thumbnail dims down to readable
              contrast just fine without it. */}
          <div className="absolute inset-0 bg-vault-950/70" />
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <PlayerLoadingSpinner label="Verifying access…" />
        </div>
      )}

      {revoked && !loading && (
        <PlayerProblemToast
          title="Access revoked"
          message="This session is no longer authorized to play this class. Reload the page if you believe this is a mistake."
          fixLabel="Refresh page"
        />
      )}

      {error &&
        !loading &&
        !revoked &&
        (() => {
          const explained = explainPlaybackError(error);
          return (
            <PlayerProblemToast title={explained.title} message={explained.message} fixLabel={explained.fixLabel} />
          );
        })()}

      {isBunny && url && !loading && !error && !revoked && (
        // A signed, ~10-minute embed token (see /api/video/[id]/play) —
        // fetched fresh per session, expires, and is restricted to
        // Bunny's configured "Allowed Referrers".
        <iframe
          ref={iframeRef}
          src={withBunnyAutoplay(url)}
          loading="lazy"
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; clipboard-write; web-share"
          allowFullScreen
          className="h-full w-full border-0"
        />
      )}

      {(isYoutube || isNativeVideo) && url && !loading && !error && !revoked && (
        <>
          {/* Press-and-hold anywhere on the frame jumps to 2× (see
              handleVideoPointerDown); a normal tap/click still toggles
              play/pause via handleVideoClick. */}
          {isYoutube ? (
            // YT.Player takes this div over and injects its own iframe —
            // no other React children ever go inside it.
            <div
              className="absolute inset-0"
              onClick={handleVideoClick}
              onPointerDown={handleVideoPointerDown}
              onPointerUp={endVideoHold}
              onPointerCancel={endVideoHold}
              onPointerLeave={endVideoHold}
            >
              <div ref={ytMountRef} className="pointer-events-none h-full w-full" />
            </div>
          ) : (
            // Plain <video>, never an <iframe> — the source's own
            // page/scripts (ads, redirects, etc.) never get a chance to
            // run, since the browser is just requesting media bytes.
            // No `controls` attribute: same fully custom control bar
            // below as the YouTube path, not the browser's native one.
            // For m3u8, `src` is left unset here — the dedicated HLS
            // effect above attaches hls.js (or, on Safari, sets src
            // itself) once this element exists, rather than the browser
            // trying to load `url` (the hls-proxy playlist) as if it
            // were a single playable file.
            <video
              ref={mp4VideoRef}
              src={isHls ? undefined : url}
              poster={thumbnailUrl ?? undefined}
              playsInline
              preload="metadata"
              controlsList="nodownload"
              className="h-full w-full bg-black object-contain"
              onClick={handleVideoClick}
              onPointerDown={handleVideoPointerDown}
              onPointerUp={endVideoHold}
              onPointerCancel={endVideoHold}
              onPointerLeave={endVideoHold}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}

          {ytBuffering && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-vault-950/30">
              <PlayerLoadingSpinner />
            </div>
          )}

          {!ytPlaying && !ytBuffering && (
            <button
              onClick={togglePlayPause}
              aria-label="Play"
              className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-vault-950 shadow-glass transition hover:scale-105"
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5.5v13l11-6.5-11-6.5Z" />
              </svg>
            </button>
          )}

          {/* Custom control bar — replaces YouTube's native one entirely
              (controls=0 above). Auto-hides after a short idle period via
              JS (controlsVisible), not CSS :hover — :hover doesn't exist
              on touch, which used to leave this stuck visible (or stuck
              hidden) on phones. Any interaction restarts the timer, and
              it's held up for as long as the settings menu is open.
              Floating glass pill (not edge-to-edge), with a two-row
              layout: drag-to-seek track on top, controls below — same
              shape as a typical polished HLS player control bar. */}
          <div
            onClick={(e) => e.stopPropagation()}
            className={`absolute inset-x-2 sm:inset-x-3 bottom-2 sm:bottom-3 z-30 rounded-2xl border border-white/10 bg-black/50 px-2.5 pb-2 pt-3 shadow-[0_12px_36px_-8px_rgba(0,0,0,0.6)] backdrop-blur-xl transition-all duration-300 sm:px-4 sm:pb-2.5 sm:pt-3.5 ${
              controlsVisible || settingsOpen
                ? 'translate-y-0 opacity-100'
                : 'pointer-events-none translate-y-2 opacity-0'
            }`}
          >
            {/* Seek track: base (full), buffered (loaded fraction), played
                (current position), and a thumb that only appears on hover
                — same visual language as the reference control bar. */}
            <div
              onPointerDown={handleSeekPointerDown}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={ytDuration || 0}
              aria-valuenow={ytCurrentTime}
              className="group/seek relative mb-2.5 flex h-1.5 w-full cursor-pointer items-center transition-all duration-150 hover:h-2"
            >
              <div className="absolute left-0 right-0 h-full rounded-full bg-white/20" />
              <div
                className="absolute left-0 h-full rounded-full bg-white/35"
                style={{ width: `${Math.min(100, ytBufferedFraction * 100)}%` }}
              />
              <div
                className="absolute left-0 h-full rounded-full bg-gradient-to-r from-signal to-signal/70 shadow-[0_0_10px_-1px] shadow-signal/70"
                style={{ width: `${ytDuration ? Math.min(100, (ytCurrentTime / ytDuration) * 100) : 0}%` }}
              />
              <div
                className="absolute -ml-1.5 h-3 w-3 scale-75 rounded-full bg-white opacity-0 shadow-[0_2px_8px_rgba(0,0,0,0.5)] ring-2 ring-signal transition-all duration-150 group-hover/seek:scale-100 group-hover/seek:opacity-100 group-hover/seek:h-4 group-hover/seek:w-4"
                style={{ left: `${ytDuration ? Math.min(100, (ytCurrentTime / ytDuration) * 100) : 0}%` }}
              />
            </div>

            <div className="flex items-center gap-1 sm:gap-1.5 text-white">
              <button onClick={togglePlayPause} aria-label={ytPlaying ? 'Pause' : 'Play'} className={CTRL_BTN_CLASS}>
                {ytPlaying ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5.5v13l11-6.5-11-6.5Z" />
                  </svg>
                )}
              </button>

              <button onClick={() => seek(-SEEK_SECONDS)} aria-label="Back 10 seconds" className={CTRL_BTN_CLASS}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M6 12a8 8 0 1 1 2.4 5.7M6 12v5M6 12H1"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <text x="12" y="15" fontSize="7" fill="currentColor" textAnchor="middle" fontFamily="monospace">
                    10
                  </text>
                </svg>
              </button>

              <button onClick={() => seek(SEEK_SECONDS)} aria-label="Forward 10 seconds" className={CTRL_BTN_CLASS}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M18 12a8 8 0 1 0-2.4 5.7M18 12v5M18 12h5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <text x="12" y="15" fontSize="7" fill="currentColor" textAnchor="middle" fontFamily="monospace">
                    10
                  </text>
                </svg>
              </button>

              {/* Volume: icon + a slider that only widens on hover (desktop) —
                  collapsed to just the mute toggle on touch/narrow screens,
                  same as the reference bar hiding it below sm. */}
              <div className="group/vol hidden items-center gap-1 sm:flex">
                <button onClick={toggleMute} aria-label={ytMuted ? 'Unmute' : 'Mute'} className={CTRL_BTN_CLASS}>
                  {ytMuted || ytVolume === 0 ? (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
                      <path d="m16 9 4 6M20 9l-4 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
                      <path
                        d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={ytMuted ? 0 : ytVolume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                  aria-label="Volume"
                  className="w-0 cursor-pointer overflow-hidden accent-signal transition-[width] duration-200 group-hover/vol:w-16"
                />
              </div>

              <span className="ml-1 whitespace-nowrap text-xs font-semibold tabular-nums text-white/95 sm:text-sm">
                {formatTime(ytCurrentTime)} <span className="font-normal text-white/50">/</span>{' '}
                {formatTime(ytDuration)}
              </span>

              <div className="flex-1" />

              <div ref={settingsRef} className="relative">
                <button
                  onClick={() => {
                    setSettingsOpen((v) => !v);
                    setSettingsPanel('main');
                  }}
                  aria-label="Settings"
                  className={CTRL_BTN_CLASS}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                    <path
                      d="m19.4 13-.1-1-.1-1 1.6-1.3-2-3.4-2 .6-1.7-1-.3-2h-4l-.3 2-1.7 1-2-.6-2 3.4L6.3 11l-.1 1 .1 1-1.6 1.3 2 3.4 2-.6 1.7 1 .3 2h4l.3-2 1.7-1 2 .6 2-3.4L19.4 13Z"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </button>

                {settingsOpen && (
                <div className="absolute bottom-8 right-0 z-20 w-48 overflow-hidden rounded-2xl border border-white/10 bg-black/75 py-1.5 text-xs text-white shadow-2xl backdrop-blur-2xl">
                  {settingsPanel === 'main' && (
                    <>
                      <button
                        onClick={() => setSettingsPanel('speed')}
                        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition hover:bg-white/10"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 text-white/70">
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                          <path
                            d="M12 12 15.5 8.5M12 7v1.2M12 16.8V18M6.2 12H7.4M16.6 12h1.2"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                        <span className="flex-1">Speed</span>
                        <span className="flex items-center gap-1 text-white/50">
                          {speed === 1 ? 'Normal' : `${speed}×`}
                          <span aria-hidden>›</span>
                        </span>
                      </button>
                      <button
                        onClick={() => setSettingsPanel('quality')}
                        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition hover:bg-white/10"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 text-white/70">
                          <rect x="3" y="6" width="18" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                          <path
                            d="M7.5 10v4M10.5 10v4M7.5 12h3M13.5 10v4h1.6a1.4 1.4 0 0 0 1.4-1.4v-1.2a1.4 1.4 0 0 0-1.4-1.4H13.5Z"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span className="flex-1">Quality</span>
                        <span className="flex items-center gap-1 text-white/50">
                          {QUALITY_LABELS[quality] ?? quality}
                          <span aria-hidden>›</span>
                        </span>
                      </button>
                      <p className="px-3.5 pb-1.5 pt-0.5 text-[10px] leading-snug text-white/35">
                        {isHls
                          ? qualityLevels.length > 1
                            ? 'Auto picks the best resolution for your connection — or choose one yourself.'
                            : 'This stream only has one rendition available.'
                          : isMp4
                            ? 'This is a single, fixed-quality video file.'
                            : 'YouTube manages quality automatically for embedded players.'}
                      </p>
                    </>
                  )}

                  {settingsPanel === 'speed' && (
                    <>
                      <button
                        onClick={() => setSettingsPanel('main')}
                        className="flex w-full items-center gap-1.5 border-b border-white/10 px-3.5 py-2.5 text-left font-medium"
                      >
                        <span aria-hidden>‹</span> Speed
                      </button>
                      {SPEED_OPTIONS.map((rate) => (
                        <button
                          key={rate}
                          onClick={() => changeSpeed(rate)}
                          className="flex w-full items-center justify-between px-3.5 py-2 text-left transition hover:bg-white/10"
                        >
                          <span className={rate === speed ? 'text-signal-glow' : ''}>
                            {rate === 1 ? 'Normal' : `${rate}×`}
                          </span>
                          {speed === rate && (
                            <span aria-hidden className="text-signal-glow">
                              ✓
                            </span>
                          )}
                        </button>
                      ))}
                    </>
                  )}

                  {settingsPanel === 'quality' && (
                    <>
                      <button
                        onClick={() => setSettingsPanel('main')}
                        className="flex w-full items-center gap-1.5 border-b border-white/10 px-3.5 py-2.5 text-left font-medium"
                      >
                        <span aria-hidden>‹</span> Quality
                      </button>
                      {qualityLevels.length > 1 ? (
                        // For YouTube this is a rare case the API still
                        // allows but is free to ignore (see the NOTE above
                        // changeQuality). For m3u8 it's a real, guaranteed
                        // switch — hls.currentLevel actually changes what's
                        // being decoded, since this app controls both ends.
                        qualityLevels.map((level) => (
                          <button
                            key={level}
                            onClick={() => changeQuality(level)}
                            className="flex w-full items-center justify-between px-3.5 py-2 text-left transition hover:bg-white/10"
                          >
                            <span className={level === quality ? 'text-signal-glow' : ''}>
                              {QUALITY_LABELS[level] ?? level}
                            </span>
                            {quality === level && (
                              <span aria-hidden className="text-signal-glow">
                                ✓
                              </span>
                            )}
                          </button>
                        ))
                      ) : (
                        <div className="px-3.5 py-3 text-left">
                          <p className="flex items-center gap-1.5">
                            <span className="text-signal-glow">
                              {QUALITY_LABELS[quality] ?? quality}
                            </span>
                            <span className="text-white/40">— currently playing</span>
                          </p>
                          <p className="mt-1.5 text-[10px] leading-snug text-white/40">
                            {isHls
                              ? 'This stream only has one rendition available, so there is nothing to switch between.'
                              : isMp4
                                ? 'This is a single video file, uploaded at one fixed quality — there is nothing to switch between.'
                                : "YouTube's embedded player no longer accepts manual quality requests — it picks resolution itself based on connection speed and window size, and there's no way for any site embedding YouTube to override that."}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <button onClick={toggleFullscreen} aria-label="Fullscreen" className={CTRL_BTN_CLASS}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            </div>
          </div>
        </>
      )}

      {hint && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-vault-950/80 px-4 py-2 font-mono text-sm text-white shadow-glass backdrop-blur-sm">
          {hint}
        </div>
      )}

      {isBunny && url && !loading && !error && !revoked && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-vault-950/70 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-white/70 opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
          ←/→ 10s · Space play/pause (hold 2×) · F fullscreen
        </div>
      )}
    </div>
  );
}
