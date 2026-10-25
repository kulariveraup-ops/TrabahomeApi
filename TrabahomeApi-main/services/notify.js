import { Types } from "mongoose";
import Notification from "../models/Notification.js";
import Admin from "../models/admin.Model.js";
import AdminNotification from "../models/adminNotification.Model.js";
import HomeOwner from "../models/homeOwner.Model.js";
import Worker from "../models/worker.Model.js";
import WorkerNotification from "../models/WorkerNotification.js";
import { emitToAdmin, emitToHomeowner, emitToWorker } from "./socket.js";

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const MAX_NOTIFICATIONS_PER_USER = toPositiveInt(
  process.env.NOTIF_MAX_PER_USER,
  50
);

const buildPersonName = (person, fallback) =>
  [person?.firstName, person?.lastName].filter(Boolean).join(" ") || person?.name || person?.email || fallback;

const isPublicImageUrl = (value) => {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.startsWith("data:image/") && s.length > 50000) return false;
  return /^(https?:\/\/|\/|blob:|data:image\/)/i.test(s);
};

const resolveNotificationImage = (...values) => {
  for (const value of values) {
    const candidate = String(value || "").trim();
    if (candidate && isPublicImageUrl(candidate)) {
      return candidate;
    }
  }
  return "";
};

const normalizeActorRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  if (role === "homeowner" || role === "homeowners") return "homeowner";
  if (role === "worker" || role === "workers") return "worker";
  if (role === "admin" || role === "admins") return "admin";
  return "";
};

const getNotificationActorReference = (notification, recipientRole = "") => {
  const meta = notification?.meta ?? {};
  const explicitRole = normalizeActorRole(meta.actorRole || meta.senderRole || notification?.actorRole);
  const explicitId = String(meta.actorId || meta.senderId || notification?.actorId || "").trim();
  const explicitName = String(meta.actorName || meta.senderName || notification?.actorName || "").trim();
  const explicitAvatar = resolveNotificationImage(
    meta.actorAvatar,
    meta.actorProfileImage,
    meta.senderAvatar,
    notification?.actorAvatar
  );

  const homeowner = {
    role: "homeowner",
    id: String(meta.homeownerId || notification?.homeownerId || "").trim(),
    name: String(meta.homeownerName || notification?.homeownerName || "").trim(),
    avatar: resolveNotificationImage(
      meta.homeownerAvatar,
      meta.homeownerProfileImage,
      meta.homeownerProfilePicture,
      meta.homeownerImage
    ),
  };
  const worker = {
    role: "worker",
    id: String(meta.workerId || notification?.workerId || "").trim(),
    name: String(meta.workerName || notification?.workerName || "").trim(),
    avatar: resolveNotificationImage(
      meta.workerAvatar,
      meta.workerProfileImage,
      meta.workerProfilePicture,
      meta.workerImage
    ),
  };

  if (explicitRole) {
    const roleFallback = explicitRole === "worker" ? worker : explicitRole === "homeowner" ? homeowner : null;
    return {
      role: explicitRole,
      id: explicitId || roleFallback?.id || "",
      name: explicitName || roleFallback?.name || "",
      avatar: explicitAvatar || roleFallback?.avatar || "",
    };
  }

  const normalizedRecipientRole = normalizeActorRole(recipientRole);
  if (normalizedRecipientRole === "homeowner" && (worker.id || worker.name || worker.avatar)) return worker;
  if (normalizedRecipientRole === "worker" && (homeowner.id || homeowner.name || homeowner.avatar)) return homeowner;

  if (normalizedRecipientRole === "admin") {
    if (homeowner.id || homeowner.name || homeowner.avatar) return homeowner;
    if (worker.id || worker.name || worker.avatar) return worker;

    const relatedUserId = String(meta.userId || "").trim();
    if (relatedUserId) {
      return {
        role: "homeowner",
        id: relatedUserId,
        name: explicitName,
        avatar: explicitAvatar,
      };
    }
  }

  if (explicitId || explicitName || explicitAvatar) {
    return {
      role: explicitRole,
      id: explicitId,
      name: explicitName,
      avatar: explicitAvatar,
    };
  }

  return { role: "", id: "", name: "", avatar: "" };
};

const sanitizeNotificationValue = (value, key = "") => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNotificationValue(item, key));
  }

  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    if (/avatar|profileImage|photoUrl|image$/i.test(String(key))) {
      return isPublicImageUrl(value) ? value.trim() : "";
    }
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeNotificationValue(entryValue, entryKey),
    ])
  );
};

