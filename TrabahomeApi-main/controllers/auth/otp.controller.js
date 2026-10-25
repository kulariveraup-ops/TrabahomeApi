import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { isValidObjectId } from "mongoose";
import Otp from "../../models/otp.Model.js";
import Admin from "../../models/admin.Model.js";
import HomeOwner from "../../models/homeOwner.Model.js";
import Worker from "../../models/worker.Model.js";
import { createAndSendOtp, hashOtp } from "../../services/otp.service.js";
import { sendEmail } from "../../services/email.service.js";
import {
  createHomeownerNotification,
  createWorkerNotification,
} from "../../services/notify.js";
import {
  LOGIN_OTP_LENGTH,
  LOGIN_OTP_MAX_ATTEMPTS,
  LOGIN_OTP_MAX_RESENDS_PER_HOUR,
  LOGIN_OTP_RESEND_COOLDOWN_SECONDS,
  LOGIN_OTP_TTL_SECONDS,
} from "../../services/loginOtpPolicy.js";
import {
  isAccountDisabled,
  isAccountVerified,
  isValidEmail,
  normalizeEmail,
  toHomeownerProfile,
  toWorkerProfile,
} from "../../utils/auth.utils.js";

const USER_MODELS = {
  admin: Admin,
  homeowner: HomeOwner,
  worker: Worker,
};

const getUserModel = (userType) =>
  Object.prototype.hasOwnProperty.call(USER_MODELS, userType)
    ? USER_MODELS[userType]
    : null;

const getJwtSecret = () => process.env.JWT_SECRET || "change-this-secret";

const buildLoginPayload = (userType, user) => {
  const payload = { id: String(user._id), email: user.email };
  if (userType === "admin") payload.role = "admin";
  if (userType === "homeowner") payload.role = "homeowner";
  if (userType === "worker") payload.role = "worker";
  return payload;
};

