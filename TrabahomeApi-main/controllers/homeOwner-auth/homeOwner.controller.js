import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Types, isValidObjectId } from "mongoose";
import HomeOwner from "../../models/homeOwner.Model.js";
import ServiceRequest from "../../models/serviceRequest.Model.js";
import Worker from "../../models/worker.Model.js";
import Otp from "../../models/otp.Model.js";
import { createAndSendOtp, hashOtp } from "../../services/otp.service.js";
import { createHomeownerNotification } from "../../services/notification.service.js";
import { notifyAllAdmins } from "../../services/notify.js";
import { emitToAdmin, emitToAll } from "../../services/socket.js";
import { sendEmail } from "../../services/email.service.js";
import {
  isAccountDisabled,
  isAccountVerified,
  isValidEmail,
  normalizeEmail,
  toHomeownerProfile,
  isHomeownerEmailTaken,
  validateStrongPassword,
} from "../../utils/auth.utils.js";
import {
  buildLoginRateLimitKey,
  clearLoginFailures,
  getLoginRateLimitConfig,
  isLoginRateLimited,
  recordLoginFailure,
} from "../../services/loginRateLimit.service.js";
import {
  LOGIN_OTP_LENGTH,
  LOGIN_OTP_MAX_ATTEMPTS,
  LOGIN_OTP_TTL_SECONDS,
} from "../../services/loginOtpPolicy.js";
import {
  convertBase64ToPublicAsset,
  STORAGE_FOLDERS,
} from "../../services/cloudStorage.service.js";

const { blockSeconds: LOGIN_BLOCK_SECONDS } = getLoginRateLimitConfig();
const LOGIN_TOO_MANY_MESSAGE = `Too many attempts. Try again in ${Math.max(1, Math.ceil(LOGIN_BLOCK_SECONDS / 60))} minute${Math.ceil(LOGIN_BLOCK_SECONDS / 60) === 1 ? "" : "s"}.`;

const getHomeownerLoginBlockMessage = (user) => {
  const status = String(user?.status || "").trim().toLowerCase();
  if (status === "suspended" || status === "disabled" || status === "inactive") {
    return "Your homeowner account is suspended. Please contact support to restore access.";
  }
  if (status === "rejected") {
    return "Your homeowner account has been rejected. Please contact support.";
  }
  return "Your homeowner account is waiting for verification. Please try again after approval.";
};

// normalize PH mobile number → 09XXXXXXXXX
const normalizePhilippineMobile = (value) => {
  if (!value) return null;
  let raw = String(value).trim().replace(/[()\-\s]/g, "");

  if (raw.startsWith("+63")) raw = "0" + raw.slice(3);
  else if (raw.startsWith("63")) raw = "0" + raw.slice(2);

  if (raw.startsWith("+63")) raw = "0" + raw.slice(3);
  else if (raw.startsWith("63")) raw = "0" + raw.slice(2);
  else if (raw.startsWith("9")) raw = "0" + raw;

  return /^09\d{9}$/.test(raw) ? raw : null;
};

//
// ───────────────── CHECK EMAIL AVAILABILITY ─────────
// GET or POST /api/homeowners/check-email
//
export const checkHomeownerEmailAvailability = async (req, res) => {
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

    const isTaken = await isHomeownerEmailTaken(normalizedEmail);
    if (isTaken) {
      return res.status(200).json({
        success: true,
        available: false,
        message: "This email is already registered as a homeowner.",
      });
    }

    return res.status(200).json({
      success: true,
      available: true,
      message: "Email is available.",
    });
  } catch (error) {
    console.error("Check homeowner email availability error:", error);
    return res.status(500).json({
      success: false,
      available: false,
      message: "Unable to check email availability. Please try again.",
    });
  }
};

