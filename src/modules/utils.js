const crypto = require('crypto');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function withTimeout(promise, timeoutMs, errorMessage = 'Operation timed out') {
  const timeout = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMessage)), timeout);
    })
  ]).finally(() => clearTimeout(timer));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDayBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return { start, end, key: localDateKey(date) };
}

function normalizePhone(value, defaultCountryCode = '') {
  if (value === null || value === undefined) return null;

  let raw = String(value).trim();
  if (!raw) return null;

  raw = raw.replace(/@(c|s)\.us$/i, '');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  const countryCode = String(defaultCountryCode || '').replace(/\D/g, '');
  if (raw.startsWith('00')) {
    digits = digits.slice(2);
  } else if (!raw.startsWith('+') && countryCode) {
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    if (!digits.startsWith(countryCode)) digits = `${countryCode}${digits}`;
  }

  // E.164 permits a maximum of 15 digits. A practical minimum is 8 digits.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function normalizeWhatsAppId(value, defaultCountryCode = '') {
  const digits = normalizePhone(value, defaultCountryCode);
  return digits ? `${digits}@c.us` : null;
}

function displayPhone(value) {
  const digits = normalizePhone(value);
  return digits ? `+${digits}` : String(value || '');
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((tag) => String(tag).trim()).filter(Boolean))];
  }
  return [...new Set(String(value || '')
    .split(/[;,|]/)
    .map((tag) => tag.trim())
    .filter(Boolean))];
}

function truthyCsv(value) {
  return ['1', 'true', 'yes', 'y', 'opted-in', 'opted in', 'consented'].includes(
    String(value || '').trim().toLowerCase()
  );
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sanitizeText(value, maxLength = 5000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function randomBetween(min, max) {
  const low = Math.max(0, Number(min) || 0);
  const high = Math.max(low, Number(max) || low);
  return Math.floor(low + Math.random() * (high - low + 1));
}

module.exports = {
  sleep,
  withTimeout,
  localDateKey,
  localDayBounds,
  normalizePhone,
  normalizeWhatsAppId,
  displayPhone,
  parseTags,
  truthyCsv,
  stableHash,
  sanitizeText,
  randomBetween
};
