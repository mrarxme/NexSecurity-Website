/**
 * Maps a resource's title (there's no separate "type" column on
 * video_resources — see supabase/schema.sql) to a color + icon for the
 * card grid on a class page. Matched by keyword rather than an exact
 * list so a title like "Chapter 3 Lecture Sheet" still gets the Lecture
 * Sheet treatment instead of falling through to the generic default —
 * admins type free-text titles, they won't always match a preset
 * exactly. Order matters: first match wins, checked most-specific-ish
 * first (a title containing both "exam" and "sheet" should read as an
 * exam resource, not a generic sheet).
 */

type ResourceVisual = {
  /** Tailwind gradient stop classes, e.g. "from-blue-500 to-indigo-600" */
  gradient: string;
  icon: React.ReactNode;
};

const iconProps = {
  className: 'h-6 w-6 text-white',
  fill: 'none',
  viewBox: '0 0 24 24',
  'aria-hidden': true as const,
};

const DocumentIcon = (
  <svg {...iconProps}>
    <path
      d="M6 3.5h8l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V5A1.5 1.5 0 0 1 5.5 3.5H6Zm8 0V8h4"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const NoteIcon = (
  <svg {...iconProps}>
    <path
      d="M6 4h9l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path d="M8 10h8M8 14h8M8 18h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const ExamIcon = (
  <svg {...iconProps}>
    <path
      d="M9 3.5h6a1 1 0 0 1 1 1V5h1.5A1.5 1.5 0 0 1 19 6.5v13A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-13A1.5 1.5 0 0 1 6.5 5H8v-.5a1 1 0 0 1 1-1Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path d="m9 13 2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const PracticeIcon = (
  <svg {...iconProps}>
    <path
      d="M4 20l1-4.5L15.5 5A2.1 2.1 0 0 1 19 8.5L8.5 19 4 20Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const LinkIcon = (
  <svg {...iconProps}>
    <path
      d="M9.5 14.5 14.5 9.5M11 6.5l1-1a3.5 3.5 0 0 1 5 5l-1 1M13 17.5l-1 1a3.5 3.5 0 0 1-5-5l1-1"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function resourceVisual(title: string): ResourceVisual {
  const t = title.toLowerCase();

  if (t.includes('exam')) {
    return { gradient: 'from-rose-500 to-red-600', icon: ExamIcon };
  }
  if (t.includes('practice')) {
    return { gradient: 'from-emerald-500 to-teal-600', icon: PracticeIcon };
  }
  if (t.includes('lecture')) {
    return { gradient: 'from-blue-500 to-indigo-600', icon: DocumentIcon };
  }
  if (t.includes('note')) {
    return { gradient: 'from-amber-500 to-orange-600', icon: NoteIcon };
  }
  // Anything else (a custom title an admin typed) — a neutral gradient
  // in the site's own signal color rather than defaulting to one of the
  // preset colors above, which would misleadingly suggest it's that
  // specific type.
  return { gradient: 'from-slate-500 to-slate-700', icon: LinkIcon };
}
