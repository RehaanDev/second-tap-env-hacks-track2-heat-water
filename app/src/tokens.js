// Private links.
//
// Second Tap has no passwords. When someone publishes a listing or a
// request, they get a private link containing a long random "token".
// Whoever has the link can edit or remove that one record.
//
// Only a fingerprint (hash) of the token is saved, so even someone who
// could read the database could not rebuild the link.

import crypto from 'node:crypto';

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function tokenMatches(token, savedHash) {
  if (typeof token !== 'string' || !token || typeof savedHash !== 'string' || !savedHash) return false;
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(savedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
