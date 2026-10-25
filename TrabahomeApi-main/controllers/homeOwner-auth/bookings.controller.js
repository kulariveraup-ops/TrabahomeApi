import { Types } from "mongoose";
import Booking from "../../models/Booking.js";
import Counter from "../../models/counter.Model.js";
import Worker from "../../models/worker.Model.js";
import HomeOwner from "../../models/homeOwner.Model.js";
import { sendEmail } from "../../services/email.service.js";
import { notifyBookingStatus } from "../../services/notification.service.js";
import { notifyWorkerJobCancelled, notifyWorkerJobRequest, notifyWorkerJobStatus } from "../../services/notify.js";
import { isAccountDisabled } from "../../utils/auth.utils.js";

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const CANCEL_CUTOFF_MINUTES = toPositiveInt(
  process.env.BOOKING_CANCEL_CUTOFF_MINUTES,
  120
);
const HOMEOWNER_BOOKINGS_CACHE_TTL_MS = 5_000;
const homeownerBookingsCache = new Map();

const invalidateHomeownerBookingsCache = (homeownerId) => {
  if (homeownerId) homeownerBookingsCache.delete(String(homeownerId));
};

const nextBookingNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    { key: "booking" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const seq = Number(counter?.seq || 0);
  return `TH-${String(seq).padStart(6, "0")}`;
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

const sanitizeText = (value) => String(value || "").trim();
const publicProfileImage = (value) => {
  if (typeof value === "object" && value !== null) {
    return String(
      value.avatar ||
        value.profileImage ||
        value.profilePicture ||
        value.photoUrl ||
        value.image ||
        value.photo ||
        value.picture ||
        ""
    ).trim();
  }
  return String(value || "").trim();
};
const publicImageList = (items) =>
  Array.isArray(items)
    ? items.map((item) => String(item || "").trim()).filter((item) => /^(https?:\/\/|\/|blob:|data:image\/)/i.test(item))
    : [];

const serializeProfile = (person, fallbackName) => ({
  id: person?._id ? String(person._id) : String(person?.id || ""),
  firstName: person?.firstName || "",
  lastName: person?.lastName || "",
  name:
    [String(person?.firstName || "").trim(), String(person?.lastName || "").trim()]
      .filter(Boolean)
      .join(" ") || String(person?.name || person?.email || fallbackName || "").trim(),
  email: person?.email || "",
  phone: person?.phone || "",
  avatar: publicProfileImage(person),
  profileImage: publicProfileImage(person),
  profilePicture: publicProfileImage(person),
  photoUrl: publicProfileImage(person),
  image: publicProfileImage(person),
  photo: publicProfileImage(person),
  picture: publicProfileImage(person),
});

const isBlockedHomeowner = (homeowner) => isAccountDisabled(homeowner);

const sendHomeownerBookingEmail = async (homeowner, booking, message) => {
  if (!homeowner || !booking) return;
  const emailPref =
    typeof homeowner.email_notifications === "boolean"
      ? homeowner.email_notifications
      : true;
  if (!emailPref) return;

  await sendEmail({
    to: homeowner.email,
    subject: "Booking update",
    text: message,
  });
};

const sendWorkerBookingEmail = async (worker, booking, message) => {
  if (!worker || !booking) return;
  if (!worker.email) return;
  await sendEmail({
    to: worker.email,
    subject: "Booking update",
    text: message,
  });
};

export const createBooking = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    if (!homeownerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { workerId, serviceType, scheduledAt, address, notes, photos } =
      req.body || {};

    if (!workerId || !Types.ObjectId.isValid(workerId)) {
      return res.status(400).json({ success: false, message: "Invalid worker id." });
    }
    if (!serviceType || !String(serviceType).trim()) {
      return res.status(400).json({ success: false, message: "Service type is required." });
    }
    if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
      return res.status(400).json({ success: false, message: "Invalid scheduled date." });
    }
    if (!address || !String(address).trim()) {
      return res.status(400).json({ success: false, message: "Address is required." });
    }

    const homeowner = await HomeOwner.findById(homeownerId).select(
      "firstName lastName name email avatar profileImage status isVerified email_notifications"
    ).lean();
    if (!homeowner) {
      return res.status(404).json({ success: false, message: "Homeowner not found." });
    }
    if (isBlockedHomeowner(homeowner)) {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended by the administrator. You cannot send service requests at this time.",
      });
    }

    const worker = await Worker.findById(workerId).select(
      "firstName lastName email profession city barangay rating avatar profileImage"
    );
    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    const bookingNumber = await nextBookingNumber();

    const booking = await Booking.create({
      bookingNumber,
      homeownerId,
      workerId,
      serviceType: sanitizeText(serviceType),
      scheduledAt: new Date(scheduledAt),
      address: sanitizeText(address),
      notes: notes ? sanitizeText(notes) : "",
      photos: Array.isArray(photos)
        ? photos.map((item) => String(item).trim()).filter(Boolean)
        : [],
      status: "Pending",
    });

    notifyWorkerJobRequest(workerId, {
      bookingId: booking.bookingNumber,
      homeownerId,
      homeownerName: [String(homeowner?.firstName || "").trim(), String(homeowner?.lastName || "").trim()]
        .filter(Boolean)
        .join(" ") || String(homeowner?.name || homeowner?.email || "Homeowner").trim(),
      homeownerAvatar: String(homeowner?.avatar || homeowner?.profileImage || "").trim(),
      homeownerProfileImage: String(homeowner?.profileImage || homeowner?.avatar || "").trim(),
      serviceType: String(serviceType || "General Repair").trim(),
      route: "/worker-jobs",
    });

    try {
      await sendWorkerBookingEmail(
        worker,
        booking,
        `New booking request (${booking.bookingNumber}).`
      );
    } catch (emailError) {
      console.error("Worker booking email error:", emailError);
    }

    return res.status(201).json({
      booking: {
        id: booking.bookingNumber,
        status: booking.status,
        createdAt: booking.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Create booking error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const listHomeownerBookings = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    if (!homeownerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const cached = homeownerBookingsCache.get(String(homeownerId));
    if (cached && Date.now() - cached.createdAt < HOMEOWNER_BOOKINGS_CACHE_TTL_MS) {
      return res.status(200).json({ items: cached.items });
    }

    const bookings = await Booking.find({ homeownerId })
      .sort({ createdAt: -1 })
      .select("bookingNumber workerId serviceType scheduledAt address notes photos status cancelledBy createdAt updatedAt")
      .lean();

    const workerIds = [...new Set(bookings.map((booking) => String(booking.workerId || "")).filter(Boolean))];
    const workers = workerIds.length
      ? await Worker.find({ _id: { $in: workerIds } })
        .select("firstName lastName name email phone city barangay rating avatar profileImage profilePicture photoUrl image photo picture")
        .lean()
      : [];
    const workerById = new Map(workers.map((worker) => [String(worker._id), worker]));

    const items = bookings.map((booking) => {
      const worker = workerById.get(String(booking.workerId)) || {};
      const workerAvatar = publicProfileImage(
        worker.avatar ||
        worker.profileImage ||
        worker.profilePicture ||
        worker.photoUrl ||
        worker.image ||
        worker.photo ||
        worker.picture ||
        ""
      );
      return {
        id: booking.bookingNumber,
        workerId: worker?._id ? String(worker._id) : String(booking.workerId || ""),
        workerName: buildWorkerName(worker),
        rating: getWorkerRating(worker),
        worker: serializeProfile(worker, "Worker"),
        serviceType: booking.serviceType,
        scheduledAt: booking.scheduledAt,
        requestSentAt: booking.createdAt,
        address: booking.address,
        notes: booking.notes,
        photos: publicImageList(booking.photos),
        status: booking.status,
        cancelledBy: booking.cancelledBy ?? null,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
        workerAvatar,
        workerEmail: worker.email || "",
        workerPhone: worker.phone || "",
        workerLocation: [worker.barangay, worker.city].filter(Boolean).join(", "),
      };
    });

    homeownerBookingsCache.set(String(homeownerId), { createdAt: Date.now(), items });
    return res.status(200).json({ items });
  } catch (error) {
    console.error("List bookings error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

export const cancelHomeownerBooking = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    const { id } = req.params;

    if (!homeownerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const booking = await Booking.findOne({ bookingNumber: id, homeownerId });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }

    if (booking.status === "Cancelled") {
      return res.status(400).json({ message: "Booking is already cancelled." });
    }

    if (booking.status === "In Progress") {
      return res.status(400).json({ message: "Cannot cancel once In Progress." });
    }

    if (booking.status === "Accepted") {
      const cutoffMs = CANCEL_CUTOFF_MINUTES * 60 * 1000;
      const diffMs = new Date(booking.scheduledAt).getTime() - Date.now();
      if (diffMs < cutoffMs) {
        return res.status(400).json({ message: "Cannot cancel after cutoff time." });
      }
    }

    booking.status = "Cancelled";
    booking.cancelledBy = "homeowner";
    await booking.save();
    invalidateHomeownerBookingsCache(homeownerId);

    const homeowner = await HomeOwner.findById(homeownerId).select(
      "email email_notifications firstName lastName"
    );
    const worker = await Worker.findById(booking.workerId).select(
      "email firstName lastName avatar profileImage"
    );
    const workerName =
      [String(worker?.firstName || "").trim(), String(worker?.lastName || "").trim()]
        .filter(Boolean)
        .join(" ") || String(worker?.name || worker?.email || "Worker").trim();
    const workerAvatar = publicProfileImage(worker?.avatar || worker?.profileImage);
    const workerProfileImage = workerAvatar;

    try {
      await sendHomeownerBookingEmail(
        homeowner,
        booking,
        `Your booking (${booking.bookingNumber}) has been cancelled.`
      );
    } catch (emailError) {
      console.error("Homeowner booking email error:", emailError);
    }

    try {
      await sendWorkerBookingEmail(
        worker,
        booking,
        `Booking ${booking.bookingNumber} was cancelled by the homeowner.`
      );
    } catch (emailError) {
      console.error("Worker booking email error:", emailError);
    }

    const homeownerName =
      [String(homeowner?.firstName || "").trim(), String(homeowner?.lastName || "").trim()]
        .filter(Boolean)
        .join(" ") || String(homeowner?.name || homeowner?.email || "Homeowner").trim();
    const homeownerAvatar = String(homeowner?.avatar || homeowner?.profileImage || "").trim();
    const homeownerProfileImage = String(homeowner?.profileImage || homeowner?.avatar || "").trim();
    const serviceType = String(booking.serviceType || "General Repair").trim();
    notifyBookingStatus(homeownerId, booking.status, {
      bookingId: booking.bookingNumber,
      workerId: booking.workerId,
      workerName,
      workerAvatar,
      workerProfileImage,
      route: "/homeowner-bookings",
    });
    notifyWorkerJobCancelled(booking.workerId, {
      bookingId: booking.bookingNumber,
      requestId: booking.bookingNumber,
      homeownerName,
      homeownerAvatar,
      homeownerProfileImage,
      serviceType,
      cancelledBy: "homeowner",
      route: "/worker-jobs",
    });
    notifyWorkerJobStatus(booking.workerId, "CANCELLED", {
      bookingId: booking.bookingNumber,
      requestId: booking.bookingNumber,
      homeownerId,
      homeownerName,
      homeownerAvatar,
      homeownerProfileImage,
      serviceType,
      cancelledBy: "homeowner",
      route: "/worker-jobs",
    });

    return res.status(200).json({
      booking: {
        id: booking.bookingNumber,
        status: booking.status,
        cancelledBy: booking.cancelledBy,
        updatedAt: booking.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Cancel booking error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
