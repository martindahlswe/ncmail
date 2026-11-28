import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorContent, Node, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { EditorView } from "@tiptap/pm/view";
import { isInlinePicture, picturesIn, preparePicture, type PictureLimits } from "./pictures.ts";
import { HtmlSignature, pastedSignatureHtml } from "./htmlSignature.ts";

export interface EditorValue { html: string; text: string }

/** A signature lives in its own block so it can be found again: swapped when the sender changes, or removed. */
const Signature = Node.create({
  name: "signature",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-signature]" }],
  renderHTML: () => ["div", { "data-signature": "true" }, 0],
});

/**
 * A picture in the text. Only data: URLs are accepted, so quoted or pasted HTML can never make the composer load
 * something from the internet; the server sends them as inline (cid:) parts.
 */
const Picture = Node.create({
  name: "image",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  addAttributes: () => ({
    src: { default: null },
    alt: { default: null },
    width: { default: null, parseHTML: (el) => Number(el.getAttribute("width")) || null },
  }),
  parseHTML: () => [{ tag: "img[src]", getAttrs: (el) => (isInlinePicture((el as HTMLElement).getAttribute("src") ?? "") ? null : false) }],
  renderHTML: ({ HTMLAttributes }) => ["img", HTMLAttributes],
});

/** A signature block for the message: editable text, or (`asHtml`) the HTML kept as it is (see htmlSignature.ts). */
export const sigBlock = (html: string, asHtml = false) => `<div data-signature="${asHtml ? "html" : "true"}">${html}</div>`;

export interface EditorHandle {
  /** Replace the signature block (or remove it when `html` is empty). If there is none, insert one only when asked to. */
  setSignature: (html: string, insertIfMissing: boolean, asHtml?: boolean) => void;
  /** Insert HTML where the cursor is (a template); the editor keeps only what its schema allows. */
  insertHtml: (html: string) => void;
}

/** "example.com" -> "https://example.com"; keeps mailto:/tel:/http(s) as typed. */
const normalizeUrl = (u: string) => (/^(https?:|mailto:|tel:)/i.test(u) ? u : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u) ? `mailto:${u}` : `https://${u}`);

/** A toolbar button. Defined here, not inside the editor: a component made anew on every render would remount each
 *  update, and the button that had the keyboard focus would lose it. */
function Btn({ label, title, active, disabled, onClick }: { label: React.ReactNode; title: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`tb${active ? " on" : ""}`} title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
}

