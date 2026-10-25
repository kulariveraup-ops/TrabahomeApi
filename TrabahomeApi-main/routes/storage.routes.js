// routes/storage.routes.js
import express from "express";
import {
  verifySignedUrl,
  readAndDecryptIdDocument,
  readPrivatePaymentProof,
  uploadPublicAsset,
  STORAGE_FOLDERS,
} from "../services/cloudStorage.service.js";
import { uploadMiddleware, handleUploadError } from "../middleware/uploadMiddleware.js";

const router = express.Router();

// ── GET /api/storage/signed/view ─────────────────────────────────────────
// Serves short-lived signed URLs (e.g., admin ID audit with 10-minute expiry)
router.get("/signed/view", async (req, res) => {
  try {
    const { key, expires, token, purpose = "audit" } = req.query;

    if (!key || !expires || !token) {
      return res.status(400).json({
        success: false,
        message: "Missing required signed URL parameters (key, expires, token).",
      });
    }

    const verification = verifySignedUrl({
      documentKey: String(key),
      expires: String(expires),
      token: String(token),
      purpose: String(purpose),
    });

    if (!verification.valid) {
      return res.status(403).json({
        success: false,
        message: verification.reason || "Access denied. Signed URL is invalid or expired.",
      });
    }

    const safeKey = String(key);

    // 1. Handle strictly private encrypted ID documents
    if (safeKey.startsWith(STORAGE_FOLDERS.ID_VERIFICATIONS)) {
      const decrypted = await readAndDecryptIdDocument(safeKey);
      res.setHeader("Content-Type", decrypted.mimetype || "image/jpeg");
      res.setHeader("Content-Length", decrypted.size);
      res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      return res.status(200).send(decrypted.buffer);
    }

    // 2. Handle private payment proof documents
    if (safeKey.startsWith(STORAGE_FOLDERS.PROOF_OF_PAYMENT)) {
      const proof = await readPrivatePaymentProof(safeKey);
      res.setHeader("Content-Type", proof.mimetype || "image/jpeg");
      res.setHeader("Content-Length", proof.size);
      res.setHeader("Cache-Control", "private, max-age=600");
      return res.status(200).send(proof.buffer);
    }

    return res.status(404).json({
      success: false,
      message: "Requested storage key is not supported or not found.",
    });
  } catch (error) {
    console.error("Signed URL view error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to serve secure asset.",
    });
  }
});

// ── POST /api/upload/public ──────────────────────────────────────────────
// Upload public assets (Profiles & Proof of Work) directly to cloud storage
router.post(
  "/public",
  uploadMiddleware.fields([
    { name: "image", maxCount: 1 },
    { name: "avatar", maxCount: 1 },
    { name: "profileImage", maxCount: 1 },
    { name: "proofOfWork", maxCount: 10 },
    { name: "photos", maxCount: 10 },
  ]),
  handleUploadError,
  async (req, res) => {
    try {
      const folderParam = String(req.body?.folder || "").toLowerCase();
      const folder =
        folderParam === STORAGE_FOLDERS.PROOF_OF_WORK
          ? STORAGE_FOLDERS.PROOF_OF_WORK
          : STORAGE_FOLDERS.PROFILES;

      const singleFile =
        req.files?.image?.[0] ||
        req.files?.avatar?.[0] ||
        req.files?.profileImage?.[0];

      const multiFiles =
        req.files?.proofOfWork ||
        req.files?.photos ||
        [];

      // Handle multi-upload
      if (multiFiles.length > 0) {
        const uploadPromises = multiFiles.map((file) =>
          uploadPublicAsset(file.buffer, {
            filename: file.originalname,
            mimetype: file.mimetype,
            folder: STORAGE_FOLDERS.PROOF_OF_WORK,
            req,
          })
        );
        const results = await Promise.all(uploadPromises);
        return res.status(201).json({
          success: true,
          urls: results.map((r) => r.url),
          assets: results,
        });
      }

      // Handle single upload
      if (singleFile) {
        const result = await uploadPublicAsset(singleFile.buffer, {
          filename: singleFile.originalname,
          mimetype: singleFile.mimetype,
          folder,
          req,
        });
        return res.status(201).json({
          success: true,
          url: result.url,
          asset: result,
        });
      }

      return res.status(400).json({
        success: false,
        message: "No image file provided for upload.",
      });
    } catch (error) {
      console.error("Public upload error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to upload asset.",
      });
    }
  }
);

export default router;
