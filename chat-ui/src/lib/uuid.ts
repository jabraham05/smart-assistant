// crypto.randomUUID() requires a secure context (HTTPS or localhost) and is
// simply absent everywhere else - including the plain-HTTP LAN IP this app
// gets tested over before Tailscale/HTTPS lands (see
// docs/iphone-pwa-implementation-plan.md section 8). crypto.getRandomValues()
// has no such restriction, so build a UUID v4 on top of it when the
// shortcut isn't available.
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
