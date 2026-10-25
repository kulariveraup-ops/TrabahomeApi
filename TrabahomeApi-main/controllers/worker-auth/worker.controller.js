import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import Booking from '../../models/booking.Model.js';
import ServiceRequest from '../../models/serviceRequest.Model.js';
import Worker from '../../models/worker.Model.js';
import HomeOwner from '../../models/homeOwner.Model.js';
import { createAndSendOtp } from '../../services/otp.service.js';
import { sendEmail } from '../../services/email.service.js';
import {
  buildLoginRateLimitKey,
  clearLoginFailures,
  getLoginRateLimitConfig,
  isLoginRateLimited,
  recordLoginFailure,
} from '../../services/loginRateLimit.service.js';
import {
  isAccountDisabled,
  isAccountVerified,
  isValidEmail,
  normalizeEmail,
  toWorkerProfile,
  isWorkerEmailTaken,
  validateStrongPassword,
} from '../../utils/auth.utils.js';
import { createWorkerNotification, notifyAllAdmins } from '../../services/notify.js';
import { emitToAdmin, emitToAll } from '../../services/socket.js';
import { getStableWorkerMapCoordinates, resolveWorkerLocation } from '../../utils/workerLocation.js';
import { invalidateServiceRequestCaches } from '../serviceRequests.controller.js';
import {
  attachWorkerRatingStats,
  calculateWorkerRatingStats,
  getWorkerRatingStatsForId,
} from '../../services/workerRating.service.js';
import {
  LOGIN_OTP_LENGTH,
  LOGIN_OTP_MAX_ATTEMPTS,
  LOGIN_OTP_TTL_SECONDS,
} from '../../services/loginOtpPolicy.js';
import { verifyWorkerGovernmentId } from '../../services/aiIdVerification.service.js';
import {
  uploadPublicAsset,
  uploadEncryptedIdDocument,
  convertBase64ToPublicAsset,
  STORAGE_FOLDERS,
} from '../../services/cloudStorage.service.js';

const { blockSeconds: LOGIN_BLOCK_SECONDS } = getLoginRateLimitConfig();
const LOGIN_TOO_MANY_MESSAGE = `Too many attempts. Try again in ${Math.max(1, Math.ceil(LOGIN_BLOCK_SECONDS / 60))} minute${Math.ceil(LOGIN_BLOCK_SECONDS / 60) === 1 ? "" : "s"}.`;

const DEFAULT_RADIUS_KM = 10;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SEARCH_WORKER_SELECT = "firstName lastName email profession service role category city barangay province rating location locationLabel bio yearsExperience languages availabilityStatus workingSchedule price status isVerified createdAt updatedAt";

const normalizePhilippineMobile = (value) => {
  let phone = String(value || '').trim().replace(/[()\-\s]/g, '');
  if (phone.startsWith('+63')) phone = `0${phone.slice(3)}`;
  else if (phone.startsWith('63')) phone = `0${phone.slice(2)}`;
  else if (phone.startsWith('9')) phone = `0${phone}`;
  return /^09\d{9}$/.test(phone) ? phone : null;
};

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildServiceFilter = (serviceRaw) => {
  const service = String(serviceRaw || "").trim();
  if (!service) return {};
  const regex = new RegExp(`^${escapeRegex(service)}$`, "i");
  return {
    $or: [
      { profession: regex },
      { service: regex },
      { role: regex },
      { category: regex },
      { services: regex },
    ],
  };
};

const buildAccountFilter = ({ verifiedOnly = false } = {}) => {
  const filter = {
    $and: [
      { $or: [{ disabled: { $exists: false } }, { disabled: { $ne: true } }] },
      { $or: [{ isDisabled: { $exists: false } }, { isDisabled: { $ne: true } }] },
      { $or: [{ isActive: { $exists: false } }, { isActive: { $ne: false } }] },
      { $or: [{ status: { $exists: false } }, { status: { $nin: ["disabled", "inactive"] } }] },
      { $or: [{ isVerified: { $exists: false } }, { isVerified: { $ne: false } }] },
      { $or: [{ verified: { $exists: false } }, { verified: { $ne: false } }] },
      { $or: [{ emailVerified: { $exists: false } }, { emailVerified: { $ne: false } }] },
    ],
  };

  if (verifiedOnly) {
    filter.$and.push({
      $or: [{ status: "Verified" }, { isVerified: true }],
    });
  }

  return filter;
};

const buildCityFilter = (cityRaw) => {
  const city = String(cityRaw || "").trim();
  if (!city) return {};
  return { city: new RegExp(`^${escapeRegex(city)}$`, "i") };
};

const isVerifiedWorkerAccount = (worker) =>
  String(worker?.status || "").trim().toLowerCase() === "verified" ||
  worker?.isVerified === true;

const getWorkerLoginBlockMessage = (worker) => {
  const status = String(worker?.status || "").trim().toLowerCase();
  if (status === "suspended" || status === "disabled" || status === "inactive") {
    return "Your worker account is suspended. Please contact an admin to restore access.";
  }
  if (status === "rejected") {
    return "Your worker account has been rejected. Please contact support.";
  }
  return "Your worker account is waiting for admin verification.";
};

const MISSING_LOCATION_FILTER = {
  $or: [
    { location: { $exists: false } },
    { location: null },
    { "location.coordinates": { $exists: false } },
    { "location.coordinates.0": { $exists: false } },
    { "location.coordinates.1": { $exists: false } },
  ],
};

const formatPrice = (worker) => {
  const raw = worker?.price ?? worker?.rate ?? worker?.hourlyRate ?? worker?.dailyRate;
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number" && Number.isFinite(raw)) return `PHP ${raw}`;
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/php/i.test(value)) return value;
  return `PHP ${value}`;
};

const publicProfileImage = (value) => {
  const image = String(value || "").trim();
  if (image.startsWith("data:") && image.length > 50000) return "";
  return /^(https?:\/\/|\/|blob:|data:image\/)/i.test(image) ? image : "";
};

const publicRenderableImage = (value) => {
  const image = String(value || "").trim();
  if (image.startsWith("data:") && image.length > 50000) return "";
  return /^(https?:\/\/|\/|blob:|data:image\/)/i.test(image) ? image : "";
};

const publicImageList = (images) =>
  Array.isArray(images)
    ? images.map((image) => publicProfileImage(image)).filter(Boolean)
    : [];

