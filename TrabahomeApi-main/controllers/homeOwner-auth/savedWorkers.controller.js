import { Types } from "mongoose";
import SavedWorker from "../../models/savedWorker.Model.js";
import Worker from "../../models/worker.Model.js";
import Booking from "../../models/Booking.js";
import { attachWorkerRatingStats } from "../../services/workerRating.service.js";

const SAVED_WORKERS_CACHE_TTL_MS = 5_000;
const savedWorkersCache = new Map();

const invalidateSavedWorkersCache = (homeownerId) => {
  if (homeownerId) savedWorkersCache.delete(String(homeownerId));
};

const availabilityRank = {
  "Available Now": 0,
  Busy: 1,
  Offline: 2,
};

const normalizeAvailability = (value) => {
  if (!value) return null;
  const raw = String(value).toLowerCase();
  if (raw.includes("available")) return "Available Now";
  if (raw.includes("busy")) return "Busy";
  if (raw.includes("offline") || raw.includes("inactive")) return "Offline";
  return null;
};

const computeAvailability = (worker) => {
  const direct = normalizeAvailability(worker?.availability || worker?.status);
  if (direct) return direct;

  if (worker?.isAvailable === true) return "Available Now";
  if (worker?.isAvailable === false) return "Busy";

  if (worker?.lastActiveAt) {
    const lastActive = new Date(worker.lastActiveAt);
    if (!Number.isNaN(lastActive.getTime())) {
      const diffMinutes = (Date.now() - lastActive.getTime()) / 60000;
      if (diffMinutes <= 10) return "Available Now";
      if (diffMinutes <= 120) return "Busy";
      return "Offline";
    }
  }

  return "Offline";
};

const buildWorkerName = (worker) => {
  const first = worker?.firstName ? String(worker.firstName).trim() : "";
  const last = worker?.lastName ? String(worker.lastName).trim() : "";
  return [first, last].filter(Boolean).join(" ");
};

const buildLocation = (worker) => {
  const barangay = worker?.barangay ? String(worker.barangay).trim() : "";
  const city = worker?.city ? String(worker.city).trim() : "";
  if (barangay && city) return `${barangay}, ${city}`;
  return barangay || city || "";
};

const getWorkerRating = (worker) => {
  const value = Number(worker?.rating);
  return Number.isFinite(value) ? value : 0;
};

export const toggleSavedWorker = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    const { workerId } = req.params;

    if (!homeownerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    if (!Types.ObjectId.isValid(workerId)) {
      return res.status(400).json({ success: false, message: "Invalid worker id." });
    }

    const worker = await Worker.findById(workerId).select("_id");
    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    const existing = await SavedWorker.findOne({ homeownerId, workerId });
    if (existing) {
      await SavedWorker.deleteOne({ _id: existing._id });
      invalidateSavedWorkersCache(homeownerId);
      return res.status(200).json({ saved: false });
    }

    await SavedWorker.create({ homeownerId, workerId });
    invalidateSavedWorkersCache(homeownerId);
    return res.status(200).json({ saved: true });
  } catch (error) {
    console.error("Toggle saved worker error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const deleteSavedWorker = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    const { workerId } = req.params;

    if (!homeownerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    if (!Types.ObjectId.isValid(workerId)) {
      return res.status(400).json({ success: false, message: "Invalid worker id." });
    }

    await SavedWorker.deleteOne({ homeownerId, workerId });
    invalidateSavedWorkersCache(homeownerId);
    return res.status(200).json({ saved: false });
  } catch (error) {
    console.error("Delete saved worker error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const listSavedWorkers = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    if (!homeownerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const cached = savedWorkersCache.get(String(homeownerId));
    if (cached && Date.now() - cached.createdAt < SAVED_WORKERS_CACHE_TTL_MS) {
      return res.status(200).json({ items: cached.items });
    }

    const sort = String(req.query.sort || "recent").toLowerCase();

    const saved = await SavedWorker.find({ homeownerId })
      .sort({ createdAt: -1, _id: -1 })
      .select("workerId createdAt")
      .populate({
        path: "workerId",
        match: { $or: [{ status: "Verified" }, { isVerified: true }] },
        select: "firstName lastName name email profession city barangay rating avatar profileImage status isVerified isAvailable lastActiveAt",
      })
      .lean();

    const workerIds = saved
      .map((entry) => entry.workerId?._id)
      .filter((id) => id)
      .map((id) => String(id));

    let workedBeforeSet = new Set();
    if (workerIds.length > 0) {
      const completed = await Booking.find({
        homeownerId,
        workerId: { $in: workerIds },
        status: "Completed",
      })
        .select("workerId")
        .lean();
      workedBeforeSet = new Set(completed.map((item) => String(item.workerId)));
    }

    const ratedWorkers = await attachWorkerRatingStats(
      saved.map((entry) => entry.workerId).filter(Boolean)
    );
    const ratedWorkerById = new Map(
      ratedWorkers.map((worker) => [String(worker._id || worker.id), worker])
    );

    const items = saved
      .map((entry) => {
        const worker = ratedWorkerById.get(String(entry.workerId?._id || "")) || entry.workerId;
        if (!worker) return null;

        const availability = computeAvailability(worker);
        return {
          id: String(worker._id),
          name: buildWorkerName(worker),
          photo: worker?.avatar || worker?.profileImage || "",
          rating: getWorkerRating(worker),
          service: worker?.profession || "",
          location: buildLocation(worker),
          availability,
          workedBefore: workedBeforeSet.has(String(worker._id)),
          savedAt: entry.createdAt,
        };
      })
      .filter(Boolean);

    if (sort === "rating") {
      items.sort((a, b) => {
        if (b.rating !== a.rating) return b.rating - a.rating;
        return new Date(b.savedAt) - new Date(a.savedAt);
      });
    } else if (sort === "available") {
      items.sort((a, b) => {
        const rankA = availabilityRank[a.availability] ?? availabilityRank.Offline;
        const rankB = availabilityRank[b.availability] ?? availabilityRank.Offline;
        if (rankA !== rankB) return rankA - rankB;
        return new Date(b.savedAt) - new Date(a.savedAt);
      });
    }

    savedWorkersCache.set(String(homeownerId), { createdAt: Date.now(), items });
    return res.status(200).json({ items });
  } catch (error) {
    console.error("List saved workers error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
