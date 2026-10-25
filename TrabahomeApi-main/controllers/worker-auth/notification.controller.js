import { Types } from "mongoose";
import Booking from "../../models/booking.Model.js";
import HomeOwner from "../../models/homeOwner.Model.js";
import ServiceRequest from "../../models/serviceRequest.Model.js";
import WorkerNotification from "../../models/WorkerNotification.js";
import { emitToWorker } from "../../services/socket.js";
import { buildNotificationPagePayload, buildWorkerJobRequestNotification, createWorkerNotification, findNotificationPageItems, toNotificationPayload } from "../../services/notify.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const WORKER_NOTIFICATION_SYNC_TTL_MS = 15_000;
const workerNotificationSyncCache = new Map();

const clampLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const encodeCursor = (notification) =>
  `${new Date(notification.createdAt).getTime()}_${notification._id}`;

const decodeCursor = (cursor) => {
  if (!cursor || typeof cursor !== "string") return null;
  const [msPart, idPart] = cursor.split("_");
  const timestamp = Number(msPart);
  if (!Number.isFinite(timestamp)) return null;
  if (!Types.ObjectId.isValid(idPart)) return null;
  return {
    date: new Date(timestamp),
    id: new Types.ObjectId(idPart),
  };
};

const normalizeStatus = (status) => {
  const raw = String(status || "Pending").trim().toUpperCase();
  if (raw === "PENDING") return "PENDING";
  if (raw === "ONGOING" || raw === "ACCEPTED") return "ONGOING";
  if (raw === "IN_PROGRESS" || raw === "IN PROGRESS") return "IN_PROGRESS";
  if (raw === "COMPLETED") return "COMPLETED";
  if (raw === "CANCELLED" || raw === "CANCELED") return "CANCELLED";
  if (raw === "DECLINED") return "DECLINED";
  return raw || "PENDING";
};

const buildPersonName = (person, fallback) =>
  [person?.firstName, person?.lastName].filter(Boolean).join(" ") || person?.name || person?.email || fallback;

const resolveHomeowner = (homeownerRef, homeownerLookup) => {
  if (homeownerRef && typeof homeownerRef === "object" && !Array.isArray(homeownerRef)) {
    return homeownerRef;
  }

  const homeownerId = String(homeownerRef || "").trim();
  return homeownerLookup.get(homeownerId) || {};
};

const buildNotificationPayload = (item, source = "request", homeownerLookup = new Map()) => {
  const id = String(item?.requestNumber || item?.bookingNumber || item?.id || item?._id || "").trim();
  if (!id) return null;

  const status = normalizeStatus(item?.status);
  const cancelledBy = String(item?.cancelledBy || "").trim().toLowerCase();
  if (!status) {
    return null;
  }
  const homeowner = resolveHomeowner(item?.homeownerId, homeownerLookup);
  const homeownerName = buildPersonName(homeowner, "Homeowner");
  const homeownerId = String(item?.homeownerId?._id || item?.homeownerId || "").trim();
  const serviceType = String(item?.serviceType || "service").trim();
  const content = buildWorkerJobRequestNotification({ homeownerName, serviceType }, status);
  if (!content) return null;
  const route = "/worker-jobs";

  return {
    key: `${id}:${content.title}`,
    payload: {
      title: content.title,
      message: content.message,
      type: content.type,
        meta: {
          route,
          requestId: id,
          bookingId: id,
          source,
          status,
          homeownerId,
          homeownerName,
          serviceType,
          homeownerAvatar: String(homeowner?.avatar || homeowner?.profileImage || homeowner?.profilePicture || "").trim(),
          homeownerProfileImage: String(homeowner?.profileImage || homeowner?.profilePicture || homeowner?.avatar || "").trim(),
        },
      },
    };
  };