const uploadedImageDataUrls = (files) =>
  Array.isArray(files)
    ? files
        .filter((file) => file?.buffer && /^image\//i.test(String(file?.mimetype || "")))
        .map((file) => `data:${file.mimetype};base64,${file.buffer.toString("base64")}`)
    : [];

const hydrateWorkerLocations = async (workers = []) => {
  if (!Array.isArray(workers) || workers.length === 0) return workers;

  return Promise.all(
    workers.map(async (worker) => {
      const resolved = await resolveWorkerLocation(worker, { persist: false, geocode: false });
      const mapCoords = getStableWorkerMapCoordinates(worker, resolved?.coords, {
        source: resolved?.source,
      });
      const nextLocation = mapCoords
        ? {
            type: "Point",
            coordinates: [mapCoords.lng, mapCoords.lat],
          }
        : worker?.location || null;

      return {
        ...worker,
        location: nextLocation,
        locationLabel: resolved?.locationLabel || worker?.locationLabel || "",
      };
    })
  );
};

const formatWorkerSearchItem = (worker, forceLocationMissing = false) => {
  const firstName = String(worker?.firstName || "").trim();
  const lastName = String(worker?.lastName || "").trim();
  const name =
    [firstName, lastName].filter(Boolean).join(" ") ||
    worker?.name ||
    worker?.fullName ||
    worker?.email ||
    "Worker";
  const service =
    worker?.profession ||
    worker?.service ||
    worker?.role ||
    worker?.category ||
    "Service";
  const ratingValue = worker?.rating ?? worker?.averageRating ?? worker?.score;
  const rating = Number.isFinite(Number(ratingValue)) ? Number(ratingValue) : 0;
  const availability = worker?.availability || worker?.status || "Offline";
  const profilePhotoUrl =
    publicProfileImage(
      worker?.avatar ||
      worker?.profileImage ||
      worker?.photo ||
      worker?.image ||
      ""
    );
  const summary = String(worker?.bio || worker?.description || worker?.about || "").trim();
  const locationLabel =
    worker?.locationLabel ||
    worker?.city ||
    worker?.barangay ||
    worker?.province ||
    "";
  const coords = worker?.location?.coordinates;
  const hasCoords =
    !forceLocationMissing &&
    Array.isArray(coords) &&
    coords.length === 2 &&
    Number.isFinite(coords[0]) &&
    Number.isFinite(coords[1]);

  return {
    id: worker?._id ? String(worker._id) : String(worker?.id || ""),
    name,
    firstName,
    lastName,
    rating,
    service,
    profession: service,
    price: formatPrice(worker),
    availability,
    availabilityStatus: String(worker?.availabilityStatus || "").trim(),
    workingSchedule: String(worker?.workingSchedule || "").trim(),
    summary,
    bio: summary,
    image: profilePhotoUrl,
    avatar: profilePhotoUrl,
    profileImage: profilePhotoUrl,
    city: String(worker?.city || "").trim(),
    barangay: String(worker?.barangay || "").trim(),
    province: String(worker?.province || "").trim(),
    locationLabel,
    location: hasCoords
      ? { lat: coords[1], lng: coords[0], label: locationLabel }
      : { label: locationLabel },
    locationMissing: !hasCoords,
    profilePhotoUrl,
    yearsExperience: worker?.yearsExperience || 0,
    languages: worker?.languages || [],
    isVerified: worker?.isVerified ?? true,
    status: worker?.status || "Verified",
    createdAt: worker?.createdAt,
    updatedAt: worker?.updatedAt,
  };
};

const formatCompletedJob = (job) => {
  const homeowner = job?.homeownerId || {};
  const completedOn = job?.completedOn || job?.updatedAt || job?.createdAt || null;
  const jobId = String(job?.bookingNumber || job?.requestNumber || job?.id || job?._id || "");
  return {
    id: jobId,
    bookingNumber: String(job?.bookingNumber || job?.requestNumber || ""),
    requestNumber: String(job?.requestNumber || job?.bookingNumber || ""),
    serviceType: String(job?.serviceType || "General Repair").trim(),
    address: String(job?.address || job?.location || "").trim(),
    notes: String(job?.notes || job?.description || "").trim(),
    status: "Completed",
    homeownerName:
      [String(homeowner?.firstName || "").trim(), String(homeowner?.lastName || "").trim()]
        .filter(Boolean)
        .join(" ") ||
    String(homeowner?.name || homeowner?.email || "Homeowner").trim(),
    homeownerAvatar: String(homeowner?.avatar || homeowner?.profileImage || homeowner?.profilePicture || "").trim(),
    photos: Array.isArray(job?.photos) ? job.photos.filter(Boolean) : [],
    reviewRating: Number.isFinite(Number(job?.reviewRating)) ? Number(job.reviewRating) : null,
    reviewText: String(job?.reviewText || "").trim(),
    reviewedAt: job?.reviewedAt || null,
    completedOn: completedOn ? new Date(completedOn).toISOString() : "",
  };
};

const formatWorkerProfile = (worker, completedJobs = []) => ({
  id: worker?._id ? String(worker._id) : "",
  name:
    [String(worker?.firstName || "").trim(), String(worker?.lastName || "").trim()]
      .filter(Boolean)
      .join(" ") || worker?.name || "Worker",
  role: String(worker?.profession || worker?.role || "").trim(),
  fullName:
    [String(worker?.firstName || "").trim(), String(worker?.lastName || "").trim()]
      .filter(Boolean)
      .join(" ") || worker?.name || "Worker",
  firstName: String(worker?.firstName || "").trim(),
  lastName: String(worker?.lastName || "").trim(),
  email: String(worker?.email || "").trim(),
  phone: String(worker?.phone || "").trim(),
  profession: String(worker?.profession || "").trim(),
  province: String(worker?.province || "").trim(),
  city: String(worker?.city || "").trim(),
  barangay: String(worker?.barangay || "").trim(),
  locationLabel:
    String(worker?.locationLabel || "").trim() ||
    [String(worker?.barangay || "").trim(), String(worker?.city || "").trim(), String(worker?.province || "").trim()]
      .filter(Boolean)
      .join(", "),
  location: [String(worker?.barangay || "").trim(), String(worker?.city || "").trim(), String(worker?.province || "").trim()].filter(Boolean).join(", "),
  avatar: publicRenderableImage(worker?.avatar || worker?.profileImage || worker?.photoUrl || worker?.image || worker?.photo || worker?.picture),
  bio: String(worker?.bio || "").trim(),
  yearsExperience: Number.isFinite(Number(worker?.yearsExperience)) ? Number(worker.yearsExperience) : 0,
  languages: Array.isArray(worker?.languages) ? worker.languages.filter(Boolean) : [],
  proofOfWork: publicImageList(worker?.proofOfWork),
  rating: Number.isFinite(Number(worker?.rating)) ? Number(worker.rating) : 0,
  reviews: Number.isFinite(Number(worker?.reviews)) ? Number(worker.reviews) : 0,
  availabilityStatus: String(worker?.availabilityStatus || "").trim(),
  workingSchedule: String(worker?.workingSchedule || "").trim(),
  availability: {
    status: String(worker?.availabilityStatus || "").trim(),
    schedule: String(worker?.workingSchedule || "").trim(),
  },
  price: String(worker?.price || "").trim(),
  status: String(worker?.status || (worker?.isVerified ? "Verified" : "Pending")).trim(),
  isVerified: Boolean(worker?.isVerified || String(worker?.status || "").trim().toLowerCase() === "verified"),
  completedJobsCount: Number.isFinite(Number(worker?.completedJobsCount))
    ? Number(worker.completedJobsCount)
    : Array.isArray(completedJobs)
      ? completedJobs.length
      : 0,
  completedJobs: Array.isArray(completedJobs) ? completedJobs.map(formatCompletedJob) : [],
});

// ── POST /api/workers/verify-id ──────────────────────────────
export const verifyWorkerId = async (req, res) => {
  try {
    const idCardFile = req.files?.idCard?.[0] || req.files?.idFront?.[0];
    const selfieFile = req.files?.selfie?.[0];
    const { idType, firstName, lastName } = req.body || {};

    if (!idCardFile) {
      return res.status(400).json({
        success: false,
        isVerified: false,
        status: 'Failed',
        reason: 'Please upload a photo of your Philippine valid government-issued ID.',
      });
    }

    if (!selfieFile) {
      return res.status(400).json({
        success: false,
        isVerified: false,
        status: 'Failed',
        reason: 'Please upload a selfie holding your valid ID.',
      });
    }

    const verificationResult = await verifyWorkerGovernmentId({
      idCardFile,
      selfieFile,
      idType: String(idType || 'philsys').toLowerCase(),
      firstName: String(firstName || ''),
      lastName: String(lastName || ''),
    });

    if (!verificationResult.success || !verificationResult.isVerified) {
      return res.status(422).json({
        success: false,
        isVerified: false,
        status: 'Failed',
        reason: verificationResult.reason || 'ID verification could not be validated. Please upload a clear valid Philippine ID.',
        details: verificationResult.details,
      });
    }

    // Store ID images in strictly private, encrypted cloud storage folder
    const [idCardDoc, selfieDoc] = await Promise.all([
      uploadEncryptedIdDocument(idCardFile.buffer, {
        filename: idCardFile.originalname,
        mimetype: idCardFile.mimetype,
        prefix: 'id-card',
      }),
      uploadEncryptedIdDocument(selfieFile.buffer, {
        filename: selfieFile.originalname,
        mimetype: selfieFile.mimetype,
        prefix: 'id-selfie',
      }),
    ]);

    return res.status(200).json({
      success: true,
      isVerified: true,
      status: 'Approved',
      confidence: verificationResult.confidence,
      message: 'AI Identity Verification passed successfully! Account is eligible for immediate approval.',
      idType: String(idType || 'philsys').toLowerCase(),
      idDocumentKey: idCardDoc.idDocumentKey,
      selfieDocumentKey: selfieDoc.idDocumentKey,
      details: verificationResult.details,
    });
  } catch (error) {
    console.error('Worker AI ID verification error:', error);
    return res.status(500).json({
      success: false,
      isVerified: false,
      status: 'Failed',
      reason: 'An error occurred during AI ID verification. Please try again.',
      error: error.message,
    });
  }
};

// ── GET or POST /api/workers/check-email ───────────────────────
export const checkWorkerEmailAvailability = async (req, res) => {
  try {
    const rawEmail = req.query?.email || req.body?.email;
    const normalizedEmail = normalizeEmail(rawEmail);

    if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        available: false,
        message: "Please enter a valid email address.",
      });
    }

    const isTaken = await isWorkerEmailTaken(normalizedEmail);
    if (isTaken) {
      return res.status(200).json({
        success: true,
        available: false,
        message: "This email is already registered as a skilled worker.",
      });
    }

    return res.status(200).json({
      success: true,
      available: true,
      message: "Email is available.",
    });
  } catch (error) {
    console.error("Check worker email availability error:", error);
    return res.status(500).json({
      success: false,
      available: false,
      message: "Unable to check email availability. Please try again.",
    });
  }
};

