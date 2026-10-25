// middleware/uploadMiddleware.js
import multer from "multer";

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB limit

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// Memory storage keeps file buffers ready for streaming to cloud storage or encryption
const storage = multer.memoryStorage();

export const imageFileFilter = (_req, file, cb) => {
  const mime = String(file?.mimetype || "").toLowerCase().trim();
  if (ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
    cb(null, true);
  } else {
    const err = new Error(
      `Invalid file format (${file?.mimetype || "unknown"}). Only standard image files (JPEG, PNG, WebP, GIF) are allowed.`
    );
    err.name = "InvalidMimeTypeError";
    err.status = 400;
    cb(err, false);
  }
};

export const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 10,
  },
  fileFilter: imageFileFilter,
});

/**
 * Express error-handling middleware specifically catching Multer upload errors
 */
export const handleUploadError = (err, _req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "File size exceeds the 5MB maximum limit. Please upload a smaller image.",
        code: "LIMIT_FILE_SIZE",
      });
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        success: false,
        message: `Unexpected file field received: ${err.field}.`,
        code: "LIMIT_UNEXPECTED_FILE",
      });
    }
    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`,
      code: err.code,
    });
  }

  if (err.name === "InvalidMimeTypeError" || err.status === 400) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  return next(err);
};

export default {
  uploadMiddleware,
  handleUploadError,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
};