export const requestForgotPasswordOtp = async (req, res) => {
  try {
    const { userType, email } = req.body;

    if (!userType || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "A valid user type and email are required.",
      });
    }

    const model = getUserModel(userType);
    if (!model) {
      return res.status(400).json({
        success: false,
        message: "Invalid user type.",
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const userQuery = model.findOne({ email: normalizedEmail });
    const user = typeof userQuery?.select === "function" ? await userQuery.select("_id email") : await userQuery;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: `No ${userType} account was found for that email.`,
      });
    }

    await createAndSendOtp({
      userType,
      userId: user._id,
      email: user.email,
      purpose: "forgot_password",
      replaceExisting: true,
    });

    return res.status(200).json({
      success: true,
      message: "An OTP has been sent to your email.",
    });
  } catch (error) {
    console.error("Forgot password OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

const findOtp = async ({ otpId, userType, email, purpose }) => {
  if (!userType || !email || !purpose) {
    return null;
  }

  const model = getUserModel(userType);
  if (!model) return null;

  const normalizedEmail = normalizeEmail(email);
  const userQuery = model.findOne({ email: normalizedEmail });
  const user = typeof userQuery?.select === "function" ? await userQuery.select("_id") : await userQuery;
  if (!user) return null;

  const query = {
    userType,
    userId: user._id,
    purpose,
    usedAt: null,
  };

  if (otpId) {
    query._id = otpId;
  }

  return Otp.findOne(query).sort({ createdAt: -1 });
};

const findLoginOtpVerificationState = async ({ otpId, userType, email }) => {
  if (!userType || !email) return null;

  const model = getUserModel(userType);
  if (!model) return null;

  const normalizedEmail = normalizeEmail(email);
  const userQuery = model.findOne({ email: normalizedEmail });
  const user = typeof userQuery?.select === "function" ? await userQuery.select("_id") : await userQuery;
  if (!user) return null;

  const scope = {
    userType,
    userId: user._id,
    purpose: "login",
  };
  const latestOtp = await Otp.findOne(scope).sort({ createdAt: -1, _id: -1 });
  const otp = otpId && isValidObjectId(otpId)
    ? await Otp.findOne({ ...scope, _id: otpId })
    : (!otpId ? latestOtp : null);

  return { otp, latestOtp };
};

const logLoginOtpTrace = (trace, verificationSuccess = false) => {
  console.info("[LOGIN_OTP_TRACE]", trace);
  if (trace.role === "homeowner") {
    console.info("[HOMEOWNER_LOGIN_OTP] backend verification", {
      otpIdMatch: trace.otpIdMatch,
      otpFound: trace.otpFound,
      expired: trace.expired,
      used: trace.used,
      hashMatch: trace.hashMatch,
      success: verificationSuccess,
    });
  }
};

const isValidOtpCode = (code) =>
  new RegExp(`^\\d{${LOGIN_OTP_LENGTH}}$`).test(String(code || ""));

const validateNewPassword = ({
  currentPassword,
  newPassword,
  confirmPassword,
  requireCurrentPassword = true,
}) => {
  if (requireCurrentPassword && !currentPassword) {
    return "Current password is incorrect.";
  }
  if (!newPassword || !confirmPassword) return "Passwords do not match.";

  const nextPassword = String(newPassword);
  if (
    nextPassword.length < 8 ||
    !/[A-Za-z]/.test(nextPassword) ||
    !/\d/.test(nextPassword)
  ) {
    return "Password must be at least 8 characters and include letters and numbers.";
  }

  if (nextPassword !== String(confirmPassword)) {
    return "Passwords do not match.";
  }

  return null;
};

const verifyAndConsumeOtp = async ({ userType, userId, purpose, code }) => {
  const otp = await Otp.findOne({
    userType,
    userId,
    purpose,
    usedAt: null,
  }).sort({ createdAt: -1 });
  const now = new Date();

  if (
    !otp ||
    otp.expiresAt <= now ||
    otp.attempts >= otp.maxAttempts
  ) {
    return null;
  }

  const incomingCode = String(code || "");
  const incomingHash = hashOtp(incomingCode);
  if (!isValidOtpCode(incomingCode) || incomingHash !== otp.codeHash) {
    await Otp.updateOne(
      { _id: otp._id, usedAt: null },
      { $inc: { attempts: 1 } }
    );
    return null;
  }

  return Otp.findOneAndUpdate(
    {
      _id: otp._id,
      userType,
      userId,
      purpose,
      codeHash: incomingHash,
      usedAt: null,
      expiresAt: { $gt: now },
      attempts: { $lt: otp.maxAttempts },
    },
    { $set: { usedAt: now } },
    { returnDocument: "after" }
  );
};

const sendPasswordChangedEmail = async ({ email, userType }) => {
  try {
    await sendEmail({
      to: email,
      subject: "Your password was changed",
      text: `Your TrabaHome ${userType} password was changed successfully. If this wasn't you, contact support immediately.`,
      html: `
        <div style="font-family: Arial, sans-serif; background:#f8fafc; padding:24px;">
          <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:20px; padding:28px; border:1px solid #e5e7eb;">
            <h2 style="margin:0 0 12px; color:#0B3B68;">Password changed</h2>
            <p style="margin:0; color:#334155; line-height:1.6;">
              Your TrabaHome password was changed successfully.
            </p>
            <p style="margin:16px 0 0; color:#64748b; line-height:1.6;">
              If this wasn't you, please contact support immediately and secure your account.
            </p>
          </div>
        </div>
      `,
    });
  } catch (error) {
    console.error(`${userType} password change email error:`, error);
  }
};

const LOGIN_RESEND_COOLDOWN_MS = LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000;
const LOGIN_RESEND_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_MAX_SENDS_PER_HOUR = LOGIN_OTP_MAX_RESENDS_PER_HOUR + 1;

const verifyLoginOtpForUserType = (userType) => async (req, res) => {
  const trace = {
    role: userType,
    purpose: "login",
    route: `${req.baseUrl || ""}${req.route?.path || req.path || ""}`,
    controller: "verifyLoginOtpForUserType",
    otpIdMatch: false,
    otpFound: false,
    expired: false,
    used: false,
    hashMatch: false,
  };

  try {
    const { otpId, code, email } = req.body;

    const verificationState = await findLoginOtpVerificationState({
      otpId,
      userType,
      email,
    });
    const otp = verificationState?.otp || null;
    const latestOtp = verificationState?.latestOtp || null;
    const now = new Date();

    trace.otpFound = Boolean(otp);
    trace.otpIdMatch = Boolean(
      otp &&
      latestOtp &&
      (otpId
        ? String(otp._id) === String(otpId) && String(otp._id) === String(latestOtp._id)
        : String(otp._id) === String(latestOtp._id))
    );
    trace.expired = Boolean(otp && otp.expiresAt <= now);
    trace.used = Boolean(otp?.usedAt);

    if (
      !otp ||
      !trace.otpIdMatch ||
      otp.userType !== userType ||
      otp.purpose !== "login" ||
      otp.usedAt ||
      otp.expiresAt <= now
    ) {
      logLoginOtpTrace(trace);
      return res.status(400).json({
        success: false,
        message: "Invalid or expired code.",
      });
    }

    const maxAttempts = Math.min(
      Number.isFinite(otp.maxAttempts) ? otp.maxAttempts : LOGIN_OTP_MAX_ATTEMPTS,
      LOGIN_OTP_MAX_ATTEMPTS
    );

    if (otp.attempts >= maxAttempts) {
      logLoginOtpTrace(trace);
      return res.status(429).json({
        success: false,
        message: "Too many attempts. Request a new code.",
      });
    }

    const incomingCode = String(code || "");
    const incomingHash = hashOtp(incomingCode);
    trace.hashMatch = Boolean(
      isValidOtpCode(incomingCode) && incomingHash === otp.codeHash
    );

    if (!trace.hashMatch) {
      otp.attempts += 1;
      await otp.save();

      if (otp.attempts >= maxAttempts) {
        logLoginOtpTrace(trace);
        return res.status(429).json({
          success: false,
          message: "Too many attempts. Request a new code.",
        });
      }

      logLoginOtpTrace(trace);
      return res.status(400).json({
        success: false,
        message: "Invalid or expired code.",
      });
    }

    const model = getUserModel(otp.userType);
    if (!model) {
      logLoginOtpTrace(trace);
      return res.status(400).json({
        success: false,
        message: "Invalid user type.",
      });
    }

    const user = await model.findById(otp.userId).select("-password -idCardImage -idSelfieImage -proofOfWork");
    if (!user) {
      logLoginOtpTrace(trace);
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (
      userType !== "admin" &&
      (isAccountDisabled(user) || !isAccountVerified(user))
    ) {
      logLoginOtpTrace(trace);
      return res.status(403).json({
        success: false,
        message:
          userType === "worker"
            ? "Your worker account is not available for login. Please contact an admin."
            : "Your homeowner account is not available for login. Please contact support.",
      });
    }

    const consumedOtp = await Otp.findOneAndUpdate(
      {
        _id: otp._id,
        userType,
        userId: otp.userId,
        purpose: "login",
        codeHash: incomingHash,
        usedAt: null,
        expiresAt: { $gt: now },
        attempts: { $lt: maxAttempts },
      },
      {
        $set: {
          usedAt: now,
          attempts: 0,
        },
      },
      { new: true }
    );

    if (!consumedOtp) {
      logLoginOtpTrace(trace);
      return res.status(400).json({
        success: false,
        message: "Invalid or expired code.",
      });
    }

    const token = jwt.sign(
      buildLoginPayload(consumedOtp.userType, user),
      getJwtSecret(),
      { expiresIn: "1d" }
    );

    logLoginOtpTrace(trace, true);

    if (userType === "homeowner") {
      const isFirstLogin = !user.hasSeenGuide;
      if (isFirstLogin) {
        await model.updateOne({ _id: user._id }, { $set: { hasSeenGuide: true } }).catch(() => {});
      }
      const profile = toHomeownerProfile(user);
      return res.status(200).json({
        success: true,
        message: "Logged in successfully.",
        token,
        email: profile.email,
        homeowner: { ...profile, showFirstTimeGuide: isFirstLogin },
        showFirstTimeGuide: isFirstLogin,
        mustChangePassword: Boolean(user.mustChangePassword),
      });
    }

    if (userType === "admin") {
      const { password: _, ...adminData } = user.toObject ? user.toObject() : user;
      return res.status(200).json({
        success: true,
        message: "Logged in successfully.",
        token,
        email: user.email,
        admin: adminData,
        data: adminData,
      });
    }

    const isFirstLogin = !user.hasSeenGuide;
    if (isFirstLogin) {
      await model.updateOne({ _id: user._id }, { $set: { hasSeenGuide: true } }).catch(() => {});
    }
    const profile = toWorkerProfile(user);
    return res.status(200).json({
      success: true,
      message: "Logged in successfully.",
      token,
      email: profile.email,
      worker: { ...profile, showFirstTimeGuide: isFirstLogin },
      showFirstTimeGuide: isFirstLogin,
      mustChangePassword: Boolean(user.mustChangePassword),
    });
  } catch (error) {
    console.error("OTP verify error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

const resendLoginOtpForUserType = (userType) => async (req, res) => {
  try {
    const { email } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address.",
      });
    }

    const model = getUserModel(userType);
    if (!model) {
      return res.status(400).json({
        success: false,
        message: "Invalid user type.",
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const userQuery = model.findOne({ email: normalizedEmail });
    const user = typeof userQuery?.select === "function" ? await userQuery.select("_id email") : await userQuery;

    if (!user) {
      return res.status(200).json({
        success: true,
        message: "Code resent. Check your email.",
      });
    }

    const now = new Date();
    const latestOtp = await Otp.findOne({
      userType,
      userId: user._id,
      purpose: "login",
      usedAt: null,
    }).sort({ createdAt: -1 });

    if (
      latestOtp?.lastSentAt &&
      now - latestOtp.lastSentAt < LOGIN_RESEND_COOLDOWN_MS
    ) {
      return res.status(429).json({
        success: false,
        message: "Too many attempts. Request a new code.",
      });
    }

    const windowStart = new Date(now.getTime() - LOGIN_RESEND_WINDOW_MS);
    const sendsLastHour = await Otp.countDocuments({
      userType,
      userId: user._id,
      purpose: "login",
      createdAt: { $gte: windowStart },
    });

    if (sendsLastHour >= LOGIN_MAX_SENDS_PER_HOUR) {
      return res.status(429).json({
        success: false,
        message: "Too many attempts. Request a new code.",
      });
    }

    const loginOtp = await createAndSendOtp({
      userType,
      userId: user._id,
      email: user.email,
      purpose: "login",
      length: LOGIN_OTP_LENGTH,
      ttlSeconds: LOGIN_OTP_TTL_SECONDS,
      maxAttempts: LOGIN_OTP_MAX_ATTEMPTS,
      replaceExisting: true,
    });

    return res.status(200).json({
      success: true,
      message: "Code resent. Check your email.",
      otpId: loginOtp.otpId,
    });
  } catch (error) {
    console.error("Resend OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const verifyOtp = async (req, res) => {
  try {
    const { otpId, code, userType, email, purpose } = req.body;

    if (!code || !userType || !email || !purpose) {
      return res.status(400).json({
        success: false,
        message: "OTP code, email, user type, and purpose are required.",
      });
    }

    if (
      purpose !== "forgot_password" &&
      !(purpose === "login" && userType === "admin")
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP purpose.",
      });
    }

    const otp = await findOtp({ otpId, userType, email, purpose });
    const now = new Date();

    if (!otp || otp.usedAt || otp.expiresAt <= now || otp.attempts >= otp.maxAttempts) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP.",
      });
    }

    const incomingHash = hashOtp(code);
    if (incomingHash !== otp.codeHash) {
      otp.attempts += 1;
      await otp.save();
      return res.status(401).json({
        success: false,
        message: "Invalid or expired OTP.",
      });
    }

    const usedOtp = await Otp.findOneAndUpdate(
      {
        _id: otp._id,
        userType,
        purpose,
        usedAt: null,
        expiresAt: { $gt: now },
        attempts: { $lt: otp.maxAttempts },
      },
      {
        $set: {
          usedAt: now,
          ...(purpose === "forgot_password"
            ? { expiresAt: new Date(now.getTime() + 15 * 60 * 1000) }
            : {}),
        },
      },
      { returnDocument: "after" }
    );

    if (!usedOtp) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP.",
      });
    }

    const model = getUserModel(otp.userType);
    if (!model) {
      return res.status(400).json({
        success: false,
        message: "Invalid user type.",
      });
    }

    const user = await model.findById(usedOtp.userId).select("-password -idCardImage -idSelfieImage -proofOfWork");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (usedOtp.purpose === "login") {
      const token = jwt.sign(
        buildLoginPayload(usedOtp.userType, user),
        getJwtSecret(),
        { expiresIn: "1d" }
      );

      return res.status(200).json({
        success: true,
        message: "Logged in successfully.",
        token,
        data: user,
      });
    }

    if (usedOtp.purpose === "forgot_password") {
      const resetToken = jwt.sign(
        {
          id: String(user._id),
          otpId: String(usedOtp._id),
          userType: usedOtp.userType,
          purpose: "reset_password",
        },
        getJwtSecret(),
        { expiresIn: "15m" }
      );

      return res.status(200).json({
        success: true,
        message: "OTP verified.",
        resetToken,
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP verified.",
    });
  } catch (error) {
    console.error("OTP verify error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const verifyAdminLoginOtp = verifyLoginOtpForUserType("admin");
export const verifyHomeOwnerLoginOtp = verifyLoginOtpForUserType("homeowner");
export const verifyWorkerLoginOtp = verifyLoginOtpForUserType("worker");
export const resendAdminLoginOtp = resendLoginOtpForUserType("admin");
export const resendHomeOwnerLoginOtp = resendLoginOtpForUserType("homeowner");
export const resendWorkerLoginOtp = resendLoginOtpForUserType("worker");

const requestChangePasswordOtpForUserType = (userType) => async (req, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    const validationError = validateNewPassword({
      currentPassword,
      newPassword,
      confirmPassword,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const model = getUserModel(userType);
    const user = await model.findById(userId).select("password email");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: `${userType === "homeowner" ? "Homeowner" : "Worker"} not found.`,
      });
    }

    const currentMatches = await bcrypt.compare(
      String(currentPassword),
      user.password
    );
    if (!currentMatches) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const reusesCurrentPassword = await bcrypt.compare(
      String(newPassword),
      user.password
    );
    if (reusesCurrentPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password.",
      });
    }

    await createAndSendOtp({
      userType,
      userId: user._id,
      email: user.email,
      purpose: "change_password",
      replaceExisting: true,
    });

    return res.status(200).json({
      success: true,
      message: "A confirmation code has been sent to your email.",
    });
  } catch (error) {
    console.error(`${userType} change password OTP request error:`, error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

const changePasswordForUserType = (userType) => async (req, res) => {
  try {
    const userId = String(req.user?.id || "").trim();
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { currentPassword, newPassword, confirmPassword, code } = req.body || {};
    const validationError = validateNewPassword({
      currentPassword,
      newPassword,
      confirmPassword,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Confirmation code is required.",
      });
    }

    const model = getUserModel(userType);
    const user = await model.findById(userId).select("password email");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: `${userType === "homeowner" ? "Homeowner" : "Worker"} not found.`,
      });
    }

    const currentMatches = await bcrypt.compare(
      String(currentPassword),
      user.password
    );
    if (!currentMatches) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const reusesCurrentPassword = await bcrypt.compare(
      String(newPassword),
      user.password
    );
    if (reusesCurrentPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password.",
      });
    }

    const usedOtp = await verifyAndConsumeOtp({
      userType,
      userId: user._id,
      purpose: "change_password",
      code,
    });
    if (!usedOtp) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired OTP.",
      });
    }

    user.password = await bcrypt.hash(String(newPassword), 10);
    await user.save();
    await Otp.deleteMany({
      userType,
      userId: user._id,
      purpose: "change_password",
    });

    await sendPasswordChangedEmail({ email: user.email, userType });

    if (userType === "homeowner") {
      void createHomeownerNotification({
        userId: user._id,
        title: "Password updated",
        message: "Your account password has been updated successfully.",
        type: "info",
        meta: { route: "/homeowner-own-profile" },
      }).catch((err) => console.error("Homeowner password update notification error:", err));
    } else if (userType === "worker") {
      void createWorkerNotification({
        userId: user._id,
        title: "Password updated",
        message: "Your account password has been updated successfully.",
        type: "info",
        meta: { route: "/worker-own-profile" },
      }).catch((err) => console.error("Worker password update notification error:", err));
    }

    return res.status(200).json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error) {
    console.error(`${userType} change password error:`, error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const requestHomeownerChangePasswordOtp =
  requestChangePasswordOtpForUserType("homeowner");
export const requestWorkerChangePasswordOtp =
  requestChangePasswordOtpForUserType("worker");
export const changeHomeownerPassword = changePasswordForUserType("homeowner");
export const changeWorkerPassword = changePasswordForUserType("worker");

export const resetPassword = async (req, res) => {
  try {
    const { resetToken, newPassword, confirmPassword } = req.body;

    if (!resetToken) {
      return res.status(400).json({
        success: false,
        message: "OTP verification is required before resetting the password.",
      });
    }

    const validationError = validateNewPassword({
      newPassword,
      confirmPassword,
      requireCurrentPassword: false,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    let payload;
    try {
      payload = jwt.verify(resetToken, getJwtSecret());
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired reset token.",
      });
    }

    if (
      !payload ||
      payload.purpose !== "reset_password" ||
      !payload.id ||
      !payload.otpId ||
      !payload.userType
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired reset token.",
      });
    }

    const model = getUserModel(payload.userType);
    if (!model) {
      return res.status(400).json({
        success: false,
        message: "Invalid user type.",
      });
    }

    const user = await model.findById(payload.id).select("password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const reusesCurrentPassword = await bcrypt.compare(
      String(newPassword),
      user.password
    );
    if (reusesCurrentPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password.",
      });
    }

    const consumedVerification = await Otp.findOneAndDelete({
      _id: payload.otpId,
      userType: payload.userType,
      userId: payload.id,
      purpose: "forgot_password",
      usedAt: { $ne: null },
      expiresAt: { $gt: new Date() },
    });
    if (!consumedVerification) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired reset token.",
      });
    }

    user.password = await bcrypt.hash(String(newPassword), 10);
    await user.save();
    await Otp.deleteMany({
      userType: payload.userType,
      userId: payload.id,
      purpose: "forgot_password",
    });

    if (payload.userType === "homeowner") {
      void createHomeownerNotification({
        userId: user._id,
        title: "Password updated",
        message: "Your account password has been reset successfully.",
        type: "info",
        meta: { route: "/homeowner-own-profile" },
      }).catch((err) => console.error("Homeowner password reset notification error:", err));
    } else if (payload.userType === "worker") {
      void createWorkerNotification({
        userId: user._id,
        title: "Password updated",
        message: "Your account password has been reset successfully.",
        type: "info",
        meta: { route: "/worker-own-profile" },
      }).catch((err) => console.error("Worker password reset notification error:", err));
    }

    return res.status(200).json({
      success: true,
      message: "Password reset successful.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