const stripNotificationImages = (value) => {
  if (Array.isArray(value)) {
    return value.map(stripNotificationImages);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/avatar|profileImage|profilePicture|photoUrl|image|photo|picture/i.test(key))
      .map(([key, entryValue]) => [key, stripNotificationImages(entryValue)])
  );
};

const notificationImageExclusions = [
  "-meta.actorAvatar",
  "-meta.actorProfileImage",
  "-meta.senderAvatar",
  "-meta.homeownerAvatar",
  "-meta.homeownerProfileImage",
  "-meta.homeownerProfilePicture",
  "-meta.homeownerImage",
  "-meta.workerAvatar",
  "-meta.workerProfileImage",
  "-meta.workerProfilePicture",
  "-meta.workerImage",
  "-meta.profileImage",
  "-meta.photoUrl",
  "-meta.image",
  "-meta.photo",
  "-meta.picture",
].join(" ");

export const findNotificationPageItems = async (Model, query, limit) => {
  const startedAt = performance.now();
  const items = await Model.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .select(notificationImageExclusions)
    .lean();
  console.info(`[PERF] notification-list model=${Model.modelName} mongo=${(performance.now() - startedAt).toFixed(1)}ms count=${items.length}`);
  return items;
};

export const buildNotificationPagePayload = async (notifications, { recipientRole = "" } = {}) => {
  const startedAt = performance.now();
  const references = notifications.map((notification) =>
    getNotificationActorReference(notification, recipientRole)
  );
  const workerIds = [...new Set(
    references.filter((actor) => actor.role === "worker" && actor.id).map((actor) => actor.id)
  )];
  const homeownerIds = [...new Set(
    references.filter((actor) => actor.role === "homeowner" && actor.id).map((actor) => actor.id)
  )];
  const validWorkerObjectIds = workerIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const validHomeownerObjectIds = homeownerIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));

  const [workers, homeowners] = await Promise.all([
    validWorkerObjectIds.length
      ? Worker.aggregate([
          { $match: { _id: { $in: validWorkerObjectIds } } },
          {
            $project: {
              firstName: 1,
              lastName: 1,
              name: 1,
              email: 1,
              avatar: {
                $cond: [
                  { $and: [
                      { $gt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 0] },
                      { $lt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 50000] }
                    ]
                  },
                  "$avatar",
                  {
                    $cond: [
                      { $and: [
                          { $gt: [{ $strLenCP: { $ifNull: ["$profileImage", ""] } }, 0] },
                          { $lt: [{ $strLenCP: { $ifNull: ["$profileImage", ""] } }, 50000] }
                        ]
                      },
                      "$profileImage",
                      ""
                    ]
                  }
                ]
              }
            }
          }
        ])
      : Promise.resolve([]),
    validHomeownerObjectIds.length
      ? HomeOwner.aggregate([
          { $match: { _id: { $in: validHomeownerObjectIds } } },
          {
            $project: {
              firstName: 1,
              lastName: 1,
              name: 1,
              email: 1,
              avatar: {
                $cond: [
                  { $and: [
                      { $gt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 0] },
                      { $lt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 50000] }
                    ]
                  },
                  "$avatar",
                  {
                    $cond: [
                      { $and: [
                          { $gt: [{ $strLenCP: { $ifNull: ["$profileImage", ""] } }, 0] },
                          { $lt: [{ $strLenCP: { $ifNull: ["$profileImage", ""] } }, 50000] }
                        ]
                      },
                      "$profileImage",
                      ""
                    ]
                  }
                ]
              }
            }
          }
        ])
      : Promise.resolve([]),
  ]);
  const accountsDoneAt = performance.now();
  const accountByActor = new Map([
    ...workers.map((account) => [`worker:${account._id}`, account]),
    ...homeowners.map((account) => [`homeowner:${account._id}`, account]),
  ]);
  const actors = [];
  const seenActors = new Set();

  references.forEach((reference) => {
    const key = `${reference.role}:${reference.id}`;
    if (!reference.role || !reference.id || seenActors.has(key)) return;
    const account = accountByActor.get(key);
    seenActors.add(key);
    actors.push({
      id: reference.id,
      role: reference.role,
      name: reference.name || buildPersonName(account, reference.role === "worker" ? "Worker" : "Homeowner"),
      avatar: resolveNotificationImage(
        account?.avatar,
        account?.profileImage,
        account?.profilePicture,
        account?.photoUrl,
        account?.image,
        account?.photo,
        account?.picture
      ),
    });
  });

  const payload = {
    items: notifications.map((notification) => toNotificationPayload(notification, { recipientRole })),
    actors,
  };
  console.info(`[PERF] notification-actors role=${recipientRole} mongo=${(accountsDoneAt - startedAt).toFixed(1)}ms total=${(performance.now() - startedAt).toFixed(1)}ms actors=${actors.length}`);
  return payload;
};

