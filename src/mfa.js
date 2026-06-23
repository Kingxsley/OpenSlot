import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';

const ISSUER = 'Enjeeoh';

export function newMfaSecret() { return new OTPAuth.Secret({ size: 20 }).base32; }

function totpFor(secret, label) {
  return new OTPAuth.TOTP({ issuer: ISSUER, label: label || 'account', algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}

export function verifyTotp(secret, token) {
  if (!secret || !token) return false;
  const clean = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  return totpFor(secret).validate({ token: clean, window: 1 }) !== null;
}

export async function mfaQrDataUrl(secret, label) {
  return QRCode.toDataURL(totpFor(secret, label).toString());
}

// One-time recovery codes (returned in plaintext once; stored hashed by the caller).
export function newRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = Math.random().toString(36).slice(2, 7) + '-' + Math.random().toString(36).slice(2, 7);
    codes.push(raw);
  }
  return codes;
}
