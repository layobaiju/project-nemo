// Network safeguards for the Atlas Windows host. Pure functions so they can be unit-tested.
import crypto from 'node:crypto';

export function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/i, '').split('%')[0];
}

export function isLoopback(ip) {
  const a = normalizeIp(ip);
  return a === '::1' || /^127\./.test(a);
}

/** Loopback, RFC 1918, link-local, CGNAT/Tailscale (100.64/10) and IPv6 ULA/link-local only. */
export function isPrivateAddress(ip) {
  const a = normalizeIp(ip);
  if (isLoopback(a)) return true;
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  const l = a.toLowerCase();
  return /^fe[89ab][0-9a-f]?:/.test(l) || /^f[cd][0-9a-f]{0,2}:/.test(l);
}

export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

/**
 * Blocks DNS-rebinding: a hostile web page can only reach the host through a domain name it controls,
 * so only localhost, raw IP addresses and this PC's own names are accepted.
 */
export function isAllowedHostHeader(hostHeader, extraNames = []) {
  const h = hostnameOf(hostHeader);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return true;
  return extraNames.some(n => n && n.toLowerCase() === h);
}

/** Cross-site write protection: if the browser sends an Origin, it must be this host. */
export function originMatchesHost(origin, hostHeader) {
  if (!origin) return true;
  if (origin === 'null') return false;
  try { return new URL(origin).host.toLowerCase() === String(hostHeader || '').toLowerCase(); } catch { return false; }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
export function generateCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += CODE_ALPHABET[b % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normalizeCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const tokenFor = (secret, code) => crypto.createHmac('sha256', secret).update(`atlas-device:${normalizeCode(code)}`).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Simple fixed-window limiter for access-code attempts. */
export function createThrottle(limit, windowMs) {
  const hits = new Map();
  return {
    blocked(key) { const h = hits.get(key); return !!h && h.count >= limit && Date.now() - h.start < windowMs; },
    fail(key) {
      const now = Date.now(), h = hits.get(key);
      if (!h || now - h.start >= windowMs) hits.set(key, { start: now, count: 1 }); else h.count++;
    },
    reset(key) { hits.delete(key); },
  };
}
