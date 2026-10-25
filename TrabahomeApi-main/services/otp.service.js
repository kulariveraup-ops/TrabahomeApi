import crypto from "crypto";
import Otp from "../models/otp.Model.js";
import { sendEmail } from "./email.service.js";

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const parseTtlMinutes = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "string" && raw.includes(":")) {
    const [hours, minutes] = raw.split(":").map(Number);
    const total = hours * 60 + minutes;
    if (Number.isFinite(total) && total > 0) return total;
    return fallback;
  }
  return toPositiveInt(raw, fallback);
};

const OTP_LENGTH = toPositiveInt(process.env.OTP_LENGTH, 6);
const OTP_TTL_MINUTES = parseTtlMinutes(process.env.OTP_TTL_MINUTES, 5);
const OTP_MAX_ATTEMPTS = toPositiveInt(process.env.OTP_MAX_ATTEMPTS, 5);
const OTP_SECRET = process.env.OTP_SECRET || process.env.JWT_SECRET || "otp-secret";
const loginOtpIssuanceLocks = new Map();

const generateCode = (length) => {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += crypto.randomInt(0, 10);
  }
  return code;
};

export const hashOtp = (code) =>
  crypto.createHmac("sha256", OTP_SECRET).update(String(code)).digest("hex");

const createAndSendOtpUnlocked = async ({
  userType,
  userId,
  email,
  additionalEmails = [],
  purpose,
  length,
  ttlSeconds,
  maxAttempts,
  replaceExisting = false,
}) => {
  const otpLength = toPositiveInt(length, OTP_LENGTH);
  const ttl = toPositiveInt(ttlSeconds, OTP_TTL_MINUTES * 60);
  const attemptsLimit = toPositiveInt(maxAttempts, OTP_MAX_ATTEMPTS);

  const code = generateCode(otpLength);
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

  if (replaceExisting) {
    const deleteQuery = userId
      ? { userType, userId, purpose }
      : { userType, email: normalizedEmail, purpose };
    await Otp.deleteMany(deleteQuery);
  }

  const otp = await Otp.create({
    userType,
    userId: userId || null,
    email: normalizedEmail,
    purpose,
    channel: "email",
    codeHash,
    expiresAt,
    attempts: 0,
    maxAttempts: attemptsLimit,
    sentCount: 1,
    lastSentAt: new Date(),
  });

  const subject =
    purpose === "login"
      ? "Your login code"
      : purpose === "change_password"
        ? "Your password change code"
        : purpose === "registration"
          ? "Your TrabaHome registration verification code"
          : "Your password reset code";
  const purposeLabel =
    purpose === "login"
      ? "sign in"
      : purpose === "change_password"
        ? "password change"
        : purpose === "registration"
          ? "account registration"
          : "password reset";
  const ttlMinutes = Math.max(1, Math.round(ttl / 60));
  const ttlLabel = ttlMinutes === 1 ? "minute" : "minutes";
  const text = [
    `Your OTP code is ${code}.`,
    `It expires in ${ttlMinutes} ${ttlLabel}.`,
    "If you did not request this, you can ignore this email.",
  ].join(" ");
  const html = `
    <div style="font-family: Arial, sans-serif; background:#f8fafc; padding:24px;">
      <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:20px; padding:28px; border:1px solid #e5e7eb;">
        <h2 style="margin:0 0 12px; color:#0B3B68;">TrabaHome verification code</h2>
        <p style="margin:0 0 20px; color:#334155; line-height:1.6;">
          Use the code below to continue your ${purposeLabel} request.
        </p>
        <div style="font-size:32px; font-weight:700; letter-spacing:8px; color:#0B3B68; background:#eff6ff; border-radius:16px; padding:18px 20px; text-align:center; margin-bottom:20px;">
          ${code}
        </div>
        <p style="margin:0 0 8px; color:#334155;">
          This code expires in ${ttlMinutes} ${ttlLabel}.
        </p>
        <p style="margin:0; color:#64748b; font-size:14px;">
          If you did not request this, you can safely ignore this email.
        </p>
      </div>
    </div>
  `;

  const recipientEmails = Array.from(
    new Set(
      [email, ...additionalEmails]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => /^\S+@\S+\.\S+$/.test(value))
    )
  );

  if (recipientEmails.length === 0) {
    throw new Error("No valid OTP recipient email was provided.");
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      for (const recipient of recipientEmails) {
        console.log(`[OTP] Sending ${purpose} OTP to ${recipient} for ${userType}:${String(userId)}`);
        await sendEmail({ to: recipient, subject, text, html });
        console.log(`[OTP] Sent ${purpose} OTP to ${recipient} for ${userType}:${String(userId)}`);
      }
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.error(`OTP email send error (attempt ${attempt}) to ${recipientEmails.join(", ")}:`, error);
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  if (lastError) {
    console.warn(`[OTP] Email delivery failed (${lastError?.message || lastError}). Keeping OTP active in database.`);
    console.info(`=======================================================`);
    console.info(`🔑 [OTP CODE] Recipient: ${recipientEmails.join(", ")} | Code: ${code} | Purpose: ${purpose}`);
    console.info(`=======================================================`);
    return {
      otpId: otp._id.toString(),
      expiresAt,
      emailDelivered: false,
    };
  }

  return {
    otpId: otp._id.toString(),
    expiresAt,
    emailDelivered: true,
  };
};

const createLoginOtpExclusively = async (lockKey, operation) => {
  const previous = loginOtpIssuanceLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  loginOtpIssuanceLocks.set(lockKey, current);

  try {
    return await current;
  } finally {
    if (loginOtpIssuanceLocks.get(lockKey) === current) {
      loginOtpIssuanceLocks.delete(lockKey);
    }
  }
};

export const createAndSendOtp = async (options) => {
  const shouldSerializeLoginIssuance =
    options?.purpose === "login" && options?.replaceExisting === true;

  if (!shouldSerializeLoginIssuance) {
    return createAndSendOtpUnlocked(options);
  }

  const lockKey = `${options.userType}:${String(options.userId)}:login`;
  return createLoginOtpExclusively(lockKey, () => createAndSendOtpUnlocked(options));
};