export const buildWorkerJobRequestNotification = (meta = {}, statusOverride = "Pending") => {
  const status = String(statusOverride || meta?.status || "Pending").trim();
  const homeownerName = String(meta?.homeownerName || meta?.senderName || meta?.workerName || "").trim();
  const serviceType = String(meta?.serviceType || meta?.jobType || meta?.title || "service").trim();
  const displayService = serviceType || "service";
  const normalizedStatus = status.toUpperCase();

  if (normalizedStatus === "PENDING") {
    return {
      title: homeownerName ? `Request from ${homeownerName}` : "New job request",
      message: homeownerName
        ? `${homeownerName} sent you a ${displayService} request.`
        : `You have a new ${displayService} request.`,
      type: "info",
    };
  }

  if (normalizedStatus === "ACCEPTED" || normalizedStatus === "ONGOING" || normalizedStatus === "IN_PROGRESS") {
    return {
      title: "Request accepted",
      message: homeownerName
        ? `You accepted the ${displayService} request from ${homeownerName}.`
        : `You accepted the ${displayService} request.`,
      type: "success",
    };
  }

  if (normalizedStatus === "COMPLETED") {
    return {
      title: "Job completed",
      message: homeownerName
        ? `You marked the ${displayService} request from ${homeownerName} as completed.`
        : `You marked the ${displayService} request as completed.`,
      type: "success",
    };
  }

  if (normalizedStatus === "DECLINED") {
    return {
      title: "Request declined",
      message: homeownerName
        ? `You declined the ${displayService} request from ${homeownerName}.`
        : `You declined the ${displayService} request.`,
      type: "warning",
    };
  }

  if (normalizedStatus === "CANCELLED" || normalizedStatus === "CANCELED") {
    const cancelledBy = meta?.cancelledBy;
    const reason = meta?.declineReason || meta?.cancelReason || "";
    if (cancelledBy === "admin") {
      return {
        title: "Booking cancelled by admin",
        message: reason
          ? `The administrator cancelled the ${displayService} booking. Reason: ${reason}`
          : `The administrator cancelled the ${displayService} booking.`,
        type: "warning",
      };
    }
    return {
      title: homeownerName ? `Cancelled by ${homeownerName}` : "Request cancelled",
      message: reason
        ? `${homeownerName || "Homeowner"} cancelled the ${displayService} request. Reason: ${reason}`
        : `${homeownerName || "Homeowner"} cancelled the ${displayService} request.`,
      type: "warning",
    };
  }

  return {
    title: status ? `${displayService} update` : "Job update",
    message: status
      ? `Your ${displayService} request status changed to ${status.toLowerCase()}.`
      : `Your ${displayService} request was updated.`,
    type: "info",
  };
};

const buildHomeownerBookingNotification = (status = "", meta = {}) => {
  const rawStatus = String(status || meta?.status || "").trim();
  const normalizedStatus = rawStatus.toUpperCase();
  const workerName = String(meta?.workerName || meta?.senderName || "").trim();
  const serviceType = String(meta?.serviceType || meta?.jobType || "service").trim();
  const displayService = serviceType || "service";

  if (normalizedStatus === "PENDING") {
    return {
      title: "Request received",
      message: `Your ${displayService} request has been received.`,
      type: "info",
    };
  }

  if (normalizedStatus === "ACCEPTED" || normalizedStatus === "ONGOING" || normalizedStatus === "IN_PROGRESS") {
    return {
      title: "Request accepted",
      message: workerName
        ? `${workerName} accepted your ${displayService} request.`
        : `Your ${displayService} request has been accepted.`,
      type: "success",
    };
  }

  if (normalizedStatus === "COMPLETED") {
    return {
      title: "Job Completed - Review Required",
      message: workerName
        ? `${workerName} has marked your ${displayService} request as completed. Please leave a review to share your feedback and complete the service.`
        : `Your ${displayService} request has been marked as completed. Please leave a review to complete the service.`,
      type: "success",
    };
  }

  if (normalizedStatus === "DECLINED") {
    const reason = meta?.declineReason ? ` Reason: ${meta.declineReason}` : "";
    return {
      title: "Request declined",
      message: workerName
        ? `${workerName} declined your ${displayService} request.${reason}`
        : `Your ${displayService} request was declined.${reason}`,
      type: "warning",
    };
  }

  if (normalizedStatus === "CANCELLED" || normalizedStatus === "CANCELED") {
    const cancelledBy = meta?.cancelledBy;
    const reason = meta?.declineReason || meta?.cancelReason ? ` Reason: ${meta.declineReason || meta.cancelReason}` : "";
    if (cancelledBy === "admin") {
      return {
        title: "Booking cancelled by admin",
        message: `The administrator cancelled your ${displayService} booking.${reason}`,
        type: "warning",
      };
    }
    return {
      title: "Request cancelled",
      message: workerName
        ? `${workerName} cancelled your ${displayService} request.${reason}`
        : `Your ${displayService} request was cancelled.${reason}`,
      type: "warning",
    };
  }

  return {
    title: "Booking update",
    message: rawStatus
      ? `Your ${displayService} request was updated to ${rawStatus.toLowerCase()}.`
      : `Your ${displayService} request was updated.`,
    type: "info",
  };
};

