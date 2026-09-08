-- Cross-browser device recognition support.
--
-- Problem this solves: user_devices.device_id (see lib/deviceId.ts) is a
-- cookie, and cookies are BROWSER-scoped, not machine-scoped. One person
-- opening Chrome, then Firefox, then Edge on the exact same physical
-- laptop gets THREE different device_id values — three separate "New
-- Device Request" rows — because each browser has its own cookie jar.
-- That's not a bug in the identity check; it's an inherent limit of
-- cookie-based identity. Admins were seeing these as unrelated devices,
-- couldn't tell they were the same laptop, and were either wrongly
-- denying a legitimate second browser or getting confused/frustrated —
-- a real trust problem with users who felt like they were being treated
-- as account-sharers for using two browsers on one computer.
--
-- Fix: alongside the cookie identity, also capture a handful of
-- browser-reported HARDWARE/OS signals that stay the SAME across
-- different browsers on the same physical machine (screen resolution,
-- timezone, CPU core count, device memory, touch support, OS platform)
-- plus a FingerprintJS visitorId (browser-install-specific — useful for
-- "is this really the same browser even though cookies got cleared?",
-- NOT for cross-browser matching, since canvas/font rendering differs
-- per browser engine even on identical hardware). lib/deviceSimilarity.ts
-- compares these signals between a pending device and a user's already-
-- authorized devices and shows the admin a "likely same device" hint —
-- it never auto-approves anything; a human still makes every call.
--
-- Run this once against any existing project. Safe to run multiple times.

alter table public.user_devices
  add column if not exists signals jsonb not null default '{}'::jsonb;

comment on column public.user_devices.signals is
  'Best-effort browser/hardware signals (screen, timezone, hardware_concurrency, device_memory, platform, languages, max_touch_points, fingerprint_visitor_id) used only to show the admin a "likely same physical device" hint when comparing a pending device against this user''s already-authorized devices. Never used to auto-decide anything — see lib/deviceSimilarity.ts.';
