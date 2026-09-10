/**
 * Collects best-effort hardware/OS signals from the browser — the
 * pieces of information that stay the SAME no matter which browser is
 * open on a given physical machine (screen resolution, timezone, CPU
 * core count, etc), plus a FingerprintJS visitorId that's specific to
 * THIS browser install.
 *
 * Why both kinds, and why neither is a silver bullet:
 *  - The hardware/OS signals (screen_width/height, color_depth,
 *    timezone, hardware_concurrency, device_memory, max_touch_points,
 *    platform, languages) come from the operating system and physical
 *    display, not the browser engine — Chrome and Firefox on the same
 *    laptop report the identical screen resolution and timezone. This
 *    is what lib/deviceSimilarity.ts leans on to say "these two device
 *    rows are probably the same physical machine."
 *  - FingerprintJS's visitorId, by contrast, is derived partly from
 *    canvas/font/WebGL rendering, which genuinely DIFFERS between
 *    browser engines even on identical hardware — so it will NOT match
 *    across Chrome vs Firefox on the same laptop. What it IS good for:
 *    confirming "this is still the same browser install as before"
 *    even if the device_id cookie itself got cleared — a much stronger
 *    signal than the cookie alone for that narrower question.
 *
 * Every field is optional on purpose (see deviceSignalsSchema in
 * lib/validation.ts) — Safari and Firefox withhold navigator.deviceMemory
 * entirely by design, older browsers lack most of these APIs, and none
 * of that should stop the rest of the signals from being collected and
 * reported.
 *
 * This is intentionally NOT under 'server-only' or 'use client' itself
 * (it's a plain function) — components/DeviceSignalCollector.tsx, a
 * client component, is what actually calls it in the browser.
 */
export type DeviceSignals = {
  screen_width?: number;
  screen_height?: number;
  color_depth?: number;
  timezone?: string;
  languages?: string[];
  hardware_concurrency?: number;
  device_memory?: number;
  max_touch_points?: number;
  platform?: string;
  fingerprint_visitor_id?: string;
};

/** Human labels for the signal categories — shared by the single-device
 * view and the comparison table in the admin panel (see
 * app/admin/users/[id]/page.tsx) so both use identical wording. */
export const SIGNAL_LABELS: Record<string, string> = {
  screen: 'Screen size',
  color_depth: 'Color depth',
  timezone: 'Timezone',
  hardware_concurrency: 'CPU cores',
  device_memory: 'Device memory',
  max_touch_points: 'Touch points',
  platform: 'OS platform',
  languages: 'Language',
};

export type SignalRow = { key: string; label: string; value: string | null };

/**
 * Turns one device's raw signals into a fixed, ordered list of
 * human-readable rows — always all 8 categories, `value: null` for
 * whatever this particular browser didn't report (Safari/Firefox never
 * send device_memory, for instance). This is the single source of
 * truth for "how does one signal look on screen" — both the admin
 * panel's plain single-device view and lib/deviceSimilarity.ts's
 * pairwise comparison table are built from calling this on each side
 * and lining the rows up, rather than formatting values twice in two
 * different places that could drift out of sync.
 */
export function describeDeviceSignals(s: DeviceSignals): SignalRow[] {
  return [
    {
      key: 'screen',
      label: SIGNAL_LABELS.screen,
      value: s.screen_width && s.screen_height ? `${s.screen_width}×${s.screen_height}` : null,
    },
    { key: 'color_depth', label: SIGNAL_LABELS.color_depth, value: s.color_depth != null ? `${s.color_depth}-bit` : null },
    { key: 'timezone', label: SIGNAL_LABELS.timezone, value: s.timezone ?? null },
    {
      key: 'hardware_concurrency',
      label: SIGNAL_LABELS.hardware_concurrency,
      value: s.hardware_concurrency != null ? `${s.hardware_concurrency}` : null,
    },
    {
      key: 'device_memory',
      label: SIGNAL_LABELS.device_memory,
      value: s.device_memory != null ? `${s.device_memory} GB` : null,
    },
    {
      key: 'max_touch_points',
      label: SIGNAL_LABELS.max_touch_points,
      value: s.max_touch_points != null ? `${s.max_touch_points}` : null,
    },
    { key: 'platform', label: SIGNAL_LABELS.platform, value: s.platform ?? null },
    { key: 'languages', label: SIGNAL_LABELS.languages, value: s.languages?.length ? s.languages[0] : null },
  ];
}

export async function collectDeviceSignals(): Promise<DeviceSignals> {
  const signals: DeviceSignals = {};

  try {
    if (typeof screen !== 'undefined') {
      signals.screen_width = screen.width;
      signals.screen_height = screen.height;
      signals.color_depth = screen.colorDepth;
    }
    signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (navigator.languages?.length) signals.languages = [...navigator.languages];
    else if (navigator.language) signals.languages = [navigator.language];
    if (typeof navigator.hardwareConcurrency === 'number') {
      signals.hardware_concurrency = navigator.hardwareConcurrency;
    }
    // deviceMemory is Chromium-only (Client Hints spec) — Safari and
    // Firefox never define it, hence the guarded access rather than an
    // assumption it exists.
    const nav = navigator as Navigator & { deviceMemory?: number };
    if (typeof nav.deviceMemory === 'number') signals.device_memory = nav.deviceMemory;
    if (typeof navigator.maxTouchPoints === 'number') signals.max_touch_points = navigator.maxTouchPoints;
    // navigator.platform is deprecated but still widely supported and,
    // unlike the User-Agent string, isn't rewritten by "Request desktop
    // site" toggles — kept as a coarse OS fallback alongside the
    // Sec-CH-UA-Platform header lib/requestInfo.ts already reads
    // server-side.
    if (navigator.platform) signals.platform = navigator.platform;
  } catch {
    // Best-effort only — a missing/blocked API just means fewer
    // signals get reported, never a broken sign-in.
  }

  try {
    // Dynamically imported so it's never bundled into a page that
    // doesn't render DeviceSignalCollector, and so a failure to load it
    // (ad blockers occasionally flag fingerprinting libraries by name)
    // doesn't stop the hardware/OS signals above from still being sent.
    const FingerprintJS = (await import('@fingerprintjs/fingerprintjs')).default;
    const fp = await FingerprintJS.load();
    const result = await fp.get();
    signals.fingerprint_visitor_id = result.visitorId;
  } catch {
    // Fine — the hardware/OS signals alone are still useful without it.
  }

  return signals;
}
