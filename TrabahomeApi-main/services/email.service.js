import nodemailer from "nodemailer";
import EmailLog from "../models/emailLog.Model.js";

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;

  const rawService = String(process.env.SMTP_SERVICE || "").trim();
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = String(process.env.SMTP_PASS || "").replace(/\s+/g, "");
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const tlsRejectUnauthorized =
    String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false";

  if (!host || !user || !pass) {
    throw new Error("SMTP is not configured.");
  }

  const transportConfig = {
    auth: { user, pass },
    tls: { rejectUnauthorized: tlsRejectUnauthorized },
    connectionTimeout: 5000,
    greetingTimeout: 4000,
    socketTimeout: 7000,
  };

  const service = rawService || (String(host).toLowerCase().includes("gmail") ? "gmail" : "");

  if (service) {
    transportConfig.service = service;
  } else {
    transportConfig.host = host;
    transportConfig.port = port;
    transportConfig.secure = secure;
  }

  transporter = nodemailer.createTransport(transportConfig);

  transporter.verify((error, success) => {
    if (error) {
      console.error("[SMTP] Verification failed:", error);
    } else if (success) {
      console.log("[SMTP] Gmail transport ready.");
    }
  });

  return transporter;
};

export const sendEmail = async ({ to, subject, text, html, meta = {} }) => {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const mailer = getTransporter();
  let info = null;
  let sendError = null;

  try {
    info = await mailer.sendMail({
      from: from ? { name: "TrabaHome", address: from } : undefined,
      to,
      subject,
      text,
      html,
      replyTo: from || undefined,
    });

    const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];

    if (rejected.length > 0 || accepted.length === 0) {
      throw new Error(
        `Email delivery was not accepted by the SMTP provider. accepted=${accepted.join(",") || "none"} rejected=${rejected.join(",") || "none"}`
      );
    }
  } catch (err) {
    sendError = err;
  }

  // Record to EmailLog for real-time admin monitoring
  try {
    const now = new Date();
    const formattedDate = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const previewMessage = text || (html ? String(html).replace(/<[^>]*>?/gm, "").slice(0, 300) : "");
    await EmailLog.create({
      requestId: String(meta.requestId || meta.id || "").trim(),
      recipientName: String(meta.recipientName || meta.name || "").trim(),
      recipientRole: String(meta.recipientRole || meta.role || "User").trim(),
      emailAddress: String(to || "").trim().toLowerCase(),
      emailType: String(meta.emailType || meta.type || (subject?.includes("OTP") ? "One-Time Password (OTP)" : "System Notification")).trim(),
      subject: String(subject || "TrabaHome Notification").trim(),
      message: previewMessage,
      status: sendError ? "Failed" : "Delivered",
      gatewayResponse: sendError
        ? (sendError.message || "550 Delivery failed")
        : (info?.response || "250 2.0.0 OK SMTP Delivery via Gmail TLS"),
      attempts: 1,
      error: sendError ? String(sendError.message || sendError) : "",
      dateSent: formattedDate,
    });
  } catch (logErr) {
    console.warn("[EmailLog] Warning: failed to save email log:", logErr?.message || logErr);
  }

  if (sendError) throw sendError;
  return info;
};
