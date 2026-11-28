import { useState } from "react";
import { Icon } from "./icons.tsx";
import type { LinkIssue } from "./linkCheck.ts";

export interface Warning { kind: string; level: "bad" | "warn"; message: string }

/** Why a message may not be what it seems: failed sender checks, a look-alike sender, links that lie. */
export function PhishingBanner({ warnings, links }: { warnings: Warning[]; links: LinkIssue[] }) {
  const [hidden, setHidden] = useState(false);
  if (hidden || (!warnings.length && !links.length)) return null;
  const bad = warnings.some((w) => w.level === "bad") || links.length > 0;
  return (
    <div className={`sec ${bad ? "bad" : "warn"}`}>
      <Icon name="shieldAlert" size={17} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>Be careful with this message</b>
        <ul className="warn-list">
          {warnings.map((w, i) => <li key={i}>{w.message}</li>)}
          {links.length > 0 && <li>It has links that do not go where they say: {links.map((l, i) => <span key={i}>{i ? "; " : ""}<code>{l.text || l.to}</code> goes to <b>{l.to}</b></span>)}. They are outlined in red below, and asking before they open.</li>}
        </ul>
        <div className="hint">Do not enter passwords or payment details, and do not open attachments, unless you are sure it is genuine. Check with the sender another way.</div>
      </div>
      <button className="btn sm ghost" onClick={() => setHidden(true)}>Dismiss</button>
    </div>
  );
}
