import { useEffect } from "react";
import { Icon } from "./icons.tsx";

const K = ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>;
const GROUPS: { title: string; rows: [React.ReactNode, string][] }[] = [
  { title: "Move around", rows: [
    [<><K>j</K> <K>k</K></>, "Next / previous message"], [<K>Enter</K>, "Open the message"], [<K>Esc</K>, "Close message, clear selection or search"],
    [<K>/</K>, "Search"], [<><K>g</K> then <K>i</K></>, "Go to Inbox"], [<><K>g</K> then <K>s</K></>, "Go to Sent"], [<><K>g</K> then <K>d</K></>, "Go to Drafts"],
    [<><K>g</K> then <K>a</K></>, "Go to Archive"], [<><K>g</K> then <K>t</K></>, "Go to Trash"],
  ] },
  { title: "Act on messages", rows: [
    [<K>c</K>, "Write a new message"], [<K>r</K>, "Reply"], [<K>a</K>, "Reply all"], [<K>l</K>, "Reply to the mailing list"], [<K>f</K>, "Forward"],
    [<K>e</K>, "Archive"], [<K>#</K>, "Delete"], [<K>!</K>, "Report spam"], [<K>s</K>, "Star or unstar"], [<K>u</K>, "Mark as unread"],
    [<K>x</K>, "Select or deselect"], [<><K>Shift</K> + <K>↓</K> / <K>↑</K></>, "Extend the selection"], [<><K>⌘/Ctrl</K> <K>A</K></>, "Select all loaded"], [<K>z</K>, "Undo the last action"],
  ] },
  { title: "Writing", rows: [
    [<><K>⌘/Ctrl</K> <K>Enter</K></>, "Send"], [<><K>⌘/Ctrl</K> <K>B</K> / <K>I</K> / <K>U</K></>, "Bold, italic, underline"], [<><K>⌘/Ctrl</K> <K>K</K></>, "Insert a link"],
    [<K>Esc</K>, "Close (a draft is saved)"], [<><K>⌘/Ctrl</K> + click</>, "Add or remove a message from the selection"], [<><K>Shift</K> + click</>, "Select a range in the list"], [<>Drag</>, "Drop messages on a folder to move them; files into the composer to attach"],
  ] },
];

export function Help({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(900px, 100%)" }} role="dialog" aria-label="Keyboard shortcuts">
        <div className="modal-head"><b>Keyboard shortcuts</b><span style={{ flex: 1 }} /><button className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        <div className="help-cols">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h4>{g.title}</h4>
              <dl className="shortcuts">{g.rows.map(([k, d], i) => <><dt key={`k${i}`}>{k}</dt><dd key={`d${i}`}>{d}</dd></>)}</dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
