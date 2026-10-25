import Counter from "../../models/counter.Model.js";
import HomeOwner from "../../models/homeOwner.Model.js";
import SupportTicket from "../../models/supportTicket.Model.js";
import Worker from "../../models/worker.Model.js";
import { isValidEmail } from "../../utils/auth.utils.js";
import { sendEmail } from "../../services/email.service.js";
import {
  createHomeownerNotification,
  createWorkerNotification,
  notifyAllAdmins,
} from "../../services/notify.js";
import { emitToAdmin, emitToHomeowner, emitToWorker } from "../../services/socket.js";
import { Types } from "mongoose";

const SUPPORT_EMAIL = "trabahome.official@gmail.com";

const escapeText = (value) => {
  const str = String(value || "").trim();
  if (!str) return "";
  return str.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
};

const countWords = (value) => {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length;
};

export const decodeSupportText = (value) => String(value || "")
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'");

const supportRoleForUser = (user) => user?.role === "worker" ? "Worker" : "Homeowner";

const ticketLookup = (identifier) => {
  const value = String(identifier || "").trim();
  if (!value) return null;
  return Types.ObjectId.isValid(value)
    ? { $or: [{ _id: value }, { ticketNumber: value.toUpperCase() }] }
    : { ticketNumber: value.toUpperCase() };
};

const normalizeMessage = (entry) => ({
  id: String(entry?._id || ""),
  senderId: String(entry?.senderId || ""),
  senderRole: entry?.senderRole || "Homeowner",
  message: decodeSupportText(entry?.message),
  createdAt: entry?.createdAt,
});

const supportConversation = (ticket) => {
  const messages = Array.isArray(ticket?.messages)
    ? ticket.messages.map(normalizeMessage)
    : [];
  if (messages.length > 0) return messages;

  // Existing tickets predate the messages array. Their original message is the
  // first conversation entry, so no data migration is needed.
  return [{
    id: `initial-${String(ticket?._id || ticket?.ticketNumber || "message")}`,
    senderId: String(ticket?.userId || ""),
    senderRole: ticket?.role || "Homeowner",
    message: decodeSupportText(ticket?.message),
    createdAt: ticket?.createdAt,
  }];
};

const initializeLegacyConversation = (ticket) => {
  if (Array.isArray(ticket?.messages) && ticket.messages.length > 0) return;
  ticket.messages.push({
    senderId: ticket.userId,
    senderRole: ticket.role || "Homeowner",
    message: ticket.message,
    createdAt: ticket.createdAt,
  });
};

export const normalizeSupportTicket = (ticket, { includeConversation = false } = {}) => ({
  id: String(ticket?._id || ""),
  ticketNumber: ticket?.ticketNumber,
  name: decodeSupportText(ticket?.name),
  email: ticket?.email,
  role: ticket?.role || "Homeowner",
  category: decodeSupportText(ticket?.issueCategory),
  issueCategory: decodeSupportText(ticket?.issueCategory),
  status: ticket?.status,
  createdAt: ticket?.createdAt,
  updatedAt: ticket?.updatedAt,
  ...(includeConversation ? { messages: supportConversation(ticket) } : {}),
});

const findOwnedTicket = (identifier, user) => {
  const lookup = ticketLookup(identifier);
  if (!lookup || !user?.id) return null;
  return SupportTicket.findOne({
    ...lookup,
    userId: user.id,
    role: supportRoleForUser(user),
  });
};

const supportActorMeta = (ticket, avatar = "") => {
  const isWorker = ticket.role === "Worker";
  const role = isWorker ? "worker" : "homeowner";
  return {
    actorId: String(ticket.userId),
    actorRole: role,
    actorName: decodeSupportText(ticket.name),
    actorAvatar: avatar,
    ...(isWorker
      ? {
          workerId: String(ticket.userId),
          workerName: decodeSupportText(ticket.name),
          workerAvatar: avatar,
        }
      : {
          homeownerId: String(ticket.userId),
          homeownerName: decodeSupportText(ticket.name),
          homeownerAvatar: avatar,
        }),
  };
};

