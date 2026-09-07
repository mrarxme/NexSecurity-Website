'use client';

import { useMemo } from 'react';
import { ancestorIds, ancestorTitles, type TreeBoard } from '@/lib/boardTree';

/**
 * Board picker as a drill-down chain — one <select> per depth level
 * (top-level board, then its sub-boards, then *its* sub-boards, and so
 * on for however deep this particular branch actually goes) instead of
 * one flat list of every board in the whole tree with no indication of
 * which top-level board a deeply-nested one sits under. Whichever id is
 * currently selected anywhere in the chain becomes `value` immediately
 * (even if it still has children of its own) — picking a board that
 * turns out to have sub-boards just reveals the next level's select
 * rather than requiring a separate confirm step.
 *
 * Shared by the Boards and Classes admin pages so "pick a board" looks
 * and behaves identically everywhere it happens, instead of two
 * near-identical pickers drifting apart over time.
 */
export function CascadingBoardSelect<T extends TreeBoard>({
  boards,
  value,
  onChange,
  excludeIds,
  requireSelection = true,
}: {
  /** The FULL board list — ancestor lookups need every board to walk the
   * chain correctly, even when some are excluded from being pickable. */
  boards: T[];
  value: string;
  onChange: (boardId: string) => void;
  /** Ids that should never be offered as an option (their subtree is
   * still walkable for ancestry purposes) — used by the board Edit form
   * so a board can't be reparented under its own descendant. */
  excludeIds?: Set<string>;
  /** False when leaving every level empty is itself a valid choice — the
   * board create/edit forms use this for "no parent = Top-Level board".
   * Classes leave this at the default true: a class always needs SOME
   * board, so the first level stays a required field. */
  requireSelection?: boolean;
}) {
  const selectableBoards = useMemo(
    () => (excludeIds ? boards.filter((b) => !excludeIds.has(b.id)) : boards),
    [boards, excludeIds]
  );

  const byParent = useMemo(() => {
    const map = new Map<string | null, T[]>();
    for (const b of selectableBoards) {
      if (!map.has(b.parent_id)) map.set(b.parent_id, []);
      map.get(b.parent_id)!.push(b);
    }
    for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title));
    return map;
  }, [selectableBoards]);

  // The full root-to-selected path, reconstructed from the tree itself
  // (not from local UI state) — so it stays correct no matter which
  // level's <select> just fired the change. Walked against the FULL
  // board list so it's accurate even if `value` sits under an ancestor
  // that got excluded from the pickable options above.
  const chain = useMemo(() => (value ? [...ancestorIds(boards, value), value] : []), [boards, value]);

  const levels: { parentId: string | null; options: T[]; selectedId: string }[] = [];
  let parentId: string | null = null;
  for (let depth = 0; ; depth++) {
    const options = byParent.get(parentId) ?? [];
    if (options.length === 0) break;
    const selectedId = chain[depth] ?? '';
    levels.push({ parentId, options, selectedId });
    if (!selectedId) break; // nothing chosen at this level yet — stop, no deeper level to show
    parentId = selectedId;
  }

  return (
    <div className="space-y-1.5">
      {levels.map((level, depth) => (
        <select
          key={level.parentId ?? 'root'}
          value={level.selectedId}
          onChange={(e) => onChange(e.target.value)}
          className="input"
          required={depth === 0 && requireSelection}
        >
          <option value="">{depth === 0 ? '— Select a top-level board —' : '— Select a sub-board —'}</option>
          {level.options.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
      ))}
      {value && (
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {[...ancestorTitles(boards, value), boards.find((b) => b.id === value)?.title].filter(Boolean).join(' › ')}
        </p>
      )}
    </div>
  );
}
