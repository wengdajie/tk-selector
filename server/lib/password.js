'use strict';
const crypto = require('crypto');

const KEYLEN = 32;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** 未设置密码时视为免密，一律通过 */
function verifyPassword(pw, stored) {
  if (!stored) return true;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const calc = crypto.scryptSync(String(pw || ''), salt, KEYLEN);
  const expect = Buffer.from(hash, 'hex');
  if (calc.length !== expect.length) return false;
  return crypto.timingSafeEqual(calc, expect);
}

module.exports = { hashPassword, verifyPassword };