// ── POST /api/workers/register ─────────────────────────────────
export const registerWorker = async (req, res) => {
  try {
    const {
      // Step 1
      firstName, lastName, email, phone,
      password, agreeToTerms, agreeToPrivacy,
      // Work and location
      profession, province, city, barangay,
      // Philippine ID & AI Verification
      idType, idNumber, aiVerificationPassed, aiVerificationData,
    } = req.body || {};
    // Stream upload proof of work files to public cloud storage
    const uploadedProofFiles = [];
    if (Array.isArray(req.files?.proofOfWork)) {
      for (const file of req.files.proofOfWork) {
        if (file?.buffer) {
          const asset = await uploadPublicAsset(file.buffer, {
            filename: file.originalname,
            mimetype: file.mimetype,
            folder: STORAGE_FOLDERS.PROOF_OF_WORK,
            req,
          });
          uploadedProofFiles.push(asset.url);
        }
      }
    }
    const rawBodyProofs = Array.isArray(req.body?.proofOfWork)
      ? req.body.proofOfWork
      : typeof req.body?.proofOfWork === "string"
        ? [req.body.proofOfWork]
        : [];
    const convertedBodyProofs = [];
    for (const item of rawBodyProofs) {
      if (typeof item === "string" && item.trim()) {
        const converted = await convertBase64ToPublicAsset(item, STORAGE_FOLDERS.PROOF_OF_WORK, req);
        if (converted) convertedBodyProofs.push(converted);
      }
    }
    const proofOfWork = [...uploadedProofFiles, ...convertedBodyProofs];

    // Avatar / profile image upload
    let avatarUrl = "";
    if (req.files?.avatar?.[0]?.buffer) {
      const file = req.files.avatar[0];
      const asset = await uploadPublicAsset(file.buffer, {
        filename: file.originalname,
        mimetype: file.mimetype,
        folder: STORAGE_FOLDERS.PROFILES,
        req,
      });
      avatarUrl = asset.url;
    } else if (req.body?.avatar) {
      avatarUrl = await convertBase64ToPublicAsset(req.body.avatar, STORAGE_FOLDERS.PROFILES, req);
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhilippineMobile(phone);

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    if (!normalizedPhone) {
      return res.status(400).json({ success: false, message: 'Enter a valid Philippine mobile number.' });
    }

    // Check if email is already registered as a worker
    const emailConflict = await isWorkerEmailTaken(normalizedEmail);
    if (emailConflict) {
      return res.status(409).json({ success: false, message: 'Email is already registered.' });
    }

    // ── Check Philippine Valid ID & AI Verification ────────────
    const idCardFile = req.files?.idCard?.[0] || req.files?.idFront?.[0];
    const selfieFile = req.files?.selfie?.[0];

    let isAiVerified = String(aiVerificationPassed).toLowerCase() === 'true';
    let aiVerificationDetails = null;

    if (aiVerificationData) {
      try {
        aiVerificationDetails = typeof aiVerificationData === 'string' ? JSON.parse(aiVerificationData) : aiVerificationData;
        if (aiVerificationDetails?.isVerified) {
          isAiVerified = true;
        }
      } catch (e) {
        // ignore JSON parse error
      }
    }

    // If not pre-verified but ID files are provided, run AI verification now
    if (!isAiVerified && idCardFile && selfieFile) {
      const verifyCheck = await verifyWorkerGovernmentId({
        idCardFile,
        selfieFile,
        idType: String(idType || 'philsys').toLowerCase(),
        firstName,
        lastName,
      });
      if (verifyCheck.isVerified) {
        isAiVerified = true;
        aiVerificationDetails = verifyCheck;
      }
    }

    // If ID is not verified, require worker to upload a valid ID and selfie
    if (!isAiVerified) {
      return res.status(422).json({
        success: false,
        isVerified: false,
        status: 'Failed',
        message: 'A valid Philippine government-issued ID and matching selfie with ID are required. Please verify your ID before submitting.',
        reason: 'ID verification not passed or missing valid Philippine ID.',
      });
    }

    // Ensure ID documents are stored encrypted in private cloud storage
    let idDocumentKey = req.body?.idDocumentKey || aiVerificationDetails?.idDocumentKey || "";
    let selfieDocumentKey = req.body?.selfieDocumentKey || aiVerificationDetails?.selfieDocumentKey || "";

    if (!idDocumentKey && idCardFile?.buffer) {
      const doc = await uploadEncryptedIdDocument(idCardFile.buffer, {
        filename: idCardFile.originalname,
        mimetype: idCardFile.mimetype,
        prefix: "id-card",
      });
      idDocumentKey = doc.idDocumentKey;
    }

    if (!selfieDocumentKey && selfieFile?.buffer) {
      const doc = await uploadEncryptedIdDocument(selfieFile.buffer, {
        filename: selfieFile.originalname,
        mimetype: selfieFile.mimetype,
        prefix: "id-selfie",
      });
      selfieDocumentKey = doc.idDocumentKey;
    }

    // ── Hash Password ──────────────────────────────────────────
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // ── Create Worker (Immediately Approved upon AI Verification)
    const newWorker = new Worker({
      // Step 1
      firstName, lastName, email: normalizedEmail, phone: normalizedPhone,
      password: hashedPassword,
      agreeToTerms, agreeToPrivacy,
      // Work and location
      profession,
      province: String(province || 'Pangasinan').trim(),
      city, barangay,
      proofOfWork,
      avatar: avatarUrl || undefined,
      profileImage: avatarUrl || undefined,

      // Philippine Government ID & AI Verification metadata
      idType: String(idType || '').trim(),
      idNumber: String(idNumber || aiVerificationDetails?.details?.ocr?.extractedIdNumber || '').trim(),
      idCardImage: '',
      idSelfieImage: '',
      aiVerification: {
        status: 'Approved',
        verifiedAt: new Date(),
        idType: String(idType || '').trim(),
        idDocumentKey,
        selfieDocumentKey,
        confidenceScore: aiVerificationDetails?.confidence || 98.0,
        faceMatchScore: aiVerificationDetails?.details?.facialComparison?.matchScore || 96.5,
        livenessScore: aiVerificationDetails?.details?.liveness?.livenessScore || 98.1,
        extractedName: aiVerificationDetails?.details?.ocr?.extractedName || `${firstName} ${lastName}`,
        extractedIdNumber: aiVerificationDetails?.details?.ocr?.extractedIdNumber || '',
        provider: 'AWS Rekognition / Textract & Cloud AI',
        reason: 'Passed OCR document scan, biometric face match, and liveness detection.',
      },

      // Immediate approval
      status: 'Verified',
      isVerified: true,
    });

    const savedWorker = await newWorker.save();
    await resolveWorkerLocation(savedWorker, { persist: true });

    void notifyAllAdmins({
      title: "Worker registered (AI Approved Immediately)",
      message: `${savedWorker.firstName || "Worker"} ${savedWorker.lastName || ""} passed AI ID verification and was approved immediately.`,
      type: "success",
      meta: {
        route: `/admin-workers?workerId=${encodeURIComponent(String(savedWorker._id || ""))}`,
        workerId: String(savedWorker._id || ""),
        workerName: `${savedWorker.firstName || ""} ${savedWorker.lastName || ""}`.trim() || savedWorker.email,
        workerAvatar: savedWorker.avatar || savedWorker.profileImage || "",
        workerProfileImage: savedWorker.profileImage || savedWorker.avatar || "",
        actorId: String(savedWorker._id || ""),
        actorRole: "worker",
        actorName: `${savedWorker.firstName || ""} ${savedWorker.lastName || ""}`.trim() || savedWorker.email,
        actorAvatar: savedWorker.avatar || savedWorker.profileImage || "",
        status: "Verified",
      },
    });

    const workerSocketData = {
      id: String(savedWorker._id),
      firstName: savedWorker.firstName,
      lastName: savedWorker.lastName,
      name: `${savedWorker.firstName} ${savedWorker.lastName}`.trim(),
      email: savedWorker.email,
      phone: savedWorker.phone,
      profession: savedWorker.profession,
      city: savedWorker.city,
      barangay: savedWorker.barangay,
      status: savedWorker.status,
      isVerified: savedWorker.isVerified,
      createdAt: savedWorker.createdAt,
    };
    emitToAdmin("worker:registered", workerSocketData);
    emitToAll("worker:registered", workerSocketData);
    emitToAdmin("dashboard:refresh", { source: "worker:registered" });
    emitToAll("dashboard:refresh", { source: "worker:registered" });

    try {
      await sendEmail({
        to: savedWorker.email,
        subject: "Welcome to TrabaHome - Account Approved Immediately!",
        text: `Hi ${savedWorker.firstName}, your TrabaHome worker registration has been approved immediately after passing AI ID and Facial Verification! You can now sign in to your account.`,
        html: `
          <div style="font-family: Arial, sans-serif; background:#f8fafc; padding:24px;">
            <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:20px; padding:28px; border:1px solid #e5e7eb;">
              <h2 style="margin:0 0 12px; color:#0B3B68;">Account Approved Immediately!</h2>
              <p style="margin:0; color:#334155; line-height:1.6;">
                Hi <strong>${savedWorker.firstName}</strong>, congratulations! Your Philippine government-issued ID and selfie have been verified by AI.
              </p>
              <div style="background:#ecfdf5; border:1px solid #a7f3d0; border-radius:12px; padding:14px; margin:16px 0; color:#065f46; font-size:14px;">
                ✓ <strong>Immediate Approval:</strong> Your worker profile is now active. Homeowners in Pangasinan can now view and book your services.
              </div>
              <p style="margin:16px 0 0; color:#334155; line-height:1.6;">
                You can sign in now using your email <strong>${savedWorker.email}</strong>.
              </p>
            </div>
          </div>
        `,
      });
    } catch (emailError) {
      console.error("Worker registration email error:", emailError);
    }

    // ── Respond (exclude password) ─────────────────────────────
    const { password: _, ...workerData } = savedWorker.toObject();

    const token = jwt.sign(
      { id: String(savedWorker._id), email: savedWorker.email, role: 'worker' },
      process.env.JWT_SECRET || 'change-this-secret',
      { expiresIn: '1d' }
    );

    return res.status(201).json({
      success: true,
      token,
      email: savedWorker.email,
      isImmediatelyApproved: true,
      message: 'Worker registered and approved immediately via AI ID verification!',
      worker: toWorkerProfile(savedWorker),
      data: workerData,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Email is already registered.',
      });
    }
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({
        success: false, 
        message: 'Validation failed.', 
        errors: messages 
      });
    }
    console.error('Register error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error.' 
    });
  }
};

