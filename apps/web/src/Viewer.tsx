import { useEffect, useState } from "react";
import { api, fmtSize } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useToast } from "./ui.tsx";

export const canPreview = (type: string) =>
  /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|text\/(plain|csv|markdown)|audio\/(mpeg|mp4|ogg|wav|webm)|video\/(mp4|webm|ogg))$/i.test(type.split(";")[0]!.trim());

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
}

/** The raw message: every header, and the source. */
export function SourceModal({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<{ headers: { name: string; value: string }[]; source: string; truncated: boolean; size: number } | null>(null);
  const [tab, setTab] = useState<"headers" | "source">("headers");
  const [err, setErr] = useState("");
  useEscape(onClose);
  useEffect(() => { api<any>(`/messages/${messageId}/source`).then(setD).catch((e) => setErr(e.message)); }, [messageId]);
  return (
    <div className="modal-backdrop" style={{ zIndex: 120 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Message source" style={{ width: "min(920px, 100%)", height: "min(700px, calc(100vh - 32px))" }}>
        <div className="modal-head">
          <b>Message source</b>
          <div className="seg" style={{ marginLeft: 12 }}><button className={tab === "headers" ? "on" : ""} onClick={() => setTab("headers")}>Headers</button><button className={tab === "source" ? "on" : ""} onClick={() => setTab("source")}>Full source</button></div>
          <span style={{ flex: 1 }} />
          {d && <button className="btn sm" onClick={() => { navigator.clipboard.writeText(tab === "headers" ? d.headers.map((h) => `${h.name}: ${h.value}`).join("\n") : d.source); toast({ message: "Copied" }); }}><Icon name="copy" size={14} /> Copy</button>}
          <a className="btn sm" href={`/api/messages/${messageId}/source?download=1`}><Icon name="download" size={14} /> Download .eml</a>
          <button className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {err && <div className="note error">{err}</div>}
          {!d && !err && <p className="hint">Loading…</p>}
          {d && tab === "headers" && (
            <table className="hdr-table"><tbody>{d.headers.map((h, i) => <tr key={i}><th>{h.name}</th><td>{h.value}</td></tr>)}</tbody></table>
          )}
          {d && tab === "source" && <><pre className="source">{d.source}</pre>{d.truncated && <p className="hint">Only the first 2 MB are shown ({fmtSize(d.size)} in total). Download the .eml for everything.</p>}</>}
        </div>
      </div>
    </div>
  );
}

export interface Att { idx: number; filename: string; contentType: string; size: number }

/** Look at an attachment without downloading it; arrows move between the previewable ones. */
export function AttachmentPreview({ messageId, items, start, onClose, extra }: { messageId: string; items: Att[]; start: number; onClose: () => void; extra?: (a: Att) => React.ReactNode }) {
  const [i, setI] = useState(start);
  useEscape(onClose);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "ArrowRight") setI((x) => Math.min(items.length - 1, x + 1)); if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1)); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [items.length]);
  const a = items[i]!;
  const url = `/api/messages/${messageId}/attachments/${a.idx}`;
  const t = a.contentType.split(";")[0]!.toLowerCase();
  return (
    <div className="modal-backdrop" style={{ zIndex: 120, background: "rgb(8 10 14 / .78)" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="preview" role="dialog" aria-label={`Preview ${a.filename}`}>
        <div className="preview-bar">
          <b className="att-name" style={{ flex: 1 }}>{a.filename}</b><span className="hint">{fmtSize(a.size)}{items.length > 1 ? ` · ${i + 1} of ${items.length}` : ""}</span>
          {items.length > 1 && <><button className="btn icon sm ghost" aria-label="Previous" disabled={i === 0} onClick={() => setI(i - 1)}><Icon name="chevronLeft" /></button><button className="btn icon sm ghost" aria-label="Next" disabled={i === items.length - 1} onClick={() => setI(i + 1)}><Icon name="chevronRight" /></button></>}
          {extra?.(a)}
          <a className="btn sm" href={url}><Icon name="download" size={14} /> Download</a>
          <button className="btn icon sm ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="preview-body">
          {t.startsWith("image/") ? <img key={url} src={`${url}?inline=1`} alt={a.filename} />
            : t.startsWith("video/") ? <video key={url} src={`${url}?inline=1`} controls />
            : t.startsWith("audio/") ? <audio key={url} src={`${url}?inline=1`} controls />
            : <iframe key={url} src={`${url}?inline=1`} title={a.filename} />}
        </div>
      </div>
    </div>
  );
}

/** The policy for a document showing a message body: nothing loads from elsewhere unless remote images were allowed. */
export const mailCsp = (allowImages: boolean) => `default-src 'none'; img-src data: ${allowImages ? "https: http:" : ""}; style-src 'unsafe-inline'`;

/** Print a message: its header block and body, in a clean page (remote images only when they were allowed in the reader). */
export function printMessage(m: { subject: string; fromName: string; fromAddr: string; to: { name: string; address: string }[]; cc: { name: string; address: string }[]; date: string; html: string | null; text: string }, allowImages = false) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const who = (l: { name: string; address: string }[]) => l.map((a) => esc(a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
  const body = m.html ?? `<pre style="white-space:pre-wrap;font:inherit">${esc(m.text)}</pre>`;
  const doc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${mailCsp(allowImages)}"><title>${esc(m.subject || "Message")}</title>
<style>body{font:13px/1.5 system-ui,sans-serif;color:#000;margin:24px}h1{font-size:18px;margin:0 0 10px}table{border-collapse:collapse;margin-bottom:14px;border-bottom:1px solid #999;width:100%}th{text-align:left;color:#555;font-weight:600;padding:2px 12px 2px 0;white-space:nowrap;vertical-align:top;width:1%}td{padding:2px 0}img{max-width:100%}</style>
<h1>${esc(m.subject || "(no subject)")}</h1>
<table><tr><th>From</th><td>${esc(m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr)}</td></tr><tr><th>Date</th><td>${esc(new Date(m.date).toLocaleString())}</td></tr><tr><th>To</th><td>${who(m.to)}</td></tr>${m.cc.length ? `<tr><th>Cc</th><td>${who(m.cc)}</td></tr>` : ""}</table>${body}`;
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  f.setAttribute("sandbox", "allow-same-origin allow-modals"); // no scripts from the message can run
  f.srcdoc = doc;
  f.onload = () => { f.contentWindow?.focus(); f.contentWindow?.print(); setTimeout(() => f.remove(), 2000); };
  document.body.appendChild(f);
}