const loadTicketUserAvatar = async (ticket) => {
  const Model = ticket.role === "Worker" ? Worker : HomeOwner;
  const account = await Model.findById(ticket.userId)
    .select("avatar profileImage")
    .lean();
  return String(account?.avatar || account?.profileImage || "").trim();
};

const nextTicketNumber = async (role) => {
  const isWorker = role === "Worker";
  const prefix = isWorker ? "HR-L" : "HR-H";
  const counterKey = isWorker ? "support_ticket_worker" : "support_ticket_homeowner";
  const counter = await Counter.findOneAndUpdate(
    { key: counterKey },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const seq = Number(counter?.seq || 0);
  return `${prefix}${String(seq).padStart(6, "0")}`;
};

export const createSupportTicket = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { name, email, issueCategory, message } = req.body || {};
    const role = supportRoleForUser(req.user);
    const bodyName = String(name || "").trim();
    const bodyEmail = String(email || "").trim();
    let resolvedName = bodyName;
    let resolvedEmail = bodyEmail;
    let actorAvatar = "";

    if (role === "Worker") {
      const worker = await Worker.findById(userId)
        .select("firstName lastName email avatar profileImage")
        .lean();
      if (!worker) {
        return res.status(404).json({ success: false, message: "Worker not found." });
      }
      const defaultWorkerName =
        [String(worker.firstName || "").trim(), String(worker.lastName || "").trim()]
          .filter(Boolean)
          .join(" ") || "Worker";
      resolvedName = bodyName || defaultWorkerName;
      resolvedEmail = bodyEmail || worker.email;
      actorAvatar = String(worker.avatar || worker.profileImage || "").trim();
    } else {
      const homeowner = await HomeOwner.findById(userId)
        .select("firstName lastName name email avatar profileImage")
        .lean();
      if (!homeowner) {
        return res.status(404).json({ success: false, message: "Homeowner not found." });
      }
      const defaultHomeownerName =
        [String(homeowner.firstName || "").trim(), String(homeowner.lastName || "").trim()]
          .filter(Boolean)
          .join(" ") || String(homeowner.name || "").trim() || "Homeowner";
      resolvedName = bodyName || defaultHomeownerName;
      resolvedEmail = bodyEmail || homeowner.email;
      actorAvatar = String(homeowner.avatar || homeowner.profileImage || "").trim();
    }

    if (!resolvedName || !String(resolvedName).trim()) {
      return res.status(400).json({ success: false, message: "Name is required." });
    }
    if (!resolvedEmail || !isValidEmail(resolvedEmail)) {
      return res
        .status(400)
        .json({ success: false, message: "Valid email is required." });
    }
    if (!issueCategory || !String(issueCategory).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Issue category is required." });
    }
    if (!message || !String(message).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Message is required." });
    }
    if (countWords(message) > 250) {
      return res.status(400).json({
        success: false,
        message: "Message must be 250 words or fewer.",
      });
    }

    const ticketNumber = await nextTicketNumber(role);

    const safeName = escapeText(resolvedName);
    const safeEmail = String(resolvedEmail).trim().toLowerCase();
    const safeCategory = escapeText(issueCategory);
    const safeMessage = escapeText(message);

    const ticket = await SupportTicket.create({
      ticketNumber,
      userId,
      role,
      name: safeName,
      email: safeEmail,
      issueCategory: safeCategory,
      message: safeMessage,
      messages: [
        {
          senderId: userId,
          senderRole: role,
          message: safeMessage,
        },
        {
          senderId: "system",
          senderRole: "Admin",
          message: "The admin will review the request. Please wait for a reply within 24 hours.",
        },
      ],
      status: "Open",
    });

    // In-app user notification for support auto-reply
    if (role === "Worker") {
      void createWorkerNotification({
        userId,
        title: "Support Request Received",
        message: "The admin will review the request. Please wait for a reply within 24 hours.",
        type: "info",
        meta: {
          ticketId: String(ticket._id || ""),
          ticketNumber,
          route: "/worker-support-history",
        },
      }).catch((err) => console.error("Worker support notification error:", err));
    } else {
      void createHomeownerNotification({
        userId,
        title: "Support Request Received",
        message: "The admin will review the request. Please wait for a reply within 24 hours.",
        type: "info",
        meta: {
          ticketId: String(ticket._id || ""),
          ticketNumber,
          route: "/homeowner-support-history",
        },
      }).catch((err) => console.error("Homeowner support notification error:", err));
    }

    const isUrgentCategory =
      safeCategory.toLowerCase().includes("cancellation") ||
      safeCategory.toLowerCase().includes("dispute") ||
      safeCategory.toLowerCase().includes("booking");

    void notifyAllAdmins({
      title: isUrgentCategory ? "Urgent support ticket" : "New support ticket",
      message: `${safeName} submitted a ${safeCategory} support request (${ticketNumber}).`,
      type: isUrgentCategory ? "warning" : "info",
      meta: {
        route: `/admin-help-requests?ticketId=${encodeURIComponent(String(ticket._id || ""))}`,
        ticketId: String(ticket._id || ""),
        ticketNumber,
        userId,
        ...supportActorMeta(ticket, actorAvatar),
        issueCategory: safeCategory,
      },
    }).catch((error) => console.error("Support admin notification error:", error));

    const normalizedTicket = normalizeSupportTicket(ticket, { includeConversation: true });
    emitToAdmin("support-ticket:created", normalizedTicket);
    emitToAdmin("dashboard:refresh", { source: "support-ticket:created" });
    if (role === "Worker") {
      emitToWorker(userId, "support-ticket:created", normalizedTicket);
    } else {
      emitToHomeowner(userId, "support-ticket:created", normalizedTicket);
    }

    console.info("Support ticket created", {
      ticketNumber,
      userId,
      role,
      email: safeEmail,
      issueCategory: safeCategory,
    });

    if (SUPPORT_EMAIL) {
      const createdAt = ticket.createdAt.toISOString();
      const supportText = [
        `New Support Ticket ${ticketNumber}`,
        `Name: ${safeName}`,
        `Email: ${safeEmail}`,
        `Category: ${safeCategory}`,
        `Message: ${safeMessage}`,
        `Created At: ${createdAt}`,
      ].join("\n");

      const userText = [
        `Thanks for contacting TrabaHome.`,
        `We received your request (${ticketNumber}).`,
        `The admin will review the request. Please wait for a reply within 24 hours.`,
      ].join("\n");

      void Promise.allSettled([
        sendEmail({
          to: SUPPORT_EMAIL,
          subject: `New Support Ticket ${ticketNumber}`,
          text: supportText,
        }),
        sendEmail({
          to: safeEmail,
          subject: `We received your request (${ticketNumber})`,
          text: userText,
        }),
      ]).then((results) => {
        results.forEach((result) => {
          if (result.status === "rejected") {
            console.error("Support email error:", result.reason);
          }
        });
      });
    }

    return res.status(201).json({
      ticketNumber,
      status: ticket.status,
      createdAt: ticket.createdAt.toISOString(),
    });
  } catch (error) {
    console.error("Create support ticket error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal server error.",
    });
  }
};