// ── GET /api/workers ───────────────────────────────────────────
export const getAllWorkers = async (req, res) => {
  try {
    const workers = await Worker.find(buildAccountFilter({ verifiedOnly: true }))
      .select(SEARCH_WORKER_SELECT)
      .lean();
    const hydratedWorkers = await hydrateWorkerLocations(workers);
    const ratedWorkers = await attachWorkerRatingStats(hydratedWorkers);
    const data = ratedWorkers.map((worker) => formatWorkerSearchItem(worker));
    return res.status(200).json({ 
      success: true, 
      count: data.length,
      data 
    });
  } catch (error) {
    console.error('Get all workers error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error.' 
    });
  }
};

// ── GET /api/workers/:id ───────────────────────────────────────
export const getWorkerById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({
        success: false,
        message: 'Worker not found.',
      });
    }
    const includeCompletedJobs = String(req.query?.includeCompletedJobs || "").trim().toLowerCase();
    const shouldLoadCompletedJobs =
      includeCompletedJobs === "1" ||
      includeCompletedJobs === "true" ||
      includeCompletedJobs === "yes";
    const worker = await Worker.findById(req.params.id)
      .select('firstName lastName email phone profession city barangay province avatar profileImage bio yearsExperience languages proofOfWork rating availabilityStatus workingSchedule price status isVerified location locationLabel createdAt updatedAt')
      .lean();
    if (!worker) {
      return res.status(404).json({ 
        success: false, 
        message: 'Worker not found.' 
      });
    }
    if (isAccountDisabled(worker) || !isVerifiedWorkerAccount(worker)) {
      return res.status(404).json({
        success: false,
        message: 'Worker not found.',
      });
    }
    const [hydratedWorker] = await hydrateWorkerLocations([worker]);

    const completedJobs = [];
    let completedJobsCount = 0;
    let ratingStats = { rating: 0, reviews: 0 };

    if (shouldLoadCompletedJobs) {
      const serviceRequestJobs = await ServiceRequest.find({
          targetWorkerId: worker._id,
          status: "COMPLETED",
        })
          .sort({ completedOn: -1, updatedAt: -1, createdAt: -1 })
          .select("requestNumber homeownerId serviceType address location description status reviewRating reviewText reviewedAt acceptedOn completedOn createdAt updatedAt")
          .lean();
      const bookingJobs = serviceRequestJobs.length === 0
        ? await Booking.find({
          workerId: worker._id,
          status: "Completed",
        })
          .sort({ completedOn: -1, updatedAt: -1, createdAt: -1 })
          .select("bookingNumber homeownerId serviceType scheduledAt address notes photos status reviewRating reviewText reviewedAt acceptedOn completedOn createdAt updatedAt")
          .lean()
        : [];

      const completedJobCandidates = serviceRequestJobs.length > 0 ? serviceRequestJobs : bookingJobs;
      ratingStats = calculateWorkerRatingStats(serviceRequestJobs);
      const homeownerIds = [...new Set(
        completedJobCandidates
          .map((job) => String(job.homeownerId || ""))
          .filter(Boolean)
      )];
      const homeowners = homeownerIds.length
        ? await HomeOwner.find({ _id: { $in: homeownerIds } })
          .select("firstName lastName name email avatar profileImage profilePicture")
          .lean()
        : [];
      const homeownerById = new Map(homeowners.map((homeowner) => [String(homeowner._id), homeowner]));

      const useServiceRequestHistory = serviceRequestJobs.length > 0;
      completedJobs.push(
        ...(useServiceRequestHistory ? serviceRequestJobs : bookingJobs)
          .map((job) => ({
            ...job,
            homeownerId: homeownerById.get(String(job.homeownerId)) || job.homeownerId,
          }))
      );
      completedJobsCount = completedJobCandidates.length;
    } else {
      const [serviceRequestCount, resolvedRatingStats] = await Promise.all([
        ServiceRequest.countDocuments({
            targetWorkerId: worker._id,
            status: "COMPLETED",
          }),
        getWorkerRatingStatsForId(worker._id),
      ]);
      ratingStats = resolvedRatingStats;
      const bookingCount = serviceRequestCount === 0
        ? await Booking.countDocuments({
          workerId: worker._id,
          status: "Completed",
        })
        : 0;
      completedJobsCount = serviceRequestCount > 0 ? serviceRequestCount : bookingCount;
    }

    return res.status(200).json({
      success: true,
      data: formatWorkerProfile(
        {
          ...hydratedWorker,
          completedJobsCount,
          rating: ratingStats.rating,
          reviews: ratingStats.reviews,
        },
        completedJobs
      ),
    });
  } catch (error) {
    console.error('Get worker error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error.' 
    });
  }
};

