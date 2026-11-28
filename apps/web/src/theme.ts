export interface ThemeInfo { enabled: boolean; name?: string; slogan?: string; color?: string | null; cssUrl?: string; logoUrl?: string }

const KEY = "ncmail.theme";
const saved = (): ThemeInfo | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; } };
export let theme: ThemeInfo = saved() ?? { enabled: false };

let linkEl: HTMLLinkElement | null = null;
const DARK = "ncmail.dark";
const cssHref = (url: string) => (localStorage.getItem(DARK) === "1" ? `${url}${url.includes("?") ? "&" : "?"}variant=dark` : url);
/** Nextcloud says whether the user uses its dark theme: load that variant of the theme sheet. */
export function setDark(dark: boolean) {
  if ((localStorage.getItem(DARK) === "1") === dark) return;
  localStorage.setItem(DARK, dark ? "1" : "0");
  if (linkEl && theme.cssUrl) linkEl.href = cssHref(theme.cssUrl);
}

function attach(info: ThemeInfo, wait: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const link = document.createElement("link");
    linkEl = link;
    link.rel = "stylesheet";
    link.href = cssHref(info.cssUrl!);
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
    if (wait) setTimeout(resolve, 2000); else resolve();
  });
}

/**
 * Appends the instance's theme stylesheet AFTER our bundled CSS. Our styles only use Nextcloud's own
 * variable names (--color-primary-element, --color-main-background, ...) with built-in fallbacks,
 * so whatever theme the instance serves (default, admin-branded, dark, external theme) takes over.
 *
 * On repeat visits the stylesheet address is remembered, so the page attaches it immediately (it comes from the
 * browser cache) and does not wait for a request before the first paint; the theme info is refreshed in the background.
 */
export async function loadNextcloudTheme(): Promise<void> {
  const known = saved();
  if (known?.enabled && known.cssUrl) {
    void attach(known, false);
    fetch("/api/theme").then((r) => r.json()).then((info: ThemeInfo) => { theme = info; localStorage.setItem(KEY, JSON.stringify(info)); }).catch(() => {});
    return;
  }
  try {
    const info: ThemeInfo = await fetch("/api/theme").then((r) => r.json());
    theme = info;
    localStorage.setItem(KEY, JSON.stringify(info));
    if (!info.enabled || !info.cssUrl) return;
    await attach(info, true);
  } catch { /* fall back to built-in defaults */ }
}