//
// ───────────────── REQUEST REGISTRATION OTP ─────────
// POST /api/homeowners/register/send-otp
//
export const requestHomeownerRegistrationOtp = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      mobileNumber,
      phone,
    } = req.body || {};

    const submittedPhone = mobileNumber || phone;
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhilippineMobile(submittedPhone);

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address with a recognized domain.",
      });
    }

    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 11-digit Philippine mobile number (09XXXXXXXXX).",
      });
    }

    // Name validations if provided
    if (firstName) {
      const cleanFirst = String(firstName).trim();
      if (!/^[a-zA-ZñÑ]+(\s[a-zA-ZñÑ]+)*$/.test(cleanFirst) || cleanFirst.length < 2 || cleanFirst.length > 24) {
        return res.status(400).json({
          success: false,
          message: "First name must contain only letters and single spaces between words (2-24 characters).",
        });
      }
    }

    if (lastName) {
      const cleanLast = String(lastName).trim();
      if (!/^[a-zA-ZñÑ]+(\s[a-zA-ZñÑ]+)*$/.test(cleanLast) || cleanLast.length < 2 || cleanLast.length > 24) {
        return res.status(400).json({
          success: false,
          message: "Last name must contain only letters and single spaces between words (2-24 characters).",
        });
      }
    }

    // Check if email is already registered as a homeowner. Phone numbers can be reused.
    const emailConflict = await isHomeownerEmailTaken(normalizedEmail);
    if (emailConflict) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered as a homeowner.",
      });
    }

    // Generate and send OTP via email
    const otpResult = await createAndSendOtp({
      userType: "homeowner",
      email: normalizedEmail,
      purpose: "registration",
      length: 6,
      ttlSeconds: 600, // 10 minutes
      replaceExisting: true,
    });

    return res.status(200).json({
      success: true,
      message: `A verification code has been sent to ${normalizedEmail}.`,
      otpId: otpResult.otpId,
      expiresAt: otpResult.expiresAt,
    });
  } catch (error) {
    console.error("Homeowner registration OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to send verification code. Please try again.",
      error: error.message,
    });
  }
};

