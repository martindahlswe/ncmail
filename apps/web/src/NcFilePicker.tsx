import { useEffect, useState } from "react";
import { api, fmtSize } from "./api.ts";
import { Icon } from "./icons.tsx";

interface Item { name: string; path: string; dir: boolean; size: number; type: string }

/** Browse Nextcloud Files: choose files to attach, or choose a folder to save into. */
export function NcFilePicker({ mode, title, onPick, onClose }: { mode: "files" | "folder"; title: string; onPick: (paths: string[]) => void; onClose: () => void }) {
  const [path, setPath] = useState("/");
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true; setItems(null); setErr("");
    api<{ path: string; items: Item[] }>(`/nextcloud/files?path=${encodeURIComponent(path)}`).then((r) => live && setItems(r.items)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [path]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const crumbs = path.split("/").filter(Boolean);
  return (
    <div className="modal-backdrop" style={{ zIndex: 120 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title} style={{ width: "min(620px, 100%)", maxHeight: "min(640px, calc(100vh - 32px))" }}>
        <div className="modal-head"><b>{title}</b><span style={{ flex: 1 }} /><button className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        <div className="nc-crumbs">
          <button className="btn link" onClick={() => setPath("/")}><Icon name="cloud" size={14} /> Files</button>
          {crumbs.map((c, i) => <span key={i}> / <button className="btn link" onClick={() => setPath("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>)}
        </div>
        <div className="nc-list">
          {err && <div className="note error" style={{ margin: 12 }}>{err}</div>}
          {!items && !err && <p className="hint" style={{ padding: 16 }}>Loading…</p>}
          {items && items.length === 0 && <p className="hint" style={{ padding: 16 }}>This folder is empty.</p>}
          {items?.map((it) => (
            <div key={it.path} className={`nc-row${sel.has(it.path) ? " on" : ""}`}>
              {!it.dir && mode === "files" ? <input type="checkbox" aria-label={`Select ${it.name}`} checked={sel.has(it.path)} onChange={() => setSel((s) => { const n = new Set(s); n.has(it.path) ? n.delete(it.path) : n.add(it.path); return n; })} /> : <span style={{ width: 16 }} />}
              <button className="nc-item" disabled={!it.dir && mode === "folder"} onClick={() => (it.dir ? setPath(it.path) : mode === "files" && setSel((s) => { const n = new Set(s); n.has(it.path) ? n.delete(it.path) : n.add(it.path); return n; }))}>
                <Icon name={it.dir ? "folder" : "file"} size={16} /><span className="nc-name">{it.name}</span>{!it.dir && <span className="hint">{fmtSize(it.size)}</span>}
              </button>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <span className="hint">{mode === "files" ? `${sel.size} selected` : <>Save to <b>{path}</b></>}</span>
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={mode === "files" && sel.size === 0} onClick={() => onPick(mode === "files" ? [...sel] : [path])}>{mode === "files" ? "Attach" : "Save here"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
