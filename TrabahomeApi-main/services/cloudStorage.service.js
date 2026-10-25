// services/cloudStorage.service.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base directory for local cloud storage mirror
export const STORAGE_ROOT = process.env.STORAGE_LOCAL_DIR
  ? path.resolve(process.env.STORAGE_LOCAL_DIR)
  : path.resolve(__dirname, "../storage");

export const PUBLIC_STORAGE_ROOT = path.join(STORAGE_ROOT, "public");

export const STORAGE_FOLDERS = {
  PROFILES: "profiles",
  PROOF_OF_WORK: "proof_of_work",
  PROOF_OF_PAYMENT: "proof_of_payment",
  ID_VERIFICATIONS: "id_verifications",
};

// Ensure all required cloud storage folder directories exist
export const ensureStorageDirectories = () => {
  const dirs = [
    path.join(STORAGE_ROOT, "public", STORAGE_FOLDERS.PROFILES),
    path.join(STORAGE_ROOT, "public", STORAGE_FOLDERS.PROOF_OF_WORK),
    path.join(STORAGE_ROOT, "private", STORAGE_FOLDERS.PROOF_OF_PAYMENT),
    path.join(STORAGE_ROOT, "private", STORAGE_FOLDERS.ID_VERIFICATIONS),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
};
ensureStorageDirectories();

// Cryptographic keys derived from system environment secrets
const getEncryptionKey = () => {
  const secret =
    process.env.STORAGE_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "trabahome-default-32byte-cloud-storage-key-2026";
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
};

const getSignedUrlSecret = () => {
  return (
    process.env.SIGNED_URL_SECRET ||
    process.env.JWT_SECRET ||
    "trabahome-signed-url-secret-2026"
  );
};

// Public CDN / Base URL resolution
export const getPublicCdnBaseUrl = (req) => {
  if (process.env.STORAGE_CDN_URL) {
    return process.env.STORAGE_CDN_URL.replace(/\/+$/, "");
  }
  if (req) {
    const protocol = req.protocol || "http";
    const host = req.get("host") || `localhost:${process.env.PORT || 8000}`;
    return `${protocol}://${host}/storage/public`;
  }
  const port = process.env.PORT || 8000;
  return `http://localhost:${port}/storage/public`;
};

// Map file extensions from standard image mimetypes
export const getExtensionFromMime = (mimetype) => {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[String(mimetype || "").toLowerCase()] || ".jpg";
};

// ── 1. Public Assets Upload (Profiles & Proof of Work) ─────────
export const uploadPublicAsset = async (buffer, { filename, mimetype, folder = STORAGE_FOLDERS.PROFILES, req } = {}) => {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("Invalid file buffer provided for public asset upload.");
  }

  ensureStorageDirectories();

  const safeFolder =
    folder === STORAGE_FOLDERS.PROOF_OF_WORK
      ? STORAGE_FOLDERS.PROOF_OF_WORK
      : STORAGE_FOLDERS.PROFILES;

  const ext = getExtensionFromMime(mimetype) || path.extname(filename || ".jpg") || ".jpg";
  const uniqueName = `${safeFolder.slice(0, 4)}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const targetPath = path.join(STORAGE_ROOT, "public", safeFolder, uniqueName);

  await fs.promises.writeFile(targetPath, buffer);

  const cdnBase = getPublicCdnBaseUrl(req);
  const publicUrl = `${cdnBase}/${safeFolder}/${uniqueName}`;
  const relativePath = `/storage/public/${safeFolder}/${uniqueName}`;

  return {
    url: publicUrl,
    relativePath,
    key: `${safeFolder}/${uniqueName}`,
    filename: uniqueName,
    size: buffer.length,
    mimetype: mimetype || "image/jpeg",
  };
};

// ── 2. Private Assets Upload (Proof of Payment) ───────────────
export const uploadPrivatePaymentProof = async (buffer, { filename, mimetype } = {}) => {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("Invalid file buffer provided for private payment proof upload.");
  }

  ensureStorageDirectories();

  const ext = getExtensionFromMime(mimetype) || path.extname(filename || ".jpg") || ".jpg";
  const uniqueName = `pop-${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const targetPath = path.join(STORAGE_ROOT, "private", STORAGE_FOLDERS.PROOF_OF_PAYMENT, uniqueName);

  await fs.promises.writeFile(targetPath, buffer);

  const key = `${STORAGE_FOLDERS.PROOF_OF_PAYMENT}/${uniqueName}`;

  return {
    key,
    filename: uniqueName,
    size: buffer.length,
    mimetype: mimetype || "image/jpeg",
  };
};

// Read a private payment proof file
export const readPrivatePaymentProof = async (key) => {
  const safeKey = String(key || "").replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(STORAGE_ROOT, "private", safeKey);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Payment proof not found at key: ${safeKey}`);
  }

  const buffer = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return {
    buffer,
    mimetype: mimeMap[ext] || "image/jpeg",
    size: buffer.length,
  };
};

// ── 3. Strictly Private & Encrypted Upload (AI ID Verification) ──
export const uploadEncryptedIdDocument = async (buffer, { filename, mimetype, prefix = "id" } = {}) => {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("Invalid file buffer provided for encrypted ID upload.");
  }

  ensureStorageDirectories();

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encryptedData = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  // Header format: [12 bytes IV][16 bytes Auth Tag][4 bytes MIME length][MIME string][Encrypted Data]
  const mimeBuffer = Buffer.from(String(mimetype || "image/jpeg"), "utf8");
  const mimeLenBuffer = Buffer.alloc(4);
  mimeLenBuffer.writeUInt32BE(mimeBuffer.length, 0);

  const finalPayload = Buffer.concat([iv, authTag, mimeLenBuffer, mimeBuffer, encryptedData]);

  const uniqueName = `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.enc`;
  const targetPath = path.join(STORAGE_ROOT, "private", STORAGE_FOLDERS.ID_VERIFICATIONS, uniqueName);

  await fs.promises.writeFile(targetPath, finalPayload);

  const documentKey = `${STORAGE_FOLDERS.ID_VERIFICATIONS}/${uniqueName}`;

  return {
    idDocumentKey: documentKey,
    filename: uniqueName,
    size: buffer.length,
    encryptedSize: finalPayload.length,
    mimetype: mimetype || "image/jpeg",
  };
};

// Decrypt an ID document on demand
export const readAndDecryptIdDocument = async (documentKey) => {
  const safeKey = String(documentKey || "").replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(STORAGE_ROOT, "private", safeKey);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Encrypted ID document not found at key: ${safeKey}`);
  }

  const fileData = await fs.promises.readFile(filePath);
  if (fileData.length < 32) {
    throw new Error("Invalid encrypted ID payload structure.");
  }

  const iv = fileData.subarray(0, 12);
  const authTag = fileData.subarray(12, 28);
  const mimeLen = fileData.readUInt32BE(28);
  const mimeType = fileData.subarray(32, 32 + mimeLen).toString("utf8") || "image/jpeg";
  const encryptedPayload = fileData.subarray(32 + mimeLen);

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decryptedBuffer = Buffer.concat([
    decipher.update(encryptedPayload),
    decipher.final(),
  ]);

  return {
    buffer: decryptedBuffer,
    mimetype: mimeType,
    size: decryptedBuffer.length,
  };
};