export const RichEditor = forwardRef<EditorHandle, {
  initialHtml: string; autofocus?: "start" | false; compact?: boolean; onChange: (v: EditorValue) => void;
  /** Allow pictures in the text (pasted, dropped or from the Picture button), within these limits. */
  pictures?: PictureLimits;
  onError?: (message: string) => void;
  /** Pasted HTML this editor would flatten (tables, styles, or HTML source pasted as text). Return true to take it over. */
  onPasteHtml?: (html: string) => boolean;
}>(function RichEditor({ initialHtml, autofocus = false, compact, onChange, pictures, onError, onPasteHtml }, ref) {
  // the editor's handlers are created once, so they read the current props through a ref
  const props = useRef({ pictures, onError, onPasteHtml });
  props.current = { pictures, onError, onPasteHtml };
  const insertPictures = async (view: EditorView, files: File[], at?: number) => {
    const { pictures: limits, onError: fail } = props.current;
    if (!limits) return;
    for (const f of files) {
      try {
        const p = await preparePicture(f, limits);
        const node = view.state.schema.nodes.image!.create({ src: p.src, width: p.width, alt: f.name.replace(/\.[^.]+$/, "") || null });
        const tr = at === undefined ? view.state.tr.replaceSelectionWith(node) : view.state.tr.insert(Math.min(at, view.state.doc.content.size), node);
        view.dispatch(tr);
      } catch (e: any) { fail?.(e.message); }
    }
  };
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: "https" } }), Signature, HtmlSignature, Picture],
    content: initialHtml,
    autofocus,
    editorProps: {
      attributes: { "aria-label": "Message", class: "editor-body" },
      handlePaste: (view, e) => {
        const rich = props.current.onPasteHtml ? pastedSignatureHtml(e.clipboardData) : null;
        if (rich && props.current.onPasteHtml!(rich)) { e.preventDefault(); return true; }
        const files = props.current.pictures ? picturesIn(e.clipboardData) : [];
        if (!files.length) return false;
        e.preventDefault(); insertPictures(view, files);
        return true;
      },
      // pictures dropped on the text go into the text; anything else falls through and is attached
      handleDrop: (view, e, _slice, moved) => {
        const files = !moved && props.current.pictures ? picturesIn(e.dataTransfer) : [];
        if (!files.length || files.length !== (e.dataTransfer?.files.length ?? 0)) return false;
        e.preventDefault();
        insertPictures(view, files, view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos);
        return true;
      },
      handleKeyDown: (_v, e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); window.dispatchEvent(new Event("ncmail:editor-link")); return true; } return false; },
    },
    onUpdate: ({ editor }) => onChange({ html: editor.getHTML(), text: editor.getText({ blockSeparator: "\n" }) }),
  });
  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: !!editor?.isActive("bold"), italic: !!editor?.isActive("italic"), underline: !!editor?.isActive("underline"),
      strike: !!editor?.isActive("strike"), bullet: !!editor?.isActive("bulletList"), ordered: !!editor?.isActive("orderedList"),
      quote: !!editor?.isActive("blockquote"), link: !!editor?.isActive("link"), linkHref: (editor?.getAttributes("link").href as string | undefined) ?? "",
      canUndo: !!editor?.can().undo(), canRedo: !!editor?.can().redo(),
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");

  useImperativeHandle(ref, () => ({
    setSignature(html, insertIfMissing, asHtml = false) {
      if (!editor) return;
      let from = -1, size = 0, quoteAt = -1;
      editor.state.doc.descendants((n, pos) => {
        if ((n.type.name === "signature" || n.type.name === "htmlSignature") && from < 0) { from = pos; size = n.nodeSize; return false; }
        if (n.type.name === "blockquote" && quoteAt < 0) quoteAt = pos;
        return true;
      });
      if (from >= 0) {
        if (html) editor.chain().insertContentAt({ from, to: from + size }, sigBlock(html, asHtml)).run();
        else editor.chain().deleteRange({ from, to: from + size }).run();
      } else if (insertIfMissing && html) {
        editor.chain().insertContentAt(quoteAt >= 0 ? quoteAt : editor.state.doc.content.size, sigBlock(html, asHtml)).run();
      }
    },
    insertHtml(html) {
      editor?.chain().focus().insertContent(html).run();
    },
  }), [editor]);

  const openLinkRef = useRef(() => {});
  useEffect(() => { const h = () => openLinkRef.current(); window.addEventListener("ncmail:editor-link", h); return () => window.removeEventListener("ncmail:editor-link", h); }, []);
  if (!editor || !s) return <div className="editor" />;

  const run = () => editor.chain().focus();
  const openLink = () => { setUrl(s.linkHref); setLinkOpen(true); };
  openLinkRef.current = openLink;
  const applyLink = () => {
    const v = url.trim();
    if (!v) run().extendMarkRange("link").unsetLink().run();
    else run().extendMarkRange("link").setLink({ href: normalizeUrl(v) }).run();
    setLinkOpen(false);
  };

  return (
    <div className={`editor${compact ? " compact" : ""}`}>
      <div className="toolbar-rt" role="toolbar" aria-label="Formatting">
        <Btn label={<b>B</b>} title="Bold (Ctrl+B)" active={s.bold} onClick={() => run().toggleBold().run()} />
        <Btn label={<i>I</i>} title="Italic (Ctrl+I)" active={s.italic} onClick={() => run().toggleItalic().run()} />
        <Btn label={<u>U</u>} title="Underline (Ctrl+U)" active={s.underline} onClick={() => run().toggleUnderline().run()} />
        <Btn label={<s>S</s>} title="Strikethrough" active={s.strike} onClick={() => run().toggleStrike().run()} />
        <span className="tb-sep" />
        <Btn label={<><span aria-hidden>•</span> List</>} title="Bulleted list" active={s.bullet} onClick={() => run().toggleBulletList().run()} />
        <Btn label={<><span className="ol-mark" /> List</>} title="Numbered list" active={s.ordered} onClick={() => run().toggleOrderedList().run()} />
        <Btn label="Quote" title="Quote" active={s.quote} onClick={() => run().toggleBlockquote().run()} />
        <span className="tb-sep" />
        <Btn label="Link" title="Add or edit link" active={s.link} onClick={openLink} />
        {pictures && <Btn label="Picture" title="Insert a picture (you can also paste or drop one into the text)" onClick={() => pickRef.current?.click()} />}
        <Btn label="Clear" title="Clear formatting" onClick={() => run().unsetAllMarks().clearNodes().run()} />
        <span className="tb-sep" />
        <Btn label="↶" title="Undo" disabled={!s.canUndo} onClick={() => run().undo().run()} />
        <Btn label="↷" title="Redo" disabled={!s.canRedo} onClick={() => run().redo().run()} />
      </div>
      {linkOpen && (
        <div className="link-row">
          <input aria-label="Link address" placeholder="https://… or name@example.com" value={url} autoFocus
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinkOpen(false); }} />
          <button type="button" className="btn primary" onClick={applyLink}>{url.trim() ? "Apply" : "Remove link"}</button>
          <button type="button" className="btn" onClick={() => setLinkOpen(false)}>Cancel</button>
        </div>
      )}
      {pictures && <input ref={pickRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
        onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; editor.commands.focus(); insertPictures(editor.view, files); }} />}
      <EditorContent editor={editor} />
    </div>
  );
});