//
// ───────────────── REGISTER HOMEOWNER ─────────────────
// POST /api/homeowners/register
//
export const registerHomeOwner = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      mobileNumber,   // from React form
      phone,
      password,
      agreeTerms,
      agreePrivacy,
      agreeToTerms,
      agreeToPrivacy,
      city,
      barangay,
      province,
      address,
      code,
      otpCode,
      otpId,
    } = req.body || {};

    const cleanFirst = String(firstName || "").trim();
    const cleanLast = String(lastName || "").trim();
    const submittedPhone = mobileNumber || phone;
    const submittedCode = String(code || otpCode || "").trim();

    // 1. Required field check (Address is optional)
    if (!cleanFirst || !cleanLast || !email || !submittedPhone || !password || !city || !barangay) {
      return res.status(400).json({
        success: false,
        message: "Please fill in all required fields.",
      });
    }

    const hasAgreed = Boolean(
      (agreeTerms || agreeToTerms) && (agreePrivacy || agreeToPrivacy)
    );
    if (!hasAgreed) {
      return res.status(400).json({
        success: false,
        message: "You must agree to the Terms & Conditions and Privacy Policy.",
      });
    }

    // 2. Name validation: letters and space only, 2-24 chars, single space between words
    const nameRegex = /^[a-zA-ZñÑ]+(\s[a-zA-ZñÑ]+)*$/;
    if (!nameRegex.test(cleanFirst) || cleanFirst.length < 2 || cleanFirst.length > 24) {
      return res.status(400).json({
        success: false,
        message: "First name must contain only letters and single spaces between words (2-24 characters).",
      });
    }
    if (!nameRegex.test(cleanLast) || cleanLast.length < 2 || cleanLast.length > 24) {
      return res.status(400).json({
        success: false,
        message: "Last name must contain only letters and single spaces between words (2-24 characters).",
      });
    }

    // 3. Email & Phone validation
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhilippineMobile(submittedPhone);

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address with a recognized domain.",
      });
    }

    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 11-digit Philippine mobile number (09XXXXXXXXX).",
      });
    }

    // 4. Password validation (worker-signup logic)
    if (password.length < 8 || password.length > 24) {
      return res.status(400).json({
        success: false,
        message: "Password must be between 8 and 24 characters.",
      });
    }
    if (/\s/.test(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must not contain spaces.",
      });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[!@#$%^*()\-_+=?]/.test(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must contain uppercase, lowercase, number, and a special character (!@#$%^*()-_+=?).",
      });
    }
    if (/(.)\1{2,}/.test(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must not contain repetitive characters.",
      });
    }
    const lowerPwd = password.toLowerCase();
    const commonGuessablePatterns = ['password', 'password123', 'qwerty', '12345678', '123456789', 'admin', 'welcome', 'letmein', 'pass123', 'trabahome'];
    for (const pat of commonGuessablePatterns) {
      if (lowerPwd.includes(pat)) {
        return res.status(400).json({
          success: false,
          message: "Password is too common or easily guessable.",
        });
      }
    }

    // 5. Uniqueness check for homeowner
    const emailConflict = await isHomeownerEmailTaken(normalizedEmail);
    if (emailConflict) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered as a homeowner.",
      });
    }

    // 6. Registration OTP verification (must input code before account creation)
    if (!submittedCode) {
      return res.status(400).json({
        success: false,
        message: "Verification code is required to complete registration.",
      });
    }

    const codeHash = hashOtp(submittedCode);
    const otpQuery = {
      userType: "homeowner",
      email: normalizedEmail,
      purpose: "registration",
      usedAt: null,
    };
    if (otpId && isValidObjectId(otpId)) {
      otpQuery._id = otpId;
    }

    const otp = await Otp.findOne(otpQuery).sort({ createdAt: -1 });
    if (!otp) {
      return res.status(400).json({
        success: false,
        message: "No active verification code found for this email. Please request a new code.",
      });
    }

    if (new Date() > otp.expiresAt) {
      return res.status(400).json({
        success: false,
        message: "Verification code has expired. Please request a new code.",
      });
    }

    if (otp.attempts >= otp.maxAttempts) {
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Please request a new verification code.",
      });
    }

    if (otp.codeHash !== codeHash) {
      otp.attempts += 1;
      await otp.save();
      const remainingAttempts = Math.max(0, otp.maxAttempts - otp.attempts);
      return res.status(400).json({
        success: false,
        message: remainingAttempts > 0
          ? `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`
          : "Invalid verification code. Please request a new code.",
      });
    }

    // Mark OTP as used
    otp.usedAt = new Date();
    await otp.save();

    // 7. Hash password and create HomeOwner record
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newHomeOwner = await HomeOwner.create({
      firstName: cleanFirst,
      lastName: cleanLast,
      email: normalizedEmail,
      phone: normalizedPhone,
      password: hashedPassword,
      agreeToTerms: true,
      agreeToPrivacy: true,
      city: String(city).trim(),
      barangay: String(barangay).trim(),
      province: "Pangasinan",
      address: address ? String(address).trim() : "",
      status: "Verified",
      isVerified: true,
    });

    const { password: _, ...userData } = newHomeOwner.toObject();

    try {
      await createHomeownerNotification({
        userId: newHomeOwner._id,
        title: "Welcome to TrabaHome",
        message: "Welcome to TrabaHome! Your homeowner account has been verified and created successfully.",
        type: "success",
        meta: { kind: "welcome" },
      });
    } catch (notifyError) {
      console.error("Welcome notification error:", notifyError);
    }

    void notifyAllAdmins({
      title: "New homeowner registered",
      message: `${cleanFirst} ${cleanLast} registered as a homeowner.`,
      type: "info",
      meta: {
        route: `/admin-homeowners?homeownerId=${encodeURIComponent(String(newHomeOwner._id))}`,
        homeownerId: String(newHomeOwner._id),
        homeownerName: `${cleanFirst} ${cleanLast}`,
        actorId: String(newHomeOwner._id),
        actorRole: "homeowner",
        actorName: `${cleanFirst} ${cleanLast}`,
      },
    }).catch((err) => console.error("Admin homeowner notification error:", err));

    const homeownerSocketData = {
      id: String(newHomeOwner._id),
      firstName: newHomeOwner.firstName,
      lastName: newHomeOwner.lastName,
      name: `${newHomeOwner.firstName} ${newHomeOwner.lastName}`,
      email: newHomeOwner.email,
      phone: newHomeOwner.phone,
      city: newHomeOwner.city,
      barangay: newHomeOwner.barangay,
      status: newHomeOwner.status,
      createdAt: newHomeOwner.createdAt,
    };
    emitToAdmin("homeowner:registered", homeownerSocketData);
    emitToAll("homeowner:registered", homeownerSocketData);
    emitToAdmin("dashboard:refresh", { source: "homeowner:registered" });
    emitToAll("dashboard:refresh", { source: "homeowner:registered" });

    const token = jwt.sign(
      { id: String(newHomeOwner._id), email: newHomeOwner.email, role: "homeowner" },
      process.env.JWT_SECRET || "change-this-secret",
      { expiresIn: "1d" }
    );

    return res.status(201).json({
      success: true,
      message: "Account created successfully!",
      token,
      email: newHomeOwner.email,
      homeowner: toHomeownerProfile(newHomeOwner),
      data: userData,
    });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern || {})[0];
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }
    console.error("Register error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

//
// ───────────────── LOGIN HOMEOWNER ─────────────────
// POST /api/homeowners/login
//
export const loginHomeOwner = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address.",
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required.",
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const rateLimitKey = buildLoginRateLimitKey("homeowner", normalizedEmail);
    if (isLoginRateLimited(rateLimitKey)) {
      return res.status(429).json({
        success: false,
        message: LOGIN_TOO_MANY_MESSAGE,
        retryAfterSeconds: LOGIN_BLOCK_SECONDS,
      });
    }

    const user = await HomeOwner.findOne({ email: normalizedEmail });
    const passwordMatches = user && (await bcrypt.compare(password, user.password));

    if (!user || !passwordMatches) {
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
        message: "Incorrect email or password.",
      });
    }

    const accountAllowed = !isAccountDisabled(user) && isAccountVerified(user);
    if (!accountAllowed) {
      clearLoginFailures(rateLimitKey);
      return res.status(403).json({
        success: false,
        message: getHomeownerLoginBlockMessage(user),
      });
    }

    clearLoginFailures(rateLimitKey);

    let loginOtp;
    try {
      loginOtp = await createAndSendOtp({
        userType: "homeowner",
        userId: user._id,
        email: user.email,
        purpose: "login",
        length: LOGIN_OTP_LENGTH,
        ttlSeconds: LOGIN_OTP_TTL_SECONDS,
        maxAttempts: LOGIN_OTP_MAX_ATTEMPTS,
        replaceExisting: true,
      });
    } catch (otpError) {
      console.error("Homeowner OTP creation error:", otpError);
      return res.status(500).json({
        success: false,
        message: "Unable to send verification code. Please try again.",
      });
    }

    const profile = toHomeownerProfile(user);
    console.info("[HOMEOWNER_LOGIN_OTP] signin issued", {
      otpId: loginOtp.otpId,
      role: "homeowner",
      purpose: "login",
      expiresAt: loginOtp.expiresAt,
      used: false,
    });
    return res.status(200).json({
      otpRequired: true,
      otpId: loginOtp.otpId,
      email: profile.email,
      homeowner: profile,
      mustChangePassword: Boolean(user.mustChangePassword),
    });

  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

