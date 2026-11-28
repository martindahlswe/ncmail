import { avatarColor, initials } from "./api.ts";
import { Icon } from "./icons.tsx";

export const ThreadIcon = ({ size = 14 }: { size?: number }) => <Icon name="thread" size={size} />;

export function Avatar({ name, address, small, className = "" }: { name: string; address: string; small?: boolean; className?: string }) {
  const label = name || address;
  return <span className={`avatar${small ? " sm" : ""} ${className}`} style={{ background: avatarColor(address || name) }} title={label} aria-hidden>{initials(label)}</span>;
}