export const toNotificationPayload = (notification, { recipientRole = "" } = {}) => {
  if (!notification) return null;
  const meta = notification.meta ?? {};
  const actor = getNotificationActorReference(notification, recipientRole);
  return {
    id: String(notification._id),
    title: notification.title,
    message: notification.message,
    type: notification.type,
    createdAt: notification.createdAt,
    readAt: notification.readAt || null,
    route: String(meta.route || notification.route || "").trim(),
    requestId: String(meta.requestId || notification.requestId || "").trim(),
    bookingId: String(meta.bookingId || notification.bookingId || "").trim(),
    homeownerId: String(meta.homeownerId || notification.homeownerId || "").trim(),
    homeownerName: String(meta.homeownerName || meta.senderName || notification.homeownerName || "").trim(),
    workerId: String(meta.workerId || notification.workerId || "").trim(),
    workerName: String(meta.workerName || notification.workerName || "").trim(),
    senderName: String(meta.senderName || meta.homeownerName || meta.workerName || notification.senderName || "").trim(),
    actorId: actor.id,
    actorRole: actor.role,
    actorName: actor.name,
    actorAvatar: actor.avatar,
    meta: notification.meta ? stripNotificationImages(notification.meta) : null,
  };
};

const trimNotificationsForUser = async (model, userId) => {
  if (!model || !userId || MAX_NOTIFICATIONS_PER_USER <= 0) return;

  const excess = await model.find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .skip(MAX_NOTIFICATIONS_PER_USER)
    .select("_id")
    .lean();

  if (excess.length === 0) return;

  await model.deleteMany({
    _id: { $in: excess.map((item) => item._id) },
  });
};

export const createHomeownerNotification = async ({
  userId,
  title,
  message,
  type = "info",
  meta = null,
}) => {
  const notification = await Notification.create({
    userId,
    title,
    message,
    type,
    meta: sanitizeNotificationValue(meta),
  });

  const payload = toNotificationPayload(notification, { recipientRole: "homeowner" });
  if (payload) {
    emitToHomeowner(userId, "notification:new", payload);
  }

  await trimNotificationsForUser(Notification, userId);

  return notification;
};

export const createWorkerNotification = async ({
  userId,
  title,
  message,
  type = "info",
  meta = null,
}) => {
  const notification = await WorkerNotification.create({
    userId,
    title,
    message,
    type,
    meta: sanitizeNotificationValue(meta),
  });

  const payload = toNotificationPayload(notification, { recipientRole: "worker" });
  if (payload) {
    emitToWorker(userId, "notification:new", payload);
  }

  await trimNotificationsForUser(WorkerNotification, userId);

  return notification;
};

export const createAdminNotification = async ({
  adminId,
  title,
  message,
  type = "info",
  meta = null,
}) => {
  const notification = await AdminNotification.create({
    adminId,
    title,
    message,
    type,
    meta: sanitizeNotificationValue(meta),
  });

  const payload = toNotificationPayload(notification, { recipientRole: "admin" });
  if (payload) {
    emitToAdmin("notification:new", payload);
  }

  return notification;
};

export const notifyAllAdmins = async ({ title, message, type = "info", meta = null }) => {
  const admins = await Admin.find().select("_id").lean();
  const notifications = await Promise.all(
    admins.map((admin) =>
      createAdminNotification({
        adminId: admin._id,
        title,
        message,
        type,
        meta,
      })
    )
  );

  return notifications;
};

export const notifyRequestAccepted = (userId, meta = {}) =>
  createHomeownerNotification({
    userId,
    title: "Request accepted",
    message: "Your request has been accepted.",
    type: "success",
    meta,
  });

