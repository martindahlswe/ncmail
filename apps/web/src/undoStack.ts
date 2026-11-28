/** The most recent undoable action, so "z" can undo it the way the Undo button in the toast does. */
let last: { run: () => void; at: number } | null = null;
export const setLastUndo = (run: () => void) => { last = { run, at: Date.now() }; };
export const clearLastUndo = () => { last = null; };
export function runLastUndo(): boolean {
  if (!last || Date.now() - last.at > 5 * 60_000) return false;
  const l = last; last = null; l.run(); return true;
}
