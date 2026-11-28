/**
 * Keyboard focus for every modal dialog (anything rendered as `.modal-backdrop` with a `[role=dialog]` or
 * `[role=alertdialog]` inside), in one place instead of in each dialog:
 * - when a dialog opens, focus moves into it (its `[autofocus]` or first field, else the dialog itself), unless the
 *   dialog already put it there;
 * - Tab and Shift+Tab stay inside the topmost dialog, and the page behind it is marked modal for screen readers;
 * - when it closes, focus goes back to where it was before (the button that opened it), if that is still on the page.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

const visible = (el: HTMLElement) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => visible(el) && !el.closest("[inert]"));
const dialogOf = (layer: Element) => layer.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');

export function installModalFocus() {
  const returnTo = new WeakMap<Element, HTMLElement | null>();
  let before: HTMLElement | null = null; // focus just before the newest dialog appeared (pointer down / key down)
  const layers = () => Array.from(document.querySelectorAll(".modal-backdrop")).filter((l) => dialogOf(l));
  const top = () => { const all = layers(); return all.length ? dialogOf(all[all.length - 1]!) : null; };

  // what had focus when the click or key press that opened a dialog happened (a dialog may move focus as it mounts)
  const remember = () => { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body && !a.closest(".modal-backdrop")) before = a; };
  document.addEventListener("pointerdown", remember, true);
  document.addEventListener("keydown", remember, true);

  const opened = (layer: Element) => {
    const dialog = dialogOf(layer)!;
    dialog.setAttribute("aria-modal", "true");
    const prev = before && document.contains(before) ? before : (document.activeElement as HTMLElement | null);
    returnTo.set(layer, prev && !layer.contains(prev) ? prev : null);
    // after the dialog's own effects ran, so a field it focuses itself keeps the focus
    requestAnimationFrame(() => {
      if (!document.contains(dialog) || dialog.contains(document.activeElement)) return;
      const target = dialog.querySelector<HTMLElement>("[autofocus]") ?? focusables(dialog).find((el) => !el.matches(".settings-close, [aria-label^='Close']")) ?? focusables(dialog)[0];
      if (target) target.focus();
      else { if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1"); dialog.focus(); }
    });
  };
  const closed = (layer: Element) => {
    const to = returnTo.get(layer);
    returnTo.delete(layer);
    requestAnimationFrame(() => {
      if (top()) return; // another dialog is still open (it keeps the focus)
      const lost = !document.activeElement || document.activeElement === document.body;
      if (to && document.contains(to) && lost) to.focus();
    });
  };

  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        const found = n.matches(".modal-backdrop") ? [n] : Array.from(n.querySelectorAll(".modal-backdrop"));
        found.forEach((l) => { if (dialogOf(l)) opened(l); });
      });
      r.removedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        const found = n.matches(".modal-backdrop") ? [n] : Array.from(n.querySelectorAll(".modal-backdrop"));
        found.forEach((l) => { if (returnTo.has(l)) closed(l); });
      });
    }
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.defaultPrevented) return;
    const dialog = top();
    if (!dialog) return;
    const list = focusables(dialog);
    if (!list.length) { e.preventDefault(); dialog.focus(); return; }
    // moved by hand every time: browsers differ in what Tab reaches (Safari skips links), and could step out of the dialog
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    let i = active ? list.indexOf(active) : -1;
    if (i < 0 && active && dialog.contains(active)) i = list.findIndex((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) - 1;
    const next = i < 0 && !(active && dialog.contains(active)) ? (e.shiftKey ? list.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
    list[next]!.focus();
  });
}