export const listMySupportTickets = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const tickets = await SupportTicket.find({
      userId,
      role: supportRoleForUser(req.user),
    })
      .select("ticketNumber name email role issueCategory status createdAt updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: tickets.length,
      items: tickets.map((ticket) => normalizeSupportTicket(ticket)),
    });
  } catch (error) {
    console.error("List own support tickets error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const getMySupportTicket = async (req, res) => {
  try {
    const ticket = await findOwnedTicket(req.params.id, req.user);
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }
    return res.status(200).json({
      success: true,
      ticket: normalizeSupportTicket(ticket, { includeConversation: true }),
    });
  } catch (error) {
    console.error("Get own support ticket error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const replyToMySupportTicket = async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message || countWords(message) > 250) {
      return res.status(400).json({
        success: false,
        message: message ? "Message must be 250 words or fewer." : "Message is required.",
      });
    }

    const ticket = await findOwnedTicket(req.params.id, req.user);
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }

    if (ticket.status === "Resolved" || ticket.status === "Closed") {
      return res.status(400).json({
        success: false,
        message: "This support ticket is resolved and closed. No further messages can be sent.",
      });
    }

    initializeLegacyConversation(ticket);
    ticket.messages.push({
      senderId: req.user.id,
      senderRole: supportRoleForUser(req.user),
      message: escapeText(message),
    });
    await ticket.save();

    const actorAvatar = await loadTicketUserAvatar(ticket).catch(() => "");
    void notifyAllAdmins({
      title: "Support ticket reply",
      message: `${decodeSupportText(ticket.name)} replied to ${ticket.ticketNumber}.`,
      type: "info",
      meta: {
        route: `/admin-help-requests?ticketId=${encodeURIComponent(String(ticket._id))}`,
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        ...supportActorMeta(ticket, actorAvatar),
      },
    }).catch((error) => console.error("Support reply admin notification error:", error));

    const normalizedTicket = normalizeSupportTicket(ticket, { includeConversation: true });
    emitToAdmin("support-ticket:updated", normalizedTicket);
    emitToAdmin("dashboard:refresh", { source: "support-ticket:updated" });
    if (ticket.role === "Worker") {
      emitToWorker(ticket.userId, "support-ticket:updated", normalizedTicket);
    } else {
      emitToHomeowner(ticket.userId, "support-ticket:updated", normalizedTicket);
    }

    return res.status(200).json({
      success: true,
      ticket: normalizedTicket,
    });
  } catch (error) {
    console.error("Reply to own support ticket error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const getAdminSupportTicket = async (req, res) => {
  try {
    const lookup = ticketLookup(req.params.id);
    const ticket = lookup ? await SupportTicket.findOne(lookup) : null;
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }
    return res.status(200).json({
      success: true,
      ticket: normalizeSupportTicket(ticket, { includeConversation: true }),
    });
  } catch (error) {
    console.error("Get admin support ticket error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const replyToSupportTicketAsAdmin = async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message || countWords(message) > 250) {
      return res.status(400).json({
        success: false,
        message: message ? "Message must be 250 words or fewer." : "Message is required.",
      });
    }

    const lookup = ticketLookup(req.params.id);
    const ticket = lookup ? await SupportTicket.findOne(lookup) : null;
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }

    if (ticket.status === "Resolved" || ticket.status === "Closed") {
      return res.status(400).json({
        success: false,
        message: "This support ticket is resolved and closed. No further messages can be sent.",
      });
    }

    initializeLegacyConversation(ticket);
    ticket.messages.push({
      senderId: req.user.id,
      senderRole: "Admin",
      message: escapeText(message),
    });
    if (ticket.status === "Open") ticket.status = "In Progress";
    await ticket.save();

    const preview = message.length > 70 ? `${message.slice(0, 70)}...` : message;
    const notification = {
      userId: ticket.userId,
      title: "Support ticket reply",
      message: `Admin replied to your support request (${ticket.ticketNumber}): "${preview}"`,
      type: "info",
      meta: {
        route: ticket.role === "Worker"
          ? `/worker-support-history?ticketId=${encodeURIComponent(String(ticket._id))}`
          : `/homeowner-help?ticketId=${encodeURIComponent(String(ticket._id))}`,
        ticketId: String(ticket._id),
        ticketNumber: ticket.ticketNumber,
        actorId: String(req.user.id),
        actorRole: "admin",
        actorName: "TrabaHome Support",
      },
    };
    const createNotification = ticket.role === "Worker"
      ? createWorkerNotification
      : createHomeownerNotification;
    await createNotification(notification).catch((error) => {
      console.error("Support reply user notification error:", error);
    });

    const normalizedTicket = normalizeSupportTicket(ticket, { includeConversation: true });
    emitToAdmin("support-ticket:updated", normalizedTicket);
    emitToAdmin("dashboard:refresh", { source: "support-ticket:updated" });
    if (ticket.role === "Worker") {
      emitToWorker(ticket.userId, "support-ticket:updated", normalizedTicket);
    } else {
      emitToHomeowner(ticket.userId, "support-ticket:updated", normalizedTicket);
    }

    return res.status(200).json({
      success: true,
      ticket: normalizedTicket,
    });
  } catch (error) {
    console.error("Admin support reply error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
