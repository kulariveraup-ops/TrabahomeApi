import { Types } from "mongoose";
import AdminNotification from "../../models/adminNotification.Model.js";
import { buildNotificationPagePayload, findNotificationPageItems, toNotificationPayload } from "../../services/notify.js";

const encodeCursor = (notification) =>
  `${new Date(notification.createdAt).getTime()}_${notification._id}`;

const decodeCursor = (cursor) => {
  if (!cursor || typeof cursor !== "string") return null;
  const [msPart, idPart] = cursor.split("_");
  const timestamp = Number(msPart);
  if (!Number.isFinite(timestamp) || !Types.ObjectId.isValid(idPart)) return null;
  return { date: new Date(timestamp), id: new Types.ObjectId(idPart) };
};

export const getAdminNotifications = async (req, res) => {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const unreadOnly = String(req.query.unreadOnly || "").toLowerCase() === "true";
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const cursor = decodeCursor(req.query.cursor);
    const ownerQuery = { adminId: new Types.ObjectId(String(adminId)) };
    const itemQuery = { ...ownerQuery };
    if (unreadOnly) itemQuery.readAt = null;
    if (cursor) {
      itemQuery.$or = [
        { createdAt: { $lt: cursor.date } },
        { createdAt: cursor.date, _id: { $lt: cursor.id } },
      ];
    }

    const [items, unreadCount] = await Promise.all([
      findNotificationPageItems(AdminNotification, itemQuery, limit),
      AdminNotification.countDocuments({ ...ownerQuery, readAt: null }),
    ]);
    const nextCursor = items.length === limit ? encodeCursor(items[items.length - 1]) : null;
    const page = await buildNotificationPagePayload(items, { recipientRole: "admin" });
    return res.status(200).json({
      success: true,
      unreadCount,
      nextCursor,
      actors: page.actors,
      items: page.items.map((item, index) => ({
        ...item,
        cursor: encodeCursor(items[index]),
      })),
    });
  } catch (error) {
    console.error("Get admin notifications error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const markAdminNotificationRead = async (req, res) => {
  try {
    const adminId = req.user?.id;
    const { id } = req.params;
    if (!adminId || !id) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const updated = await AdminNotification.findOneAndUpdate(
      { _id: id, adminId },
      { $set: { readAt: new Date() } },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }

    return res.status(200).json({
      success: true,
      item: toNotificationPayload(updated, { recipientRole: "admin" }),
    });
  } catch (error) {
    console.error("Read admin notification error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const markAdminNotificationsReadAll = async (req, res) => {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const readAt = new Date();
    await AdminNotification.updateMany(
      { adminId, readAt: null },
      { $set: { readAt } }
    );

    return res.status(200).json({
      success: true,
      readAt,
    });
  } catch (error) {
    console.error("Read all admin notifications error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
