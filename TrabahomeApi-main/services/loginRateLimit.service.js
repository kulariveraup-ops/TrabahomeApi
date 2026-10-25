const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const LOGIN_MAX_ATTEMPTS = toPositiveInt(process.env.LOGIN_ATTEMPTS, 5);
const configuredBlockSeconds = toPositiveInt(process.env.LOGIN_BLOCK_SECONDS, 0);
const configuredBlockMinutes = toPositiveInt(process.env.LOGIN_BLOCK_MINUTES, 0);
const LOGIN_LOCKOUT_SECONDS =
  configuredBlockSeconds > 0
    ? configuredBlockSeconds
    : configuredBlockMinutes > 0
      ? configuredBlockMinutes * 60
      : 300;

const attempts = new Map();
let lastConfigSignature = "";

const loadLoginRateLimitConfig = () => ({
  maxAttempts: LOGIN_MAX_ATTEMPTS,
  blockSeconds: LOGIN_LOCKOUT_SECONDS,
  windowMs: LOGIN_LOCKOUT_SECONDS * 1000,
});

export const getLoginRateLimitConfig = () => loadLoginRateLimitConfig();

const syncConfigState = () => {
  const { maxAttempts, blockSeconds, windowMs } = loadLoginRateLimitConfig();
  const signature = `${maxAttempts}|${blockSeconds}|${windowMs}`;
  if (signature !== lastConfigSignature) {
    attempts.clear();
    lastConfigSignature = signature;
  }
  return { maxAttempts, blockSeconds, windowMs };
};

const getEntry = (key, now) => {
  const { windowMs } = syncConfigState();
  const entry = attempts.get(key);
  if (!entry) return null;
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    attempts.delete(key);
    return null;
  }
  if (!entry.blockedUntil && now - entry.firstAttemptAt > windowMs) {
    attempts.delete(key);
    return null;
  }
  return entry;
};

export const buildLoginRateLimitKey = (userType, email) =>
  `${String(userType || "unknown").trim().toLowerCase()}:${String(email || "").trim().toLowerCase()}`;

export const isLoginRateLimited = (key) => {
  const now = Date.now();
  const entry = getEntry(key, now);
  return Boolean(entry && entry.blockedUntil && now < entry.blockedUntil);
};

export const recordLoginFailure = (key) => {
  const now = Date.now();
  const { maxAttempts, windowMs } = syncConfigState();
  let entry = getEntry(key, now);
  if (!entry) {
    entry = {
      count: 0,
      firstAttemptAt: now,
      lastAttemptAt: now,
      blockedUntil: null,
    };
  }

  entry.count += 1;
  entry.lastAttemptAt = now;

  if (entry.count >= maxAttempts) {
    entry.blockedUntil = now + windowMs;
  }

  attempts.set(key, entry);
  return Boolean(entry.blockedUntil && now < entry.blockedUntil);
};

export const clearLoginFailures = (key) => {
  attempts.delete(key);
};
