import { useState } from "react";
import { api, type MessageFull, type SignatureStatus } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { useToast } from "./ui.tsx";

const proto = (p: "pgp" | "smime") => (p === "pgp" ? "PGP" : "S/MIME");

const SIG: Record<SignatureStatus, { tone: "ok" | "warn" | "bad"; icon: IconName; title: (who: string) => string }> = {
  valid: { tone: "ok", icon: "shieldCheck", title: (w) => `Signed by ${w}` },
  untrusted: { tone: "warn", icon: "shieldAlert", title: () => "The signature is correct, but the signer is not trusted" },
  mismatch: { tone: "bad", icon: "shieldAlert", title: () => "Signed by someone other than the sender" },
  expired: { tone: "warn", icon: "shieldAlert", title: () => "Signed with a certificate that was not valid" },
  invalid: { tone: "bad", icon: "shieldAlert", title: () => "The signature is not valid. This message may have been changed" },
  "unknown-key": { tone: "warn", icon: "shield", title: () => "Signed, but you do not have the sender's key" },
};

/** Whether a message was signed and/or encrypted, and what that means, in plain words. */
export function SecurityBanner({ message, accountId }: { message: MessageFull; accountId: string }) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const s = message.security;
  if (!s || (!s.signature && !s.encryption)) return null;
  const sig = s.signature, enc = s.encryption;
  const decrypted = enc?.status === "decrypted", unverified = decrypted && enc?.authenticated === false;

  const keep = async () => {
    try {
      const r = await api<{ emails: string[] }>(`/messages/${message.id}/security/save-key`, { method: "POST" });
      setSaved(true);
      toast({ kind: "success", message: `Trusted this certificate for ${r.emails.join(", ")} only. Messages from that address signed with it will show as trusted.` });
      window.dispatchEvent(new Event("ncmail:refresh"));
    } catch (e: any) { toast({ kind: "error", message: e.message }); }
  };

  return (
    <>
      {enc && (
        <div className={`sec ${!decrypted ? "bad" : unverified ? "warn" : "ok"}`}>
          <Icon name="lock" size={17} />
          <div>
            <b>{!decrypted ? (enc.status === "no-key" ? "This message is encrypted and you cannot open it" : "This message could not be decrypted")
              : unverified ? `Encrypted (${proto(enc.protocol)}), but not verified: it is not signed by the sender`
              : `Encrypted (${proto(enc.protocol)}): only you and the other recipients can read this`}</b>
            {(!decrypted || unverified) && <div className="hint">{enc.message}{enc.status === "no-key" ? " Add the matching private key under Settings > Security." : ""}</div>}
          </div>
        </div>
      )}
      {sig && (
        <div className={`sec ${SIG[sig.status].tone}`}>
          <Icon name={SIG[sig.status].icon} size={17} />
          <div style={{ flex: 1 }}>
            <b>{SIG[sig.status].title(sig.signer ? `${sig.signer.name || sig.signer.email} (${proto(sig.protocol)})` : proto(sig.protocol))}</b>
            <div className="hint">{sig.message}</div>
            {sig.canSave && (sig.status === "untrusted") && !saved && (
              <div style={{ marginTop: 6 }}><button className="btn sm" onClick={keep}><Icon name="key" size={14} /> Trust this certificate for {message.fromAddr}</button></div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