const getJwtSecret = () => process.env.JWT_SECRET || "change-this-secret";
const HOMEOWNER_ME_CACHE_TTL_MS = 30_000;
const homeownerMeCache = new Map();
const HOMEOWNER_SHARED_PROFILE_CACHE_TTL_MS = 30_000;
const homeownerSharedProfileCache = new Map();

const getCachedHomeownerMe = (userId) => {
  if (!userId) return null;
  const entry = homeownerMeCache.get(String(userId));
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > HOMEOWNER_ME_CACHE_TTL_MS) {
    homeownerMeCache.delete(String(userId));
    return null;
  }
  return entry.payload;
};

const setCachedHomeownerMe = (userId, payload) => {
  if (!userId) return;
  homeownerMeCache.set(String(userId), {
    loadedAt: Date.now(),
    payload,
  });
};

export const invalidateHomeownerMeCache = (userId) => {
  if (!userId) return;
  homeownerMeCache.delete(String(userId));
};

const getSharedHomeownerProfileCacheKey = ({ viewerRole, viewerId, homeownerId, liteMode }) =>
  `${String(viewerRole || "")}:${String(viewerId || "")}:${String(homeownerId || "")}:${liteMode ? "lite" : "full"}`;

const getCachedSharedHomeownerProfile = (cacheKey) => {
  if (!cacheKey) return null;
  const entry = homeownerSharedProfileCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > HOMEOWNER_SHARED_PROFILE_CACHE_TTL_MS) {
    homeownerSharedProfileCache.delete(cacheKey);
    return null;
  }
  return entry.payload;
};

const setCachedSharedHomeownerProfile = (cacheKey, payload) => {
  if (!cacheKey) return;
  homeownerSharedProfileCache.set(cacheKey, {
    loadedAt: Date.now(),
    payload,
  });
};

const resolveHomeownerImage = (person) => {
  const image = String(
    person?.avatar ||
      person?.profileImage ||
      person?.profilePicture ||
      person?.photoUrl ||
      person?.image ||
      person?.photo ||
      person?.picture ||
      ""
  ).trim();
  return /^(https?:\/\/|\/|blob:|data:image\/)/i.test(image) ? image : "";
};

const formatHomeownerProfile = (user) => ({
  id: user?._id ? String(user._id) : "",
  firstName: user?.firstName || "",
  lastName: user?.lastName || "",
  email: user?.email || "",
  mobileNumber: user?.phone || "",
  city: user?.city || "",
  barangay: user?.barangay || "",
  province: user?.province || "",
  address: user?.address || "",
  avatar: resolveHomeownerImage(user),
  rating: typeof user?.rating === "number" ? user.rating : 5,
  ratingCount: typeof user?.ratingCount === "number" ? user.ratingCount : 0,
  email_notifications:
    typeof user?.email_notifications === "boolean"
      ? user.email_notifications
      : true,
  mustChangePassword: Boolean(user?.mustChangePassword),
  createdAt: user?.createdAt || null,
  updatedAt: user?.updatedAt || null,
});

const publicProfileImage = (person) => {
  return resolveHomeownerImage(person);
};

const publicRenderableImage = (person) => {
  return resolveHomeownerImage(person);
};

