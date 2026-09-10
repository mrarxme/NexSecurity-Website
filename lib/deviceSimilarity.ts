import { describeDeviceSignals, type DeviceSignals } from '@/lib/deviceSignals';

/** One signal category's side-by-side result — this device's value,
 * the compared device's value, and whether they matched. Always
 * present for all 8 categories (unlike the old matchedSignals-only
 * shape), so the admin panel can show a complete table instead of just
 * the ones that happened to agree — "ki ki same, ki ki alada" needs
 * both sides visible, not just the matches. */
export type SignalComparisonRow = {
  key: string;
  status: 'match' | 'mismatch' | 'unavailable';
  valueA: string | null;
  valueB: string | null;
};

export type DeviceMatch = {
  /** 0–1. Never treat this as a probability in the statistical sense —
   * it's a simple "how many of the comparable signals agree" score,
   * meant to guide a human's eye, not to auto-decide anything. */
  score: number;
  matchedSignals: string[];
  comparedSignals: number;
  /** Full per-category breakdown, always all 8 rows — see
   * SignalComparisonRow. This is what the admin panel's "Compare
   * details" table renders directly. */
  comparisons: SignalComparisonRow[];
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

/**
 * Compares two devices' best-effort signals (see lib/deviceSignals.ts)
 * and returns both a rough "is this likely the same physical machine"
 * hint AND the full per-signal breakdown behind it — so the admin
 * panel can show a human exactly what matched and what didn't, rather
 * than just asserting a verdict. This is a HEURISTIC over a handful of
 * coarse signals, not a forensic match — the label is a hint to look
 * closer, never proof, and the underlying comparisons are there so an
 * admin can judge that for themselves instead of taking the label on
 * faith.
 */
export function compareDeviceSignals(a: DeviceSignals, b: DeviceSignals): DeviceMatch {
  const rowsA = describeDeviceSignals(a);
  const rowsB = describeDeviceSignals(b);

  const comparisons: SignalComparisonRow[] = [];
  const matchedSignals: string[] = [];
  let matchedWeight = 0;
  let comparedWeight = 0;
  let comparedSignals = 0;

  for (let i = 0; i < rowsA.length; i++) {
    const key = rowsA[i].key;
    const valueA = rowsA[i].value;
    const valueB = rowsB[i].value;

    if (valueA == null || valueB == null) {
      // One or both sides never reported this category (e.g. Safari
      // never sends device_memory) — shown to the admin as
      // "unavailable" rather than silently omitted, so it's clear this
      // wasn't checked rather than looking like it was checked and
      // passed.
      comparisons.push({ key, status: 'unavailable', valueA, valueB });
      continue;
    }

    const isMatch = valueA.toLowerCase() === valueB.toLowerCase();
    comparisons.push({ key, status: isMatch ? 'match' : 'mismatch', valueA, valueB });

    const weight = SIGNAL_WEIGHTS[key] ?? 1;
    comparedWeight += weight;
    comparedSignals += 1;
    if (isMatch) {
      matchedWeight += weight;
      matchedSignals.push(key);
    }
  }

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
      comparisons,
      sameBrowserFingerprint,
      label: 'not-enough-data',
    };
  }

  const score = comparedWeight > 0 ? matchedWeight / comparedWeight : 0;
  const label: DeviceMatch['label'] = score >= 0.8 ? 'likely-same-device' : score >= 0.5 ? 'possibly-same-device' : 'different-device';

  return { score, matchedSignals, comparedSignals, comparisons, sameBrowserFingerprint, label };
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
