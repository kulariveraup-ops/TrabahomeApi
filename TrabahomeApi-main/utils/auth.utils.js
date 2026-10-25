import crypto from "crypto";
import { Types } from "mongoose";
import Worker from "../models/worker.Model.js";
import HomeOwner from "../models/homeOwner.Model.js";
import Admin from "../models/admin.Model.js";

export const normalizeEmail = (email) =>
  String(email || "").trim().toLowerCase();

export const isValidEmail = (email) => {
  const value = String(email || "").trim();
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

const buildExcludeQuery = (excludeId) => {
  if (!excludeId) return null;
  const ids = [excludeId];
  if (Types.ObjectId.isValid(String(excludeId))) {
    ids.push(new Types.ObjectId(String(excludeId)));
  }
  return { $nin: ids };
};

export const isHomeownerEmailTaken = async (email, excludeId = null) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  const escaped = normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const query = {
    $or: [
      { email: normalizedEmail },
      { email: new RegExp(`^${escaped}$`, "i") },
    ],
  };
  const excludeFilter = buildExcludeQuery(excludeId);
  if (excludeFilter) query._id = excludeFilter;
  const existing = await HomeOwner.findOne(query).select("_id").lean();
  return Boolean(existing);
};

export const isWorkerEmailTaken = async (email, excludeId = null) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  const escaped = normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const query = {
    $or: [
      { email: normalizedEmail },
      { email: new RegExp(`^${escaped}$`, "i") },
    ],
  };
  const excludeFilter = buildExcludeQuery(excludeId);
  if (excludeFilter) query._id = excludeFilter;
  const existing = await Worker.findOne(query).select("_id").lean();
  return Boolean(existing);
};

export const isAdminEmailTaken = async (email, excludeId = null) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  const escaped = normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const query = {
    $or: [
      { email: normalizedEmail },
      { email: new RegExp(`^${escaped}$`, "i") },
    ],
  };
  const excludeFilter = buildExcludeQuery(excludeId);
  if (excludeFilter) query._id = excludeFilter;
  const existing = await Admin.findOne(query).select("_id").lean();
  return Boolean(existing);
};

export const isEmailTakenAcrossSystem = async (email, excludeId = null, role = null) => {
  if (role === "homeowner") return isHomeownerEmailTaken(email, excludeId);
  if (role === "worker") return isWorkerEmailTaken(email, excludeId);
  if (role === "admin") return isAdminEmailTaken(email, excludeId);

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;

  const escaped = normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const query = {
    $or: [
      { email: normalizedEmail },
      { email: new RegExp(`^${escaped}$`, "i") },
    ],
  };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const [worker, homeowner, admin] = await Promise.all([
    Worker.findOne(query).select("_id").lean(),
    HomeOwner.findOne(query).select("_id").lean(),
    Admin.findOne(query).select("_id").lean(),
  ]);

  return Boolean(worker || homeowner || admin);
};

export const generateSecureTemporaryPassword = () => {
  const lowers = "abcdefghjkmnpqrstuvwxyz";
  const uppers = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const specials = "!@#$%&*";

  const pick = (chars) => chars[crypto.randomInt(0, chars.length)];
  const result = [
    pick(uppers),
    pick(lowers),
    pick(digits),
    pick(specials),
    pick(uppers),
    pick(lowers),
    pick(digits),
    pick(specials),
    pick(lowers),
    pick(digits),
  ];

  return result.sort(() => Math.random() - 0.5).join("");
};

