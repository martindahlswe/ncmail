/**
 * Pictures put into the text of a message or a signature. They are kept as data: URLs while writing (the server turns
 * them into inline cid: parts when the message is built), so they have to stay small: big ones are scaled down here.
 */

export interface PictureLimits {
  /** Longest side in pixels; larger pictures are scaled down. */
  maxEdge: number;
  /** Largest file size after scaling, in bytes. */
  maxBytes: number;
  /** Width the picture is shown at in the message (the file can have more pixels, for sharp screens). */
  showWidth: number;
}
export const MESSAGE_PICTURES: PictureLimits = { maxEdge: 1600, maxBytes: 1_500_000, showWidth: 600 };
export const SIGNATURE_PICTURES: PictureLimits = { maxEdge: 400, maxBytes: 100_000, showWidth: 200 };

const KEEP_AS_IS = /^image\/(png|jpeg|gif|webp)$/;
/** Only pictures carried in the text itself; never addresses that would load something from the internet. */
export const isInlinePicture = (src: string) => /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src);

export interface Picture { src: string; width: number }

const readDataUrl = (b: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error("The picture could not be read."));
  r.readAsDataURL(b);
});
const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("This file is not a picture Mail can show."));
  img.src = url;
});
const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality));

const tooBig = (l: PictureLimits) => new Error(`This picture is too large. Pictures in the text can be at most ${l.maxBytes >= 1_000_000 ? `${(l.maxBytes / 1_000_000).toFixed(1)} MB` : `${Math.round(l.maxBytes / 1000)} KB`}; attach it instead.`);

/** Read a pasted, dropped or chosen picture, scaling it down (and re-encoding it) when it is larger than the limits allow. */
export async function preparePicture(file: File, l: PictureLimits): Promise<Picture> {
  if (!file.type.startsWith("image/")) throw new Error("Only pictures can be put into the text.");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const showWidth = (pixels: number) => Math.max(1, Math.min(pixels, l.showWidth));
    // small enough as it is: keep the file untouched (an animated GIF stays animated)
    if (KEEP_AS_IS.test(file.type) && file.size <= l.maxBytes && Math.max(w, h) <= l.maxEdge) return { src: await readDataUrl(file), width: showWidth(w) };
    const scale = Math.min(1, l.maxEdge / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d")!;
    // PNG first (keeps transparency, sharp for screenshots); a photo usually needs JPEG to get small, on white
    let blob = file.type === "image/png" || file.type === "image/gif" ? await (async () => { ctx.drawImage(img, 0, 0, c.width, c.height); return toBlob(c, "image/png"); })() : null;
    for (const q of [0.85, 0.7, 0.5]) {
      if (blob && blob.size <= l.maxBytes) break;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      blob = await toBlob(c, "image/jpeg", q);
    }
    if (!blob || blob.size > l.maxBytes) throw tooBig(l);
    return { src: await readDataUrl(blob), width: showWidth(c.width) };
  } finally { URL.revokeObjectURL(url); }
}

/** The picture files among pasted or dropped data. */
export const picturesIn = (dt: DataTransfer | null) => Array.from(dt?.files ?? []).filter((f) => f.type.startsWith("image/"));