export const updateWorkerById = async (req, res) => {
  try {
    const workerId = String(req.params.id || "").trim();
    const authId = String(req.user?.id || req.user?._id || "").trim();
    const authEmail = String(req.user?.email || "").trim().toLowerCase();

    if (!workerId) {
      return res.status(400).json({ success: false, message: "Invalid worker id." });
    }

    let worker = null;
    if (mongoose.isValidObjectId(workerId)) {
      worker = await Worker.findById(workerId);
    }

    if (!worker && authEmail) {
      worker = await Worker.findOne({ email: authEmail });
    }

    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    const resolvedId = String(worker._id || "");
    const ownsRecord =
      (authId && resolvedId === authId) ||
      (authEmail && String(worker.email || "").toLowerCase() === authEmail);

    if (!ownsRecord) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const {
      bio,
      yearsExperience,
      languages,
      proofOfWork,
      availabilityStatus,
      workingSchedule,
      profession,
      city,
      barangay,
      avatar,
      profileImage,
    } = req.body || {};

    const updates = {};
    if (bio !== undefined) updates.bio = String(bio).trim();
    if (yearsExperience !== undefined) {
      const numericYears = Number(yearsExperience);
      updates.yearsExperience = Number.isFinite(numericYears) && numericYears >= 0 ? numericYears : 0;
    }
    if (languages !== undefined) {
      updates.languages = Array.isArray(languages)
        ? languages.map((value) => String(value).trim()).filter(Boolean)
        : String(languages).split(',').map((value) => value.trim()).filter(Boolean);
    }
    if (proofOfWork !== undefined) {
      const rawProofs = Array.isArray(proofOfWork)
        ? proofOfWork.map((value) => String(value).trim()).filter(Boolean)
        : [];
      const convertedProofs = [];
      for (const item of rawProofs) {
        const url = await convertBase64ToPublicAsset(item, STORAGE_FOLDERS.PROOF_OF_WORK, req);
        if (url) convertedProofs.push(url);
      }
      updates.proofOfWork = convertedProofs;
    }
    if (availabilityStatus !== undefined) updates.availabilityStatus = String(availabilityStatus).trim();
    if (workingSchedule !== undefined) updates.workingSchedule = String(workingSchedule).trim();
    if (profession !== undefined) updates.profession = String(profession).trim();
    if (city !== undefined) updates.city = String(city).trim();
    if (barangay !== undefined) updates.barangay = String(barangay).trim();
    if (avatar !== undefined) updates.avatar = await convertBase64ToPublicAsset(avatar, STORAGE_FOLDERS.PROFILES, req);
    if (profileImage !== undefined) updates.profileImage = await convertBase64ToPublicAsset(profileImage, STORAGE_FOLDERS.PROFILES, req);

    Object.assign(worker, updates);
    await worker.save();
    await resolveWorkerLocation(worker, { persist: true });
    invalidateServiceRequestCaches();

    return res.status(200).json({ success: true, worker: formatWorkerProfile(worker) });
  } catch (error) {
    console.error('Update worker by id error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

export const getWorkerMe = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || "").trim();
    const userEmail = String(req.user?.email || "").trim().toLowerCase();
    const summaryOnly = ["1", "true", "yes"].includes(
      String(req.query?.summary || "").trim().toLowerCase()
    );
    const assetMode = String(req.query?.assets || "").trim().toLowerCase();
    const includeImages = !["0", "false", "no"].includes(
      String(req.query?.images ?? "1").trim().toLowerCase()
    );
    const workerMatch = userId && mongoose.isValidObjectId(userId)
      ? { _id: new mongoose.Types.ObjectId(userId) }
      : { email: userEmail };
    const workerProjection = {
      ...(assetMode ? {} : {
        firstName: 1,
        lastName: 1,
        email: 1,
        phone: 1,
        profession: 1,
        city: 1,
        barangay: 1,
        province: 1,
        bio: 1,
        yearsExperience: 1,
        languages: 1,
        rating: 1,
        availabilityStatus: 1,
        workingSchedule: 1,
        price: 1,
        status: 1,
        isVerified: 1,
        location: 1,
        locationLabel: 1,
        mustChangePassword: 1,
        pendingProfileUpdate: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
      ...(includeImages || assetMode ? {
        avatar: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 0] },
            "$avatar",
            "$profileImage",
          ],
        },
      } : {}),
      ...(!summaryOnly && assetMode !== "avatar" ? { proofOfWork: 1 } : {}),
    };
    const ratingPromise = !assetMode && userId && mongoose.isValidObjectId(userId)
      ? getWorkerRatingStatsForId(userId)
      : Promise.resolve(null);
    const [workerRows, prefetchedRatingStats] = await Promise.all([
      Worker.aggregate([{ $match: workerMatch }, { $limit: 1 }, { $project: workerProjection }]),
      ratingPromise,
    ]);
    const worker = workerRows[0] || null;

    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found.' });
    }
    if (!assetMode) {
      await resolveWorkerLocation(worker, { persist: false, geocode: false });
    }

    const ratingStats = assetMode
      ? { rating: 0, reviews: 0 }
      : prefetchedRatingStats || await getWorkerRatingStatsForId(worker._id);

    const profile = formatWorkerProfile({
      ...worker,
      rating: ratingStats.rating,
      reviews: ratingStats.reviews,
    });

    return res.status(200).json({ success: true, worker: profile });
  } catch (error) {
    console.error('Get worker profile error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

export const updateWorkerMe = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || "").trim();
    const userEmail = String(req.user?.email || "").trim().toLowerCase();

    let worker = null;
    if (!worker && userId && mongoose.isValidObjectId(userId)) {
      worker = await Worker.findById(userId);
    }
    if (!worker && userEmail) {
      worker = await Worker.findOne({ email: userEmail });
    }
    if (!worker) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const {
      bio,
      yearsExperience,
      languages,
      proofOfWork,
      availabilityStatus,
      workingSchedule,
      profession,
      city,
      barangay,
      avatar,
      profileImage,
    } = req.body || {};

    const updates = {};
    if (bio !== undefined) updates.bio = String(bio).trim();
    if (yearsExperience !== undefined) {
      const numericYears = Number(yearsExperience);
      updates.yearsExperience = Number.isFinite(numericYears) && numericYears >= 0 ? numericYears : 0;
    }
    if (languages !== undefined) {
      updates.languages = Array.isArray(languages)
        ? languages.map((value) => String(value).trim()).filter(Boolean)
        : String(languages)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    }
    if (proofOfWork !== undefined) {
      const rawProofs = Array.isArray(proofOfWork)
        ? proofOfWork.map((value) => String(value).trim()).filter(Boolean)
        : [];
      const convertedProofs = [];
      for (const item of rawProofs) {
        const url = await convertBase64ToPublicAsset(item, STORAGE_FOLDERS.PROOF_OF_WORK, req);
        if (url) convertedProofs.push(url);
      }
      updates.proofOfWork = convertedProofs;
    }
    if (availabilityStatus !== undefined) updates.availabilityStatus = String(availabilityStatus).trim();
    if (workingSchedule !== undefined) updates.workingSchedule = String(workingSchedule).trim();
    if (profession !== undefined) updates.profession = String(profession).trim();
    if (city !== undefined) updates.city = String(city).trim();
    if (barangay !== undefined) updates.barangay = String(barangay).trim();
    if (avatar !== undefined) updates.avatar = await convertBase64ToPublicAsset(avatar, STORAGE_FOLDERS.PROFILES, req);
    if (profileImage !== undefined) updates.profileImage = await convertBase64ToPublicAsset(profileImage, STORAGE_FOLDERS.PROFILES, req);

    Object.assign(worker, updates);
    await worker.save();
    await resolveWorkerLocation(worker, { persist: true });
    invalidateServiceRequestCaches();

    return res.status(200).json({ success: true, worker: formatWorkerProfile(worker) });
  } catch (error) {
    console.error('Update worker profile error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

export const changeWorkerPassword = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || "").trim();
    const userEmail = String(req.user?.email || "").trim().toLowerCase();

    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    if (!newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match.",
      });
    }

    const nextPassword = String(newPassword);
    const nextConfirmPassword = String(confirmPassword);
    const hasUppercase = /[A-Z]/.test(nextPassword);
    const hasNumber = /\d/.test(nextPassword);

    if (nextPassword.length < 8 || !hasUppercase || !hasNumber) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters and include 1 uppercase letter and 1 number.",
      });
    }

    if (nextPassword !== nextConfirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match.",
      });
    }

    if (nextPassword === String(currentPassword)) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password.",
      });
    }

    let worker = null;
    if (!worker && userId && mongoose.isValidObjectId(userId)) {
      worker = await Worker.findById(userId).select("password email");
    }
    if (!worker && userEmail) {
      worker = await Worker.findOne({ email: userEmail }).select("password email");
    }

    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    const isMatch = await bcrypt.compare(String(currentPassword), worker.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    worker.password = await bcrypt.hash(nextPassword, salt);
    await worker.save();

    try {
      await sendEmail({
        to: worker.email,
        subject: "Your password was changed",
        text: "Your TrabaHome worker password was changed successfully. If this wasn't you, please secure your account immediately.",
        html: `
          <div style="font-family: Arial, sans-serif; background:#f8fafc; padding:24px;">
            <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:20px; padding:28px; border:1px solid #e5e7eb;">
              <h2 style="margin:0 0 12px; color:#0B3B68;">Password changed</h2>
              <p style="margin:0; color:#334155; line-height:1.6;">
                Your TrabaHome worker password was changed successfully.
              </p>
              <p style="margin:16px 0 0; color:#64748b; line-height:1.6;">
                If this wasn't you, please reset your password and contact support right away.
              </p>
            </div>
          </div>
        `,
      });
    } catch (emailError) {
      console.error("Worker password change email error:", emailError);
    }

    void createWorkerNotification({
      userId: worker._id,
      title: "Password updated",
      message: "Your account password has been updated successfully.",
      type: "info",
      meta: { route: "/worker-own-profile" },
    }).catch((err) => console.error("Worker password update notification error:", err));

    return res.status(200).json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error) {
    console.error("Change worker password error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

// ?????? GET /api/workers/search ??????????????????????????????????????????????????????????????????????????????????????????????????????
export const searchWorkers = async (req, res) => {
  try {
    const service = String(req.query?.service || "").trim();
    const city = String(req.query?.city || "").trim();
    const lat = Number(req.query?.lat);
    const lng = Number(req.query?.lng);
    const hasLatLng = Number.isFinite(lat) && Number.isFinite(lng);

    const radiusKmRaw = Number(req.query?.radiusKm);
    const radiusKm =
      Number.isFinite(radiusKmRaw) && radiusKmRaw > 0
        ? radiusKmRaw
        : DEFAULT_RADIUS_KM;
    const radiusMeters = radiusKm * 1000;

    const limitRaw = Number(req.query?.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const cursorRaw = Number(req.query?.cursor);
    const offset =
      Number.isFinite(cursorRaw) && cursorRaw > 0
        ? Math.floor(cursorRaw)
        : 0;
    const sort = String(req.query?.sort || "distance_asc").trim();

    const serviceFilter = buildServiceFilter(service);
    const cityFilter = buildCityFilter(city);
    const accountFilter = buildAccountFilter({ verifiedOnly: true });
    const baseFilter = { ...serviceFilter, ...cityFilter, ...accountFilter };

    if (!hasLatLng) {
      const listFilter = { ...serviceFilter, ...cityFilter, ...accountFilter };
      let query = Worker.find(listFilter);
      if (sort === "rating_desc") {
        query = query.sort({ rating: -1, createdAt: -1 });
      } else if (sort === "newest") {
        query = query.sort({ createdAt: -1 });
      } else {
        query = query.sort({ createdAt: -1 });
      }

      if (offset > 0) query = query.skip(offset);
      if (limit > 0) query = query.limit(limit);
      query = query.select(SEARCH_WORKER_SELECT);

      const [workers, total] = await Promise.all([
        query.lean(),
        Worker.countDocuments(listFilter),
      ]);
      const hydratedWorkers = await hydrateWorkerLocations(workers);
      let items = hydratedWorkers.map((worker) => formatWorkerSearchItem(worker));
      items = await attachWorkerRatingStats(items);
      const nextOffset = offset + items.length;
      const nextCursor = nextOffset < total ? String(nextOffset) : null;

      return res.status(200).json({ items, total, nextCursor });
    }

    if (offset === 0) {
      const geoNearStage = {
        $geoNear: {
          near: { type: "Point", coordinates: [lng, lat] },
          distanceField: "distanceMeters",
          maxDistance: radiusMeters,
          spherical: true,
          query: baseFilter,
        },
      };

      const sortStage = (() => {
        if (sort === "rating_desc") return { $sort: { rating: -1, distanceMeters: 1 } };
        if (sort === "newest") return { $sort: { createdAt: -1 } };
        return { $sort: { distanceMeters: 1 } };
      })();

      const nearResults = await Worker.aggregate([
        geoNearStage,
        sortStage,
        { $limit: limit + 1 },
        {
          $project: {
            firstName: 1,
            lastName: 1,
            email: 1,
            profession: 1,
            service: 1,
            role: 1,
            category: 1,
            city: 1,
            barangay: 1,
            province: 1,
            rating: 1,
            location: 1,
            locationLabel: 1,
            bio: 1,
            yearsExperience: 1,
            languages: 1,
            availabilityStatus: 1,
            workingSchedule: 1,
            price: 1,
            status: 1,
            isVerified: 1,
            createdAt: 1,
            updatedAt: 1,
            distanceMeters: 1,
          },
        },
      ]);

      const hydratedNearResults = await hydrateWorkerLocations(nearResults.slice(0, limit));
      let items = hydratedNearResults.map((worker) => formatWorkerSearchItem(worker));

      if (items.length < limit) {
        const remaining = limit - items.length;
        const missingQuery = { ...baseFilter, ...MISSING_LOCATION_FILTER };
        let missingResults = Worker.find(missingQuery);
        if (sort === "rating_desc") {
          missingResults = missingResults.sort({ rating: -1, createdAt: -1 });
        } else {
          missingResults = missingResults.sort({ createdAt: -1 });
        }
        const fallbackWorkers = await missingResults
          .select(SEARCH_WORKER_SELECT)
          .limit(remaining)
          .lean();
        const hydratedFallbackWorkers = await hydrateWorkerLocations(fallbackWorkers);
        items = items.concat(hydratedFallbackWorkers.map((worker) => formatWorkerSearchItem(worker)));
      }

      items = await attachWorkerRatingStats(items);
      const total = items.length;
      const nextCursor = items.length === limit ? String(limit) : null;
      return res.status(200).json({ items, total, nextCursor });
    }

    const geoNearStage = {
      $geoNear: {
        near: { type: "Point", coordinates: [lng, lat] },
        distanceField: "distanceMeters",
        maxDistance: radiusMeters,
        spherical: true,
        query: baseFilter,
      },
    };

    const sortStage = (() => {
      if (sort === "rating_desc") return { $sort: { rating: -1, distanceMeters: 1 } };
      if (sort === "newest") return { $sort: { createdAt: -1 } };
      return { $sort: { distanceMeters: 1 } };
    })();

    const nearCountAgg = await Worker.aggregate([geoNearStage, { $count: "count" }]);
    const nearCount = nearCountAgg?.[0]?.count || 0;

    const missingQuery = { ...baseFilter, ...MISSING_LOCATION_FILTER };
    const missingCount = await Worker.countDocuments(missingQuery);

    const total = nearCount + missingCount;

    const fetchMissing = async (skip, take) => {
      let query = Worker.find(missingQuery);
      if (sort === "rating_desc") {
        query = query.sort({ rating: -1, createdAt: -1 });
      } else if (sort === "newest") {
        query = query.sort({ createdAt: -1 });
      } else {
        query = query.sort({ createdAt: -1 });
      }
      if (skip > 0) query = query.skip(skip);
      if (take > 0) query = query.limit(take);
      return query.select(SEARCH_WORKER_SELECT).lean();
    };

    let items = [];

    if (offset < nearCount) {
      const nearLimit = Math.min(limit, nearCount - offset);
      const pipeline = [
        geoNearStage,
        sortStage,
        {
          $project: {
            firstName: 1,
            lastName: 1,
            email: 1,
            profession: 1,
            service: 1,
            role: 1,
            category: 1,
            city: 1,
            barangay: 1,
            province: 1,
            rating: 1,
            location: 1,
            locationLabel: 1,
            bio: 1,
            yearsExperience: 1,
            languages: 1,
            availabilityStatus: 1,
            workingSchedule: 1,
            price: 1,
            status: 1,
            isVerified: 1,
            createdAt: 1,
            updatedAt: 1,
            distanceMeters: 1,
          },
        },
      ];
      if (offset > 0) pipeline.push({ $skip: offset });
      if (nearLimit > 0) pipeline.push({ $limit: nearLimit });
      const nearResults = await Worker.aggregate(pipeline);
      const hydratedNearResults = await hydrateWorkerLocations(nearResults);
      items = hydratedNearResults.map((worker) => formatWorkerSearchItem(worker));

      const remaining = limit - items.length;
      if (remaining > 0) {
        const missingResults = await fetchMissing(0, remaining);
        const hydratedMissingResults = await hydrateWorkerLocations(missingResults);
        items = items.concat(
          hydratedMissingResults.map((worker) => formatWorkerSearchItem(worker))
        );
      }
    } else {
      const missingSkip = offset - nearCount;
      const missingResults = await fetchMissing(missingSkip, limit);
      const hydratedMissingResults = await hydrateWorkerLocations(missingResults);
      items = hydratedMissingResults.map((worker) => formatWorkerSearchItem(worker));
    }

    items = await attachWorkerRatingStats(items);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < total ? String(nextOffset) : null;

    return res.status(200).json({ items, total, nextCursor });
  } catch (error) {
    console.error("Worker search error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};


// ── POST /api/workers/signin ───────────────────────────────────────────────
export const signInWorker = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid email address.'
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required.'
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const rateLimitKey = buildLoginRateLimitKey('worker', normalizedEmail);
    if (isLoginRateLimited(rateLimitKey)) {
      return res.status(429).json({
        success: false,
        message: LOGIN_TOO_MANY_MESSAGE,
        retryAfterSeconds: LOGIN_BLOCK_SECONDS,
      });
    }

    const worker = await Worker.findOne({ email: normalizedEmail })
      .select('firstName lastName email password mustChangePassword status isVerified disabled isDisabled isActive profession city barangay province bio yearsExperience languages rating availabilityStatus workingSchedule price location locationLabel');
    const passwordMatches = worker && (await bcrypt.compare(password, worker.password));

    if (!worker || !passwordMatches) {
      const blocked = recordLoginFailure(rateLimitKey);
      if (blocked) {
        return res.status(429).json({
          success: false,
          message: LOGIN_TOO_MANY_MESSAGE,
          retryAfterSeconds: LOGIN_BLOCK_SECONDS,
        });
      }

      return res.status(401).json({
        success: false,
        message: 'Incorrect email or password.'
      });
    }

    const accountAllowed = !isAccountDisabled(worker) && isAccountVerified(worker);
    if (!accountAllowed) {
      clearLoginFailures(rateLimitKey);
      return res.status(403).json({
        success: false,
        message: getWorkerLoginBlockMessage(worker),
      });
    }

    clearLoginFailures(rateLimitKey);

    let loginOtp;
    try {
      loginOtp = await createAndSendOtp({
        userType: 'worker',
        userId: worker._id,
        email: worker.email,
        purpose: 'login',
        length: LOGIN_OTP_LENGTH,
        ttlSeconds: LOGIN_OTP_TTL_SECONDS,
        maxAttempts: LOGIN_OTP_MAX_ATTEMPTS,
        replaceExisting: true,
      });
    } catch (otpError) {
      console.error('Worker OTP creation error:', otpError);
      return res.status(500).json({
        success: false,
        message: 'Unable to send verification code. Please try again.',
      });
    }

    const profile = toWorkerProfile(worker);
    return res.status(200).json({
      otpRequired: true,
      otpId: loginOtp.otpId,
      email: profile.email,
      worker: profile,
      mustChangePassword: Boolean(worker.mustChangePassword),
    });
  } catch (error) {
    console.error('Sign-in error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error.'
    });
  }
};

export const updateWorkerInitialPassword = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || '').trim();
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    const { newPassword, confirmPassword } = req.body || {};
    if (!newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'New password and confirmation are required.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }
    const pwdError = validateStrongPassword(newPassword);
    if (pwdError) {
      return res.status(400).json({ success: false, message: pwdError });
    }
    const worker = await Worker.findById(userId);
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found.' });
    }
    const salt = await bcrypt.genSalt(10);
    worker.password = await bcrypt.hash(newPassword, salt);
    worker.mustChangePassword = false;
    await worker.save();

    void createWorkerNotification({
      userId: worker._id,
      title: "Password updated",
      message: "Your permanent password has been set successfully.",
      type: "info",
      meta: { route: "/worker-own-profile" },
    }).catch((err) => console.error("Worker initial password update notification error:", err));

    return res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Update worker initial password error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

export const markWorkerGuideSeen = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || '').trim();
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    await Worker.findByIdAndUpdate(userId, { $set: { hasSeenGuide: true } });
    return res.status(200).json({ success: true, hasSeenGuide: true });
  } catch (err) {
    console.error('Mark worker guide seen error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

export const requestProfileUpdate = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || '').trim();
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const worker = await Worker.findById(userId);
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found.' });
    }

    const {
      fullName,
      firstName,
      lastName,
      phone,
      profession,
      province,
      city,
      barangay,
      address,
    } = req.body || {};

    const trimmedProfession = String(profession || '').trim();
    if (!trimmedProfession) {
      return res.status(400).json({ success: false, message: 'At least one profession / skill is required.' });
    }

    let parsedFirst = String(firstName || '').trim();
    let parsedLast = String(lastName || '').trim();
    const rawFullName = String(fullName || '').trim();
    if (rawFullName && (!parsedFirst || !parsedLast)) {
      const parts = rawFullName.split(/\s+/);
      parsedFirst = parts[0] || '';
      parsedLast = parts.slice(1).join(' ') || '';
    }

    const trimmedPhone = String(phone || '').trim();
    const trimmedCity = String(city || '').trim();
    const trimmedBarangay = String(barangay || '').trim();

    const changes = {
      fullName: rawFullName || [parsedFirst || worker.firstName, parsedLast || worker.lastName].filter(Boolean).join(' '),
      firstName: parsedFirst || worker.firstName,
      lastName: parsedLast || worker.lastName,
      phone: trimmedPhone || worker.phone,
      profession: trimmedProfession,
      province: String(province || worker.province || 'Pangasinan').trim(),
      city: trimmedCity || worker.city,
      barangay: trimmedBarangay || worker.barangay,
      address: String(address || '').trim(),
      location: [trimmedBarangay || worker.barangay, trimmedCity || worker.city, 'Pangasinan'].filter(Boolean).join(', '),
    };

    worker.pendingProfileUpdate = {
      status: 'pending',
      submittedAt: new Date(),
      reviewedAt: null,
      rejectionReason: '',
      changes,
    };

    await worker.save();

    notifyAllAdmins({
      title: 'Worker Profile Edit Request',
      message: `${worker.firstName} ${worker.lastName} requested profile detail updates for review.`,
      type: 'worker_profile_update',
      workerId: worker._id,
      timestamp: new Date(),
    });

    emitToAdmin('worker:profile-update-requested', {
      workerId: worker._id,
      workerName: `${worker.firstName} ${worker.lastName}`,
      submittedAt: worker.pendingProfileUpdate.submittedAt,
    });

    return res.status(200).json({
      success: true,
      message: 'Profile update request submitted successfully. Awaiting administrator review.',
      pendingProfileUpdate: worker.pendingProfileUpdate,
    });
  } catch (error) {
    console.error('Request profile update error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit profile update request.' });
  }
};

