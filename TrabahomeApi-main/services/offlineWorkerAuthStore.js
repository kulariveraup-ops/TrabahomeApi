import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_DIR = path.join(__dirname, "..", ".cache");
const STORE_FILE = path.join(STORE_DIR, "offline-worker-auth.json");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const readStore = async () => {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeStore = async (store) => {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
};

let writeQueue = Promise.resolve();

const enqueueWrite = (mutator) => {
  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const nextStore = (await mutator(store)) || store;
    await writeStore(nextStore);
    return nextStore;
  });
  return writeQueue;
};

export const isOfflineAuthMode = () =>
  String(process.env.MONGO_OFFLINE_MODE || "").toLowerCase() === "true";

export const getOfflineWorkerRecord = async (email) => {
  const store = await readStore();
  return store[normalizeEmail(email)] || null;
};

export const saveOfflineWorkerRecord = async ({ email, passwordHash, profile = null }) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return enqueueWrite(async (store) => {
    store[normalizedEmail] = {
      email: normalizedEmail,
      passwordHash: String(passwordHash || ""),
      profile: profile && typeof profile === "object" ? profile : null,
      updatedAt: new Date().toISOString(),
    };
    return store;
  });
};

export const updateOfflineWorkerProfile = async (email, profileUpdates = {}) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return enqueueWrite(async (store) => {
    const existing = store[normalizedEmail] || {
      email: normalizedEmail,
      passwordHash: "",
      profile: null,
      updatedAt: new Date().toISOString(),
    };

    store[normalizedEmail] = {
      ...existing,
      profile: {
        ...(existing.profile && typeof existing.profile === "object" ? existing.profile : {}),
        ...(profileUpdates && typeof profileUpdates === "object" ? profileUpdates : {}),
      },
      updatedAt: new Date().toISOString(),
    };

    return store;
  });
};
