import { Types } from "mongoose";
import Notification from "../../models/Notification.js";
import { emitToHomeowner } from "../../services/socket.js";
import { buildNotificationPagePayload, findNotificationPageItems, toNotificationPayload } from "../../services/notify.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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

export const getHomeownerNotifications = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
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
      findNotificationPageItems(Notification, query, limit),
      Notification.countDocuments({ ...ownerQuery, readAt: null }),
    ]);

    const nextCursor =
      items.length === limit ? encodeCursor(items[items.length - 1]) : null;
    const page = await buildNotificationPagePayload(items, { recipientRole: "homeowner" });
    return res.status(200).json({
      items: page.items,
      actors: page.actors,
      nextCursor,
      unreadCount,
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const markHomeownerNotificationRead = async (req, res) => {
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
    const updated = await Notification.findOneAndUpdate(
      { _id: id, userId, readAt: null },
      { $set: { readAt: now } },
      { new: true }
    ).lean();

    if (updated) {
      emitToHomeowner(userId, "notification:read", {
        id: String(updated._id),
        readAt: updated.readAt,
      });

      return res.status(200).json({
        success: true,
        item: toNotificationPayload(updated, { recipientRole: "homeowner" }),
      });
    }

    const existing = await Notification.findOne({ _id: id, userId }).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Not found." });
    }

    return res.status(200).json({
      success: true,
      item: toNotificationPayload(existing, { recipientRole: "homeowner" }),
    });
  } catch (error) {
    console.error("Read notification error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const markHomeownerNotificationsReadAll = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const now = new Date();
    await Notification.updateMany(
      { userId, readAt: null },
      { $set: { readAt: now } }
    );

    emitToHomeowner(userId, "notification:read", {
      all: true,
      readAt: now,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Read all notifications error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