export const validateStrongPassword = (password) => {
  const pwd = String(password || "");
  if (pwd.length < 8 || pwd.length > 24) {
    return "Password must be between 8 and 24 characters.";
  }
  if (/\s/.test(pwd)) {
    return "Password must not contain spaces.";
  }
  if (
    !/[A-Z]/.test(pwd) ||
    !/[a-z]/.test(pwd) ||
    !/[0-9]/.test(pwd) ||
    !/[!@#$%^*()\-_+=?]/.test(pwd)
  ) {
    return "Password must contain uppercase, lowercase, number, and a special character (!@#$%^*()-_+=?).";
  }
  if (/(.)\1{2,}/.test(pwd)) {
    return "Password must not contain repetitive characters.";
  }
  const lowerPwd = pwd.toLowerCase();
  const commonPatterns = [
    "password",
    "password123",
    "qwerty",
    "12345678",
    "123456789",
    "admin",
    "welcome",
    "letmein",
    "pass123",
    "trabahome",
  ];
  for (const pat of commonPatterns) {
    if (lowerPwd.includes(pat)) {
      return "Password is too common or easily guessable.";
    }
  }
  return null;
};

export const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).trim();
  }
  return String(req.ip || req.connection?.remoteAddress || "");
};

export const isAccountDisabled = (user) => {
  if (!user) return true;
  if (user.disabled === true) return true;
  if (user.isDisabled === true) return true;
  if (user.isActive === false) return true;
  if (typeof user.status === "string") {
    const status = user.status.toLowerCase();
    if (status === "disabled" || status === "inactive" || status === "suspended") return true;
  }
  return false;
};

export const isAccountVerified = (user) => {
  if (!user) return false;
  if (String(user.status || "").trim().toLowerCase() === "verified") return true;
  if (user.isVerified === false) return false;
  return true;
};

const safeString = (value) => (value ? String(value) : "");
const safeArray = (value) => (Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []);

export const toHomeownerProfile = (user) => ({
  id: user?._id ? String(user._id) : "",
  firstName: safeString(user?.firstName),
  lastName: safeString(user?.lastName),
  email: safeString(user?.email),
  avatar: safeString(user?.avatar || user?.profileImage || user?.profilePicture),
  profileImage: safeString(user?.profileImage || user?.avatar || user?.profilePicture),
  profilePicture: safeString(user?.profilePicture || user?.profileImage || user?.avatar),
  hasSeenGuide: Boolean(user?.hasSeenGuide),
});

export const toWorkerProfile = (user) => {
  const isVerified = Boolean(
    user?.isVerified === true ||
    String(user?.status || "").trim().toLowerCase() === "verified"
  );
  const status = safeString(
    user?.status || (isVerified ? "Verified" : "Pending")
  );

  return {
    id: user?._id ? String(user._id) : "",
    firstName: safeString(user?.firstName),
    lastName: safeString(user?.lastName),
    email: safeString(user?.email),
    avatar: safeString(user?.avatar || user?.profileImage || user?.photoUrl || user?.image || user?.photo || user?.picture),
    profileImage: safeString(user?.profileImage || user?.avatar || user?.photoUrl || user?.image || user?.photo || user?.picture),
    photoUrl: safeString(user?.photoUrl || user?.image || user?.photo || user?.picture || user?.avatar || user?.profileImage),
    image: safeString(user?.image || user?.photoUrl || user?.photo || user?.picture || user?.avatar || user?.profileImage),
    photo: safeString(user?.photo || user?.image || user?.photoUrl || user?.picture || user?.avatar || user?.profileImage),
    picture: safeString(user?.picture || user?.photo || user?.image || user?.photoUrl || user?.avatar || user?.profileImage),
    fullName: [safeString(user?.firstName), safeString(user?.lastName)].filter(Boolean).join(" "),
    profession: safeString(user?.profession),
    city: safeString(user?.city),
    barangay: safeString(user?.barangay),
    location: [safeString(user?.barangay), safeString(user?.city)].filter(Boolean).join(", "),
    bio: safeString(user?.bio),
    yearsExperience: Number.isFinite(Number(user?.yearsExperience)) ? Number(user.yearsExperience) : 0,
    languages: safeArray(user?.languages),
    proofOfWork: safeArray(user?.proofOfWork),
    rating: Number.isFinite(Number(user?.rating)) ? Number(user.rating) : 0,
    availabilityStatus: safeString(user?.availabilityStatus),
    workingSchedule: safeString(user?.workingSchedule),
    status,
    isVerified,
    hasSeenGuide: Boolean(user?.hasSeenGuide),
  };
};
