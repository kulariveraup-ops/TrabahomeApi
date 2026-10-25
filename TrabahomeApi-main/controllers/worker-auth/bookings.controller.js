import Booking from "../../models/Booking.js";
import Worker from "../../models/worker.Model.js";
import HomeOwner from "../../models/homeOwner.Model.js";
import { sendEmail } from "../../services/email.service.js";
import { notifyBookingStatus } from "../../services/notification.service.js";
import { notifyWorkerJobStatus } from "../../services/notify.js";
const WORKER_BOOKINGS_CACHE_TTL_MS = 5_000;
const workerBookingsCache = new Map();

const invalidateWorkerBookingsCache = (workerId) => {
  if (workerId) workerBookingsCache.delete(String(workerId));
};

const ALLOWED_STATUSES = [
  "Pending",
  "Accepted",
  "In Progress",
  "Completed",
  "Cancelled",
  "Declined",
];

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

const publicProfileImage = (value) => {
  const image = String(
    typeof value === "object" && value !== null
      ? value.avatar || value.profileImage || value.profilePicture || value.photoUrl || value.image || value.photo || value.picture || ""
      : value || ""
  ).trim();
  return /^(https?:\/\/|\/|blob:|data:image\/)/i.test(image) ? image : "";
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

export const listWorkerBookings = async (req, res) => {
  try {
    const workerId = req.user?.id;
    if (!workerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const cached = workerBookingsCache.get(String(workerId));
    if (cached && Date.now() - cached.createdAt < WORKER_BOOKINGS_CACHE_TTL_MS) {
      return res.status(200).json({ success: true, count: cached.items.length, items: cached.items });
    }

    const bookings = await Booking.find({ workerId })
      .sort({ createdAt: -1 })
      .select("bookingNumber homeownerId serviceType scheduledAt address notes photos status cancelledBy createdAt updatedAt")
      .lean();

    const homeownerIds = [...new Set(bookings.map((booking) => String(booking.homeownerId || "")).filter(Boolean))];
    const homeowners = homeownerIds.length
      ? await HomeOwner.find({ _id: { $in: homeownerIds } })
        .select("firstName lastName name email phone avatar profileImage profilePicture photoUrl image photo picture")
        .lean()
      : [];
    const homeownerById = new Map(homeowners.map((homeowner) => [String(homeowner._id), homeowner]));

    const items = bookings.map((booking) => {
      const homeowner = homeownerById.get(String(booking.homeownerId)) || {};
      return {
        id: booking.bookingNumber,
        bookingNumber: booking.bookingNumber,
        serviceType: booking.serviceType,
        scheduledAt: booking.scheduledAt,
        address: booking.address,
        notes: booking.notes || "",
        photos: publicImageList(booking.photos),
        status: booking.status,
        cancelledBy: booking.cancelledBy || null,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
        homeownerId: homeowner._id ? String(homeowner._id) : String(booking.homeownerId || ""),
        homeownerName:
          [homeowner.firstName, homeowner.lastName].filter(Boolean).join(" ") || homeowner.name || homeowner.email || "Homeowner",
        homeownerEmail: homeowner.email || "",
        homeownerAvatar: publicProfileImage(homeowner),
        homeowner: serializeProfile(homeowner, "Homeowner"),
      };
    });

    workerBookingsCache.set(String(workerId), { createdAt: Date.now(), items });
    return res.status(200).json({ success: true, count: items.length, items });
  } catch (error) {
    console.error("List worker bookings error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const updateWorkerBookingStatus = async (req, res) => {
  try {
    const workerId = req.user?.id;
    const { id } = req.params;
    const { status } = req.body || {};

    if (!workerId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const nextStatus = String(status || "").trim();
    if (!ALLOWED_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid status." });
    }

    const booking = await Booking.findOne({ bookingNumber: id, workerId });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found." });
    }

    if (["Cancelled", "Completed", "Declined"].includes(booking.status)) {
      return res.status(400).json({ message: "Cannot update a finalized booking." });
    }

    if (nextStatus === "In Progress" && booking.status !== "Accepted") {
      return res
        .status(400)
        .json({ message: "Cannot mark In Progress unless Accepted." });
    }

    if (nextStatus === "Completed" && booking.status !== "In Progress") {
      return res
        .status(400)
        .json({ message: "Cannot mark Completed unless In Progress." });
    }

    if (nextStatus === "Accepted" && booking.status !== "Pending") {
      return res.status(400).json({ message: "Cannot accept unless Pending." });
    }

    if (nextStatus === "Declined" && booking.status !== "Pending") {
      return res.status(400).json({ message: "Cannot decline unless Pending." });
    }

    if (nextStatus === "Cancelled") {
      booking.cancelledBy = "worker";
    }

    booking.status = nextStatus;
    await booking.save();
    invalidateWorkerBookingsCache(workerId);

    const worker = await Worker.findById(workerId).select(
      "firstName lastName avatar profileImage profilePicture"
    );
    const workerName =
      [String(worker?.firstName || "").trim(), String(worker?.lastName || "").trim()]
        .filter(Boolean)
        .join(" ") || String(worker?.name || worker?.email || "the worker").trim();
    const workerAvatar = publicProfileImage(worker);
    const workerProfileImage = workerAvatar;

    notifyBookingStatus(booking.homeownerId, booking.status, {
      bookingId: booking.bookingNumber,
      workerId,
      workerName,
      workerAvatar,
      route: booking.status === "Completed"
        ? `/homeowner-bookings?tab=Completed&reviewBookingId=${encodeURIComponent(booking.bookingNumber)}`
        : "/homeowner-bookings",
    });
    notifyWorkerJobStatus(workerId, nextStatus, {
      bookingId: booking.bookingNumber,
      workerId,
      workerName,
      workerAvatar,
      workerProfileImage,
      route: "/worker-jobs",
    });

    const homeowner = await HomeOwner.findById(booking.homeownerId).select(
      "email email_notifications firstName lastName"
    );

    try {
      await sendHomeownerBookingEmail(
        homeowner,
        booking,
        `Your booking with ${workerName} has been ${nextStatus.toLowerCase()}.`
      );
    } catch (emailError) {
      console.error("Homeowner booking email error:", emailError);
    }

    return res.status(200).json({
      booking: {
        id: booking.bookingNumber,
        status: booking.status,
        updatedAt: booking.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Update booking status error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