// ── 4. Short-Lived Signed URLs (10-Minute Expiry) ───────────────
export const generateSignedUrl = ({
  documentKey,
  expiresInSeconds = 600, // 10 minutes default
  purpose = "audit",
  req,
}) => {
  const safeKey = String(documentKey || "").trim();
  if (!safeKey) return "";

  const expires = Date.now() + expiresInSeconds * 1000;
  const secret = getSignedUrlSecret();

  const hmacData = `${safeKey}:${expires}:${purpose}`;
  const token = crypto.createHmac("sha256", secret).update(hmacData).digest("hex");

  const baseUrl = req
    ? `${req.protocol || "http"}://${req.get("host") || `localhost:${process.env.PORT || 8000}`}`
    : `http://localhost:${process.env.PORT || 8000}`;

  return `${baseUrl}/api/storage/signed/view?key=${encodeURIComponent(safeKey)}&expires=${expires}&token=${token}&purpose=${purpose}`;
};

export const verifySignedUrl = ({ documentKey, expires, token, purpose = "audit" }) => {
  if (!documentKey || !expires || !token) {
    return { valid: false, reason: "Missing signed URL parameters." };
  }

  const expiresTime = Number(expires);
  if (!Number.isFinite(expiresTime) || Date.now() > expiresTime) {
    return { valid: false, reason: "Signed URL has expired (10-minute validity exceeded)." };
  }

  const secret = getSignedUrlSecret();
  const expectedData = `${documentKey}:${expires}:${purpose}`;
  const expectedToken = crypto.createHmac("sha256", secret).update(expectedData).digest("hex");

  const tokenBuffer = Buffer.from(String(token));
  const expectedBuffer = Buffer.from(expectedToken);

  if (tokenBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(tokenBuffer, expectedBuffer)) {
    return { valid: false, reason: "Invalid signed URL token or tampering detected." };
  }

  return { valid: true, expiresTime };
};

// ── 5. Base64 Migration / Normalization Helpers ────────────────
export const isBase64DataUrl = (str) => {
  if (typeof str !== "string") return false;
  return str.startsWith("data:image/") && str.includes(";base64,");
};

export const parseBase64DataUrl = (dataUrl) => {
  const matches = String(dataUrl || "").match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    return null;
  }
  const mimetype = matches[1];
  const buffer = Buffer.from(matches[2], "base64");
  return { mimetype, buffer };
};

// Automatically converts base64 payloads to public cloud assets
export const convertBase64ToPublicAsset = async (input, folder = STORAGE_FOLDERS.PROFILES, req) => {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim();

  // If already an HTTP/HTTPS or CDN URL, preserve it
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/storage/")) {
    return trimmed;
  }

  // If base64 data URL, upload to public cloud folder
  if (isBase64DataUrl(trimmed)) {
    const parsed = parseBase64DataUrl(trimmed);
    if (parsed && parsed.buffer) {
      const uploaded = await uploadPublicAsset(parsed.buffer, {
        mimetype: parsed.mimetype,
        folder,
        req,
      });
      return uploaded.url;
    }
  }

  return "";
};

// Automatically converts base64 proof of payment to private asset key
export const convertBase64ToPrivatePaymentProof = async (input) => {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim();

  if (trimmed.startsWith("proof_of_payment/")) {
    return trimmed;
  }

  if (isBase64DataUrl(trimmed)) {
    const parsed = parseBase64DataUrl(trimmed);
    if (parsed && parsed.buffer) {
      const uploaded = await uploadPrivatePaymentProof(parsed.buffer, {
        mimetype: parsed.mimetype,
      });
      return uploaded.key;
    }
  }

  return trimmed;
};

export default {
  STORAGE_FOLDERS,
  uploadPublicAsset,
  uploadPrivatePaymentProof,
  readPrivatePaymentProof,
  uploadEncryptedIdDocument,
  readAndDecryptIdDocument,
  generateSignedUrl,
  verifySignedUrl,
  convertBase64ToPublicAsset,
  convertBase64ToPrivatePaymentProof,
  isBase64DataUrl,
  parseBase64DataUrl,
  getPublicCdnBaseUrl,
  ensureStorageDirectories,
};
