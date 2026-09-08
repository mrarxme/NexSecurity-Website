import type { DeviceSignals } from '@/lib/deviceSignals';

export type DeviceMatch = {
  /** 0–1. Never treat this as a probability in the statistical sense —
   * it's a simple "how many of the comparable signals agree" score,
   * meant to guide a human's eye, not to auto-decide anything. */
  score: number;
  matchedSignals: string[];
  comparedSignals: number;
  /** True only when BOTH sides reported a FingerprintJS visitorId AND
   * they're identical — a near-certain "same browser install" signal,
   * kept separate from the hardware-based score because it answers a
   * different question (see lib/deviceSignals.ts's doc comment). */
  sameBrowserFingerprint: boolean;
  label: 'likely-same-device' | 'possibly-same-device' | 'different-device' | 'not-enough-data';
};

// Weighted so that harder-to-coincidentally-match signals count for
// more: two machines sharing an exact screen resolution AND timezone
// AND core count is a much stronger coincidence than sharing just a
// language. IP is deliberately NOT included here — it's already shown
// to the admin separately (ip_address/ip_history) and changes far more
// often than any of these (wifi <-> mobile data), so folding it into
// this score would make it noisier, not better.
const SIGNAL_WEIGHTS: Record<string, number> = {
  screen: 2, // width+height together, since they're only meaningful as a pair
  color_depth: 0.5,
  timezone: 1.5,
  hardware_concurrency: 1.5,
  device_memory: 1,
  max_touch_points: 1,
  platform: 1.5,
  languages: 1,
};

function sameLanguages(a?: string[], b?: string[]): boolean {
  if (!a?.length || !b?.length) return false;
  return a[0]?.toLowerCase() === b[0]?.toLowerCase();
}

/**
 * Compares two devices' best-effort signals (see lib/deviceSignals.ts)
 * and returns a rough "is this likely the same physical machine" hint
 * for the admin panel — used when a user opens a second browser on a
 * machine that already has an authorized device, so the pending
 * request doesn't look like a stranger's device out of nowhere.
 *
 * This is a HEURISTIC over a handful of coarse signals, not a forensic
 * match — treat the label as a hint to look closer, never as proof.
 */
export function compareDeviceSignals(a: DeviceSignals, b: DeviceSignals): DeviceMatch {
  const matchedSignals: string[] = [];
  let matchedWeight = 0;
  let comparedWeight = 0;
  let comparedSignals = 0;

  function consider(key: keyof typeof SIGNAL_WEIGHTS, isMatch: boolean | null) {
    if (isMatch === null) return; // one or both sides didn't report this signal
    comparedWeight += SIGNAL_WEIGHTS[key];
    comparedSignals += 1;
    if (isMatch) {
      matchedWeight += SIGNAL_WEIGHTS[key];
      matchedSignals.push(key);
    }
  }

  consider('screen', a.screen_width && b.screen_width ? a.screen_width === b.screen_width && a.screen_height === b.screen_height : null);
  consider('color_depth', a.color_depth != null && b.color_depth != null ? a.color_depth === b.color_depth : null);
  consider('timezone', a.timezone && b.timezone ? a.timezone === b.timezone : null);
  consider(
    'hardware_concurrency',
    a.hardware_concurrency != null && b.hardware_concurrency != null ? a.hardware_concurrency === b.hardware_concurrency : null
  );
  consider('device_memory', a.device_memory != null && b.device_memory != null ? a.device_memory === b.device_memory : null);
  consider(
    'max_touch_points',
    a.max_touch_points != null && b.max_touch_points != null ? a.max_touch_points === b.max_touch_points : null
  );
  consider('platform', a.platform && b.platform ? a.platform === b.platform : null);
  consider('languages', a.languages?.length && b.languages?.length ? sameLanguages(a.languages, b.languages) : null);

  const sameBrowserFingerprint = Boolean(
    a.fingerprint_visitor_id && b.fingerprint_visitor_id && a.fingerprint_visitor_id === b.fingerprint_visitor_id
  );

  // Need at least a couple of comparable signals before saying anything
  // — one lonely match (e.g. both just happen to be on Chrome/Windows,
  // the most common combination on earth) isn't meaningful on its own.
  if (comparedSignals < 3) {
    return {
      score: 0,
      matchedSignals,
      comparedSignals,
      sameBrowserFingerprint,
      label: 'not-enough-data',
    };
  }

  const score = comparedWeight > 0 ? matchedWeight / comparedWeight : 0;
  const label: DeviceMatch['label'] = score >= 0.8 ? 'likely-same-device' : score >= 0.5 ? 'possibly-same-device' : 'different-device';

  return { score, matchedSignals, comparedSignals, sameBrowserFingerprint, label };
}

/**
 * Compares one candidate device against a list of the user's other
 * devices and returns the single best match, if any signals were
 * comparable at all. Used to find "which of this user's ALREADY
 * AUTHORIZED devices does this pending one most resemble" — see
 * app/api/admin/users/[id]/devices/route.ts.
 */
export function bestDeviceMatch<T extends { id: string; signals: DeviceSignals | null }>(
  candidate: DeviceSignals,
  others: T[]
): (DeviceMatch & { deviceRowId: string }) | null {
  let best: (DeviceMatch & { deviceRowId: string }) | null = null;

  for (const other of others) {
    if (!other.signals) continue;
    const match = compareDeviceSignals(candidate, other.signals);
    if (match.label === 'not-enough-data') continue;
    if (!best || match.score > best.score) {
      best = { ...match, deviceRowId: other.id };
    }
  }

  return best;
}
