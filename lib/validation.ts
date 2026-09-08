import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const roleSchema = z.enum(['USER', 'ADMIN']);
export const statusSchema = z.enum(['ACTIVE', 'DISABLED']);

export const addAuthorizedUserSchema = z
  .object({
    email: emailSchema,
    role: roleSchema.default('USER'),
    // Free Trial: 'paid' follows the existing flow exactly. 'trial'
    // requires a duration — the countdown only starts at the account's
    // first login (see lib/auth.ts), not at creation time.
    account_type: z.enum(['paid', 'trial']).default('paid'),
    trial_duration_minutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).optional(),
  })
  .refine((data) => data.account_type !== 'trial' || data.trial_duration_minutes !== undefined, {
    message: 'Pick a trial duration.',
    path: ['trial_duration_minutes'],
  });

export const updateAuthorizedUserSchema = z.object({
  role: roleSchema.optional(),
  status: statusSchema.optional(),
  restrict_devices: z.boolean().optional(),
});

// 'pending' is set by the system when a device is first seen — never a
// valid admin decision, so it's excluded from the schemas admins submit
// against (deviceDecisionSchema / deviceUpdateSchema below).
export const deviceStatusSchema = z.enum(['pending', 'authorized', 'restricted', 'blocked']);
export const deviceDecisionStatusSchema = z.enum(['authorized', 'restricted', 'blocked']);

// Approve/Reject/Block a specific device_id (a "New Device Request" or an
// existing row) from the admin panel.
export const deviceDecisionSchema = z.object({
  device_id: z.string().uuid(),
  status: deviceDecisionStatusSchema,
  label: z.string().trim().max(60).optional().nullable(),
});

export const deviceUpdateSchema = z.object({
  status: deviceDecisionStatusSchema.optional(),
  label: z.string().trim().max(60).optional().nullable(),
});

const safeUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((val) => val.startsWith('https://'), 'URL must use https');

export const boardTypeSchema = z.enum(['normal', 'routine']);

export const boardSchema = z.object({
  parent_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  thumbnail_url: safeUrl.optional().nullable(),
  sort_order: z.number().int().min(0).max(100000).default(0),
  published: z.boolean().default(false),
  destination_page_id: z.string().uuid().nullable().optional(),
  // 'routine' boards skip the normal board/video hierarchy entirely and
  // just display routine_image_url (a class routine / timetable graphic,
  // 16:9) alongside the title and description.
  board_type: boardTypeSchema.default('normal'),
  routine_image_url: safeUrl.optional().nullable(),
  // 'universal' (default) = every authorized user can see this board.
  // 'restricted' = only users explicitly granted access (see
  // board_user_access / /api/admin/boards/[id]/access) can see it — and
  // that restriction cascades to everything nested under it.
  visibility: z.enum(['universal', 'restricted']).default('universal'),
});

export const boardUpdateSchema = boardSchema.partial();

export const pageSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  thumbnail_url: safeUrl.optional().nullable(),
  sort_order: z.number().int().min(0).max(100000).default(0),
  layout: z.enum(['grid', 'list']).default('grid'),
});

export const videoSchema = z.object({
  board_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  thumbnail_url: safeUrl.optional().nullable(),
  // 'bunny' (paid, protected), 'youtube' (free, unlisted), 'mp4' (a
  // direct, already-hosted video file URL), or 'm3u8' (an HLS playlist
  // behind Referer-based hotlink protection) — see
  // app/api/video/[id]/play/route.ts for what each trade-off means.
  provider: z.enum(['bunny', 'youtube', 'mp4', 'm3u8']).default('bunny'),
  // Bunny: "{libraryId}/{videoGuid}" out of the embed URL
  // https://iframe.mediadelivery.net/embed/{libraryId}/{videoGuid}.
  // YouTube: just the bare 11-character video id.
  // mp4: the full https URL to the video file itself.
  // m3u8: the full https URL to the .m3u8 playlist itself.
  source_ref: z.string().trim().min(1).max(2048),
  // m3u8 only: the Referer value the source CDN requires before it will
  // serve the playlist/segments. Never sent to the client — only used
  // server-side by app/api/video/[id]/hls-proxy/route.ts, since browsers
  // don't allow client-side JS to set a custom Referer header itself.
  referer_header: z.string().trim().min(1).max(500).optional().nullable(),
  // Which part this is within the board, when a board has more than one
  // class attached (Part 1, Part 2, ...).
  sort_order: z.number().int().min(0).max(100000).default(0),
  // A single dedicated download link for this class.
  download_url: safeUrl.optional().nullable(),
});

export const videoUpdateSchema = videoSchema.partial().extend({
  board_id: z.string().uuid().optional(),
});

// A resource attached to a class — a lecture sheet, an exam link, notes,
// etc. Deliberately generic (just a title + URL) rather than a fixed set
// of resource "kinds", so admins aren't boxed in.
export const videoResourceSchema = z.object({
  video_id: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  url: safeUrl,
  sort_order: z.number().int().min(0).max(100000).default(0),
});

// A downloadable e-book attached to a board (chapter/subject). Deliberately
// separate from video_resources: e-books are their own browsable section
// on a board's page, with a price (almost always 0 / "Free") rather than
// being a link attached to a specific class.
export const eBookSchema = z.object({
  board_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  thumbnail_url: safeUrl.optional().nullable(),
  download_url: safeUrl.optional().nullable(),
  format: z.string().trim().min(1).max(40).default('PDF'),
  price: z.number().min(0).max(1000000).default(0),
  sort_order: z.number().int().min(0).max(100000).default(0),
});

export const eBookUpdateSchema = eBookSchema.partial().extend({
  board_id: z.string().uuid().optional(),
});

export const uuidSchema = z.string().uuid();

// Reported periodically by VideoPlayer.tsx (both providers) while a class
// plays, to power "resume where I left off". Capped at ~24h so a client
// bug (or a tampered request) can't write an absurd value; duration is
// optional since it isn't always known yet (e.g. YouTube before
// onReady/getDuration resolves).
export const videoProgressSchema = z.object({
  position_seconds: z.number().int().min(0).max(24 * 60 * 60),
  duration_seconds: z.number().int().min(0).max(24 * 60 * 60).optional().nullable(),
});

// The site-wide announcement popup, shown to authorized users on a
// repeating interval (interval_hours = the "watch time" — how often the
// same person is shown it again). Singleton settings row; see
// supabase/migrations/0006_device_approval_and_popup.sql.
export const popupSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  title: z.string().trim().max(200).default(''),
  message: z.string().trim().max(8000).default(''),
  button_label: z.string().trim().min(1).max(60).default('Got it'),
  button_url: safeUrl.optional().nullable(),
  interval_hours: z.number().int().min(1).max(24 * 365).default(24),
});

export const popupSettingsUpdateSchema = popupSettingsSchema.partial();

// A browser's PushSubscription.toJSON() shape — exactly what
// components/NotificationPrompt.tsx sends after subscribing.
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