export const notifyWorkerMatchFound = (userId, meta = {}) =>
  createHomeownerNotification({
    userId,
    title: "New worker match",
    message: "New worker match found near you.",
    type: "info",
    meta,
  });

export const notifyProfileIncomplete = (userId, meta = {}) =>
  createHomeownerNotification({
    userId,
    title: "Profile incomplete",
    message: "Incomplete profile details. Please update.",
    type: "warning",
    meta,
  });

export const notifyPaymentConfirmed = (userId, meta = {}) =>
  createHomeownerNotification({
    userId,
    title: "Payment confirmed",
    message: "Your payment has been confirmed.",
    type: "success",
    meta,
  });

export const notifyBookingStatus = (userId, status, meta = {}) => {
  const content = buildHomeownerBookingNotification(status, meta);
  return createHomeownerNotification({
    userId,
    title: content.title,
    message: content.message,
    type: content.type,
    meta: {
      ...sanitizeNotificationValue(meta),
      status: String(status || meta?.status || ""),
    },
  });
};

export const notifyWorkerJobRequest = (userId, meta = {}) =>
  createWorkerNotification({
    userId,
    ...buildWorkerJobRequestNotification(meta, "Pending"),
    meta: {
      ...sanitizeNotificationValue(meta),
      status: "Pending",
    },
  });

export const notifyWorkerJobStatus = (userId, status, meta = {}) =>
  createWorkerNotification({
    userId,
    ...buildWorkerJobRequestNotification(meta, status),
    meta: {
      ...sanitizeNotificationValue(meta),
      status: String(status || meta?.status || ""),
    },
  });

export const notifyWorkerJobAccepted = (userId, meta = {}) =>
  notifyWorkerJobStatus(userId, "ACCEPTED", meta);

export const notifyWorkerJobCancelled = (userId, meta = {}) =>
  notifyWorkerJobStatus(userId, "CANCELLED", meta);

export const notifyWorkerJobCompleted = (userId, meta = {}) =>
  notifyWorkerJobStatus(userId, "COMPLETED", meta);

export const notifyWorkerPaymentConfirmed = (userId, meta = {}) =>
  createWorkerNotification({
    userId,
    title: "Payment confirmed",
    message: "Your payment has been confirmed.",
    type: "success",
    meta,
  });

export const notifyWorkerProfileIncomplete = (userId, meta = {}) =>
  createWorkerNotification({
    userId,
    title: "Profile incomplete",
    message: "Profile incomplete. Please update or verify.",
    type: "warning",
    meta,
  });

export const notifyWorkerReviewReceived = (userId, meta = {}) => {
  const homeownerName = meta?.homeownerName || "A homeowner";
  const rating = meta?.rating ? `${meta.rating}-star ` : "";
  const comment = meta?.reviewText ? `: "${meta.reviewText.slice(0, 60)}${meta.reviewText.length > 60 ? '...' : ''}"` : ".";
  return createWorkerNotification({
    userId,
    title: "New review received",
    message: `${homeownerName} left a ${rating}review on your ${meta?.serviceType || "service"} job${comment}`,
    type: "success",
    meta,
  });
};

export const notifyAdminReviewReceived = (meta = {}) => {
  const homeownerName = meta?.homeownerName || "A homeowner";
  const workerName = meta?.workerName || "a worker";
  const rating = Number(meta?.rating) || 5;
  const isLowRating = rating <= 2;
  return notifyAllAdmins({
    title: isLowRating ? "Low Rating Alert" : "New review submitted",
    message: isLowRating
      ? `Dispute Alert: ${homeownerName} gave a ${rating}-star rating to ${workerName} on booking #${meta?.requestNumber || meta?.requestId || ""}.`
      : `${homeownerName} submitted a ${rating}-star review for ${workerName}.`,
    type: isLowRating ? "warning" : "info",
    meta: {
      ...meta,
      route: `/admin-requests?requestId=${encodeURIComponent(meta?.requestId || "")}`,
    },
  });
};

export const notifyAdminWorkerRegistered = (adminId, meta = {}) =>
  notifyAllAdmins({
    title: "New worker registration",
    message: "A new worker is waiting for admin review.",
    type: "info",
    meta,
  });

export const notifyAdminWorkerStatusUpdated = (adminId, status, meta = {}) =>
  notifyAllAdmins({
    title: "Worker status updated",
    message: `A worker status was updated to ${String(status || "").toLowerCase()}.`,
    type: String(status || "").toLowerCase() === "verified" ? "success" : "info",
    meta,
  });