const syncWorkerTransactionNotifications = async (userId) => {
  if (!userId) return;

  const cacheKey = String(userId);
  const cached = workerNotificationSyncCache.get(cacheKey);
  const now = Date.now();
  if (cached?.promise) {
    return cached.promise;
  }
  if (cached && now - cached.lastSyncAt < WORKER_NOTIFICATION_SYNC_TTL_MS) {
    return;
  }

  const syncPromise = (async () => {
    const [existingNotifications, serviceRequests, bookings] = await Promise.all([
      WorkerNotification.find({ userId }).select("title message type meta createdAt readAt").lean(),
      ServiceRequest.find({
        targetWorkerId: userId,
        status: { $in: ["PENDING", "ONGOING", "COMPLETED", "DECLINED", "CANCELLED"] },
      })
        .select("requestNumber homeownerId status cancelledBy serviceType createdAt updatedAt completedOn acceptedOn")
        .sort({ createdAt: -1 })
        .lean(),
      Booking.find({
        workerId: userId,
        status: { $in: ["Pending", "Accepted", "In Progress", "Completed", "Cancelled", "Declined"] },
      })
        .select("bookingNumber homeownerId status cancelledBy serviceType createdAt updatedAt completedOn acceptedOn")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const homeownerIds = [...new Set(
      [...serviceRequests, ...bookings]
        .map((item) => String(item?.homeownerId || "").trim())
        .filter(Boolean)
    )];

    const homeowners = homeownerIds.length
      ? await HomeOwner.find({ _id: { $in: homeownerIds } })
          .select("firstName lastName name email avatar profileImage profilePicture")
          .lean()
      : [];
    const homeownerById = new Map(homeowners.map((homeowner) => [String(homeowner._id), homeowner]));

    const existingBySourceId = new Map(
      existingNotifications.map((notification) => {
        const meta = notification?.meta || {};
        const sourceId = String(meta.requestId || meta.bookingId || notification?._id || "").trim();
        return [sourceId, notification];
      })
    );

    const itemsToSync = [
      ...serviceRequests.map((item) => buildNotificationPayload(item, "service-request", homeownerById)),
      ...bookings.map((item) => buildNotificationPayload(item, "booking", homeownerById)),
    ].filter(Boolean);

    for (const entry of itemsToSync) {
      const sourceId = String(entry.payload.meta.requestId || entry.payload.meta.bookingId || "").trim();
      const existing = existingBySourceId.get(sourceId);
      if (existing) {
        const existingMeta = existing?.meta || {};
        const nextMeta = {
          ...existingMeta,
          ...entry.payload.meta,
        };
        const existingTitle = String(existing?.title || "").trim();
        const existingMessage = String(existing?.message || "").trim();
        const shouldUpdate =
          existingTitle !== entry.payload.title ||
          existingMessage !== entry.payload.message ||
          JSON.stringify(existingMeta || {}) !== JSON.stringify(nextMeta || {});
        if (shouldUpdate) {
          await WorkerNotification.findByIdAndUpdate(existing._id, {
            title: entry.payload.title,
            message: entry.payload.message,
            type: entry.payload.type,
            meta: nextMeta,
          });
        }
        continue;
      }

      await createWorkerNotification({
        userId,
        title: entry.payload.title,
        message: entry.payload.message,
        type: entry.payload.type,
        meta: entry.payload.meta,
      });
    }
  })();

  workerNotificationSyncCache.set(cacheKey, {
    promise: syncPromise,
    lastSyncAt: cached?.lastSyncAt || 0,
  });

  try {
    await syncPromise;
    workerNotificationSyncCache.set(cacheKey, {
      lastSyncAt: Date.now(),
    });
  } catch (error) {
    workerNotificationSyncCache.delete(cacheKey);
    throw error;
  }
};

export const getWorkerNotifications = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    // Current request and booking write paths create notifications directly.
    // Keep the legacy reconciliation available for manual recovery without
    // repeating several transaction queries on every notification poll.
    const shouldSyncTransactions = ["1", "true"].includes(
      String(req.query.syncTransactions || "").trim().toLowerCase()
    );
    if (shouldSyncTransactions) {
      await syncWorkerTransactionNotifications(userId);
    }

    const limit = clampLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const ownerQuery = { userId: new Types.ObjectId(String(userId)) };
    const query = { ...ownerQuery };
    if (cursor) {
      query.$or = [
        { createdAt: { $lt: cursor.date } },
        { createdAt: cursor.date, _id: { $lt: cursor.id } },
      ];
    }

    const [items, unreadCount] = await Promise.all([
      findNotificationPageItems(WorkerNotification, query, limit),
      WorkerNotification.countDocuments({ ...ownerQuery, readAt: null }),
    ]);

    const visibleItems = items;

    const nextCursor =
      visibleItems.length === limit ? encodeCursor(visibleItems[visibleItems.length - 1]) : null;
    const page = await buildNotificationPagePayload(visibleItems, { recipientRole: "worker" });
    return res.status(200).json({
      items: page.items,
      actors: page.actors,
      nextCursor,
      unreadCount,
    });
  } catch (error) {
    console.error("Get worker notifications error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const markWorkerNotificationRead = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }

    const now = new Date();
    const updated = await WorkerNotification.findOneAndUpdate(
      { _id: id, userId, readAt: null },
      { $set: { readAt: now } },
      { new: true }
    ).lean();

    if (updated) {
      emitToWorker(userId, "notification:read", {
        id: String(updated._id),
        readAt: updated.readAt,
      });

      return res.status(200).json({
        success: true,
        item: toNotificationPayload(updated, { recipientRole: "worker" }),
      });
    }

    const existing = await WorkerNotification.findOne({ _id: id, userId }).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found." });
    }

    return res.status(200).json({
      success: true,
      item: toNotificationPayload(existing, { recipientRole: "worker" }),
    });
  } catch (error) {
    console.error("Read worker notification error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const markWorkerNotificationsReadAll = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const now = new Date();
    await WorkerNotification.updateMany(
      { userId, readAt: null },
      { $set: { readAt: now } }
    );

    emitToWorker(userId, "notification:read", {
      all: true,
      readAt: now,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Read all worker notifications error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