export const getHomeownerMe = async (req, res) => {
  try {
    const perfStartedAt = performance.now();
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const shouldBypassCache =
      String(req.query?.fresh || "").trim().toLowerCase() === "1" ||
      String(req.query?.fresh || "").trim().toLowerCase() === "true";
    const imageOnly = String(req.query?.asset || "").trim().toLowerCase() === "avatar";
    const includeImage = imageOnly || !["0", "false", "no"].includes(
      String(req.query?.images ?? "1").trim().toLowerCase()
    );

    const cached = shouldBypassCache || imageOnly || !includeImage ? null : getCachedHomeownerMe(userId);
    if (cached) {
      return res.status(200).json(cached);
    }

    const [user] = Types.ObjectId.isValid(String(userId))
      ? await HomeOwner.aggregate([
          { $match: { _id: new Types.ObjectId(String(userId)) } },
          {
            $project: {
              ...(imageOnly ? {} : {
                firstName: 1,
                lastName: 1,
                email: 1,
                phone: 1,
                city: 1,
                barangay: 1,
                province: 1,
                address: 1,
                status: 1,
                isVerified: 1,
                email_notifications: 1,
                rating: 1,
                ratingCount: 1,
                createdAt: 1,
                updatedAt: 1,
              }),
              ...(includeImage ? {
                avatar: {
                  $cond: [
                    { $gt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 0] },
                    "$avatar",
                    "$profileImage",
                  ],
                },
              } : {}),
            },
          },
        ])
      : [];
    const perfQueryDoneAt = performance.now();
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Homeowner not found" });
    }

    let workerReviews = [];
    if (!imageOnly) {
      try {
        const rawReviews = await ServiceRequest.find({
          homeownerId: String(user._id),
          workerReviewRating: { $ne: null },
        })
          .select("workerReviewRating workerReviewText workerReviewTags workerReviewedAt completedOn targetWorkerId serviceType")
          .populate("targetWorkerId", "firstName lastName name avatar profileImage profession")
          .sort({ workerReviewedAt: -1 })
          .lean();

        workerReviews = rawReviews.map((rev) => ({
          id: String(rev._id),
          workerName: [rev.targetWorkerId?.firstName, rev.targetWorkerId?.lastName].filter(Boolean).join(" ") || rev.targetWorkerId?.name || "Skilled Worker",
          workerProfession: rev.targetWorkerId?.profession || rev.serviceType || "Skilled Worker",
          workerAvatar: rev.targetWorkerId?.avatar || rev.targetWorkerId?.profileImage || "",
          rating: Number(rev.workerReviewRating) || 5,
          comment: String(rev.workerReviewText || ""),
          tags: Array.isArray(rev.workerReviewTags) ? rev.workerReviewTags : [],
          reviewedAt: rev.workerReviewedAt || rev.completedOn,
        }));
      } catch (err) {
        console.error("Failed to load homeowner worker reviews:", err);
      }
    }

    const payload = {
      homeowner: {
        id: String(user._id),
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        email: user.email || "",
        mobileNumber: user.phone || "",
        city: user.city || "",
        barangay: user.barangay || "",
        province: user.province || "",
        address: user.address || "",
        status: user.status || "",
        isVerified: Boolean(user.isVerified),
        avatar: resolveHomeownerImage(user),
        email_notifications:
          typeof user.email_notifications === "boolean"
            ? user.email_notifications
            : true,
        rating: typeof user.rating === "number" ? user.rating : 5,
        ratingCount: typeof user.ratingCount === "number" ? user.ratingCount : workerReviews.length,
        reviews: workerReviews,
        workerReviews,
        createdAt: user.createdAt || null,
        updatedAt: user.updatedAt || null,
      },
    };

    if (!imageOnly && includeImage) setCachedHomeownerMe(userId, payload);
    console.info(`[PERF] homeowner-me mongo=${(perfQueryDoneAt - perfStartedAt).toFixed(1)}ms total=${(performance.now() - perfStartedAt).toFixed(1)}ms`);
    return res.status(200).json(payload);
  } catch (error) {
    console.error("Get profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const updateHomeownerMe = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const protectedFields = [
      "firstName",
      "lastName",
      "fullName",
      "email",
      "mobileNumber",
      "phone",
      "city",
      "barangay",
      "province",
      "location",
      "address",
    ];
    if (protectedFields.some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
      return res.status(403).json({
        success: false,
        message: "Protected account information can only be updated by an administrator.",
      });
    }

    const {
      avatar,
      profileImage,
      emailNotifications,
      email_notifications: emailNotificationsSnake,
    } = req.body || {};

    const updates = {};
    if (avatar !== undefined) updates.avatar = await convertBase64ToPublicAsset(avatar, STORAGE_FOLDERS.PROFILES, req);
    if (profileImage !== undefined)
      updates.profileImage = await convertBase64ToPublicAsset(profileImage, STORAGE_FOLDERS.PROFILES, req);

    const resolveEmailNotifications = (value) => {
      if (value === undefined) return undefined;
      if (value === true || value === false) return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
      }
      return "__invalid__";
    };

    const emailPref =
      resolveEmailNotifications(emailNotifications) ??
      resolveEmailNotifications(emailNotificationsSnake);
    if (emailPref === "__invalid__") {
      return res.status(400).json({
        success: false,
        message: "email_notifications must be true or false.",
      });
    }
    if (emailPref !== undefined) {
      updates.email_notifications = Boolean(emailPref);
    }

    const user = await HomeOwner.findByIdAndUpdate(userId, updates, {
      new: true,
      runValidators: true,
    }).select(
      "firstName lastName email phone city barangay province address status isVerified avatar profileImage profilePicture photoUrl image photo picture email_notifications createdAt updatedAt"
    ).lean();

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Homeowner not found" });
    }

    const payload = {
      homeowner: {
        id: String(user._id),
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        email: user.email || "",
        mobileNumber: user.phone || "",
        city: user.city || "",
        barangay: user.barangay || "",
        province: user.province || "",
        address: user.address || "",
        status: user.status || "",
        isVerified: Boolean(user.isVerified),
        avatar: resolveHomeownerImage(user),
        email_notifications:
          typeof user.email_notifications === "boolean"
            ? user.email_notifications
            : true,
        createdAt: user.createdAt || null,
        updatedAt: user.updatedAt || null,
      },
    };

    setCachedHomeownerMe(userId, payload);
    return res.status(200).json(payload);
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const getSharedHomeownerProfile = async (req, res) => {
  try {
    const viewerRole = String(req.user?.role || "");
    const viewerId = String(req.user?.id || "");
    const homeownerId = String(req.params.id || "");
    const liteMode =
      String(req.query?.lite || req.query?.summaryOnly || "").trim().toLowerCase() === "true" ||
      String(req.query?.lite || req.query?.summaryOnly || "").trim() === "1";
    const cacheKey = liteMode
      ? getSharedHomeownerProfileCacheKey({ viewerRole, viewerId, homeownerId, liteMode })
      : "";

    const cached = getCachedSharedHomeownerProfile(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    if (!Types.ObjectId.isValid(homeownerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid homeowner profile.",
      });
    }

    const homeowner = await HomeOwner.findById(homeownerId).select(
      "firstName lastName email phone city barangay province address avatar profileImage profilePicture photoUrl image photo picture email_notifications rating ratingCount createdAt updatedAt"
    );

    if (!homeowner) {
      return res.status(404).json({
        success: false,
        message: "Homeowner not found.",
      });
    }

    let allowed = false;
    if (viewerRole === "homeowner") {
      allowed = viewerId === homeownerId;
    } else if (viewerRole === "worker") {
      allowed = Boolean(
        await ServiceRequest.exists({
          homeownerId,
          targetWorkerId: viewerId,
        })
      );
    } else if (viewerRole === "admin") {
      allowed = Boolean(await ServiceRequest.exists({ homeownerId }));
    }

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "Forbidden.",
      });
    }

    const requestFilter =
      viewerRole === "worker"
        ? { homeownerId, targetWorkerId: viewerId }
        : { homeownerId };

    const summaryFilter =
      viewerRole === "worker"
        ? { homeownerId, targetWorkerId: viewerId }
        : { homeownerId };

    const [summaryCounts, requests, workers] = liteMode
      ? await Promise.all([
          ServiceRequest.aggregate([
            { $match: summaryFilter },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                pending: {
                  $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] },
                },
                ongoing: {
                  $sum: { $cond: [{ $eq: ["$status", "ONGOING"] }, 1, 0] },
                },
                completed: {
                  $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
                },
                cancelled: {
                  $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] },
                },
                declined: {
                  $sum: { $cond: [{ $eq: ["$status", "DECLINED"] }, 1, 0] },
                },
              },
            },
          ]),
          Promise.resolve([]),
          Promise.resolve([]),
        ])
      : await Promise.all([
          Promise.resolve([]),
          ServiceRequest.find(requestFilter)
            .select("requestNumber homeownerId targetWorkerId description serviceType preferredDate preferredTime contactNumber location address status createdAt updatedAt acceptedOn completedOn cancelledOn declineReason cancelledBy reviewRating reviewText reviewedAt")
            .sort({ createdAt: -1 })
            .lean(),
          Promise.resolve(null),
        ]);

    const summary = liteMode
      ? (summaryCounts?.[0] || {
          total: 0,
          pending: 0,
          ongoing: 0,
          completed: 0,
          cancelled: 0,
          declined: 0,
        })
      : requests.reduce(
          (acc, request) => {
            const status = String(request.status || "").toUpperCase();
            acc.total += 1;
            if (status === "PENDING") acc.pending += 1;
            if (status === "ONGOING") acc.ongoing += 1;
            if (status === "COMPLETED") acc.completed += 1;
            if (status === "CANCELLED") acc.cancelled += 1;
            if (status === "DECLINED") acc.declined += 1;
            return acc;
          },
          {
            total: 0,
            pending: 0,
            ongoing: 0,
            completed: 0,
            cancelled: 0,
            declined: 0,
          }
        );

    const workerById = new Map();
    if (!liteMode) {
      const workerIds = [...new Set(
        requests
          .map((request) => String(request.targetWorkerId || ""))
          .filter(Boolean)
      )];
      const workersFull = workerIds.length
        ? await Worker.find({
            _id: { $in: workerIds },
            $or: [{ status: "Verified" }, { isVerified: true }],
          })
          .select("firstName lastName name email avatar profileImage photoUrl image photo picture")
          .lean()
        : [];
      workersFull.forEach((w) => workerById.set(String(w._id), w));
    }

    let workerReviews = [];
    try {
      const rawReviews = await ServiceRequest.find({
        homeownerId: String(homeowner._id),
        workerReviewRating: { $ne: null },
      })
        .select("workerReviewRating workerReviewText workerReviewTags workerReviewedAt completedOn targetWorkerId serviceType")
        .populate("targetWorkerId", "firstName lastName name avatar profileImage profession")
        .sort({ workerReviewedAt: -1 })
        .lean();

      workerReviews = rawReviews.map((rev) => ({
        id: String(rev._id),
        workerName: [rev.targetWorkerId?.firstName, rev.targetWorkerId?.lastName].filter(Boolean).join(" ") || rev.targetWorkerId?.name || "Skilled Worker",
        workerProfession: rev.targetWorkerId?.profession || rev.serviceType || "Skilled Worker",
        workerAvatar: rev.targetWorkerId?.avatar || rev.targetWorkerId?.profileImage || "",
        rating: Number(rev.workerReviewRating) || 5,
        comment: String(rev.workerReviewText || ""),
        tags: Array.isArray(rev.workerReviewTags) ? rev.workerReviewTags : [],
        reviewedAt: rev.workerReviewedAt || rev.completedOn,
      }));
    } catch (err) {
      console.error("Failed to load worker reviews for shared profile:", err);
    }

    const homeownerProfile = {
      ...formatHomeownerProfile(homeowner),
      rating: typeof homeowner.rating === "number" ? homeowner.rating : 5,
      ratingCount: typeof homeowner.ratingCount === "number" ? homeowner.ratingCount : workerReviews.length,
      reviews: workerReviews,
      workerReviews,
    };

    const responsePayload = {
      success: true,
      canEdit: viewerRole === "homeowner" && viewerId === homeownerId,
      viewerRole,
      rating: typeof homeowner.rating === "number" ? homeowner.rating : 5,
      ratingCount: typeof homeowner.ratingCount === "number" ? homeowner.ratingCount : workerReviews.length,
      reviews: workerReviews,
      workerReviews,
      homeowner: liteMode
        ? {
            ...homeownerProfile,
            avatar: resolveHomeownerImage(homeowner),
            profileImage: resolveHomeownerImage(homeowner),
            profilePicture: resolveHomeownerImage(homeowner),
            photoUrl: resolveHomeownerImage(homeowner),
            image: resolveHomeownerImage(homeowner),
            photo: resolveHomeownerImage(homeowner),
            picture: resolveHomeownerImage(homeowner),
          }
        : homeownerProfile,
      summary,
      requests: liteMode
        ? []
        : requests.map((request) => ({
            id: request.requestNumber,
            requestNumber: request.requestNumber,
            homeownerId: String(request.homeownerId || ""),
            targetWorkerId: String(request.targetWorkerId || ""),
            workerName:
              [
                workerById.get(String(request.targetWorkerId))?.firstName,
                workerById.get(String(request.targetWorkerId))?.lastName,
              ]
                .filter(Boolean)
                .join(" ") ||
              workerById.get(String(request.targetWorkerId))?.name ||
              workerById.get(String(request.targetWorkerId))?.email ||
              "Worker",
            workerEmail: workerById.get(String(request.targetWorkerId))?.email || "",
            workerAvatar: publicProfileImage(workerById.get(String(request.targetWorkerId))),
            description: request.description || "",
            serviceType: request.serviceType || "General Repair",
            preferredDate: request.preferredDate || null,
            preferredTime: request.preferredTime || "",
            contactNumber: request.contactNumber || "",
            location: request.location || "",
            address: request.address || "",
            status: request.status || "PENDING",
            createdAt: request.createdAt || null,
            updatedAt: request.updatedAt || null,
            acceptedOn: request.acceptedOn || null,
            completedOn: request.completedOn || null,
            cancelledOn: request.cancelledOn || null,
            declineReason: request.declineReason || "",
            cancelledBy: request.cancelledBy || null,
            reviewRating: request.reviewRating ?? null,
            reviewText: request.reviewText || "",
            reviewedAt: request.reviewedAt || null,
          })),
    };

    if (liteMode) {
      setCachedSharedHomeownerProfile(cacheKey, responsePayload);
    }

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error("Get shared homeowner profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const changeHomeownerPassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { currentPassword, newPassword, confirmPassword, resetToken } = req.body || {};

    if (!currentPassword) {
      return res
        .status(400)
        .json({ success: false, message: "Current password is incorrect." });
    }
    if (!resetToken) {
      return res
        .status(400)
        .json({ success: false, message: "Confirmation code is required." });
    }
    if (!newPassword || !confirmPassword) {
      return res
        .status(400)
        .json({ success: false, message: "Passwords do not match." });
    }

    const hasLetter = /[A-Za-z]/.test(String(newPassword));
    const hasNumber = /\d/.test(String(newPassword));
    if (String(newPassword).length < 8 || !hasLetter || !hasNumber) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters and include letters and numbers.",
      });
    }

    if (String(newPassword) !== String(confirmPassword)) {
      return res
        .status(400)
        .json({ success: false, message: "Passwords do not match." });
    }

    if (String(newPassword) === String(currentPassword)) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password.",
      });
    }

    let tokenPayload;
    try {
      tokenPayload = jwt.verify(String(resetToken), getJwtSecret());
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired confirmation code.",
      });
    }

    if (
      !tokenPayload ||
      tokenPayload.purpose !== "reset_password" ||
      String(tokenPayload.id || "") !== String(userId)
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired confirmation code.",
      });
    }

    const user = await HomeOwner.findById(userId).select("password email");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Homeowner not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res
        .status(400)
        .json({ success: false, message: "Current password is incorrect." });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    console.info("Homeowner password changed", { userId: String(user._id) });

    try {
      await sendEmail({
        to: user.email,
        subject: "Your password was changed",
        text: "Your TrabaHome password was changed successfully. If this wasn't you, contact support immediately.",
        html: `
          <div style="font-family: Arial, sans-serif; background:#f8fafc; padding:24px;">
            <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:20px; padding:28px; border:1px solid #e5e7eb;">
              <h2 style="margin:0 0 12px; color:#0B3B68;">Password changed</h2>
              <p style="margin:0; color:#334155; line-height:1.6;">
                Your TrabaHome password was changed successfully.
              </p>
              <p style="margin:16px 0 0; color:#64748b; line-height:1.6;">
                If this wasn’t you, please contact support right away and secure your account.
              </p>
            </div>
          </div>
        `,
      });
    } catch (emailError) {
      console.error("Password change email error:", emailError);
    }

    void createHomeownerNotification({
      userId: user._id,
      title: "Password updated",
      message: "Your account password has been updated successfully.",
      type: "info",
      meta: { route: "/homeowner-own-profile" },
    }).catch((err) => console.error("Homeowner password update notification error:", err));

    return res.status(200).json({
      message: "Password updated successfully.",
    });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const verifyHomeownerCurrentPassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { currentPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const user = await HomeOwner.findById(userId).select("password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Homeowner not found",
      });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Current password verified.",
    });
  } catch (error) {
    console.error("Verify current password error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const updateHomeownerInitialPassword = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || "").trim();
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    const { newPassword, confirmPassword } = req.body || {};
    if (!newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: "New password and confirmation are required." });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Passwords do not match." });
    }
    const pwdError = validateStrongPassword(newPassword);
    if (pwdError) {
      return res.status(400).json({ success: false, message: pwdError });
    }
    const user = await HomeOwner.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Homeowner not found." });
    }
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    await user.save();
    invalidateHomeownerMeCache(userId);

    void createHomeownerNotification({
      userId: user._id,
      title: "Password updated",
      message: "Your permanent password has been set successfully.",
      type: "info",
      meta: { route: "/homeowner-own-profile" },
    }).catch((err) => console.error("Homeowner initial password update notification error:", err));

    return res.status(200).json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    console.error("Update homeowner initial password error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const markGuideSeen = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    await HomeOwner.findByIdAndUpdate(userId, { $set: { hasSeenGuide: true } });
    invalidateHomeownerMeCache(userId);
    return res.status(200).json({ success: true, hasSeenGuide: true });
  } catch (err) {
    console.error("Mark homeowner guide seen error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};


