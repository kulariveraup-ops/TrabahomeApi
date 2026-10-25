import crypto from "crypto";
import bcrypt from "bcryptjs";
import Booking from "../../models/booking.Model.js";
import SupportTicket from "../../models/supportTicket.Model.js";
import Worker from "../../models/worker.Model.js";
import HomeOwner from "../../models/homeOwner.Model.js";
import { buildLoginRateLimitKey, clearLoginFailures } from "../../services/loginRateLimit.service.js";
import {
  createHomeownerNotification,
  createWorkerNotification,
  notifyAllAdmins,
} from "../../services/notify.js";
import { emitToAdmin, emitToAll, emitToHomeowner, emitToWorker } from "../../services/socket.js";
import { sendEmail } from "../../services/email.service.js";
import { isWorkerEmailTaken, generateSecureTemporaryPassword } from "../../utils/auth.utils.js";
import { createAndSendOtp } from "../../services/otp.service.js";
import { resolveWorkerLocation } from "../../utils/workerLocation.js";
import { normalizeSupportTicket } from "../support/support.controller.js";
import {
  generateSignedUrl,
  uploadEncryptedIdDocument,
  convertBase64ToPublicAsset,
  parseBase64DataUrl,
  STORAGE_FOLDERS,
} from "../../services/cloudStorage.service.js";

const ADMIN_WORKER_LIST_SELECT = "firstName lastName email phone profession city barangay province rating bio yearsExperience languages idType aiVerification availabilityStatus workingSchedule price location locationLabel status isVerified pendingProfileUpdate createdAt updatedAt";
const ADMIN_WORKER_FULL_SELECT = "firstName lastName email phone profession city barangay province rating bio yearsExperience languages proofOfWork idCardImage idType aiVerification availabilityStatus workingSchedule price location locationLabel status isVerified pendingProfileUpdate createdAt updatedAt";

const normalizePhilippineMobile = (value) => {
  let phone = String(value || "").trim().replace(/[()\-\s]/g, "");
  if (phone.startsWith("+63")) phone = `0${phone.slice(3)}`;
  else if (phone.startsWith("63")) phone = `0${phone.slice(2)}`;
  else if (phone.startsWith("9")) phone = `0${phone}`;
  return /^09\d{9}$/.test(phone) ? phone : "";
};

const buildWorkerName = (worker) => {
  if (!worker) return "";
  const first = worker.firstName ? String(worker.firstName).trim() : "";
  const last = worker.lastName ? String(worker.lastName).trim() : "";
  return [first, last].filter(Boolean).join(" ") || worker.name || worker.email || "Worker";
};

const buildHomeownerName = (homeowner) => {
  if (!homeowner) return "";
  const first = homeowner.firstName ? String(homeowner.firstName).trim() : "";
  const last = homeowner.lastName ? String(homeowner.lastName).trim() : "";
  return [first, last].filter(Boolean).join(" ") || homeowner.name || homeowner.email || "Homeowner";
};

const normalizeBooking = (booking) => {
  const worker = booking.workerId || {};
  const homeowner = booking.homeownerId || {};
  return {
    id: booking.bookingNumber,
    bookingNumber: booking.bookingNumber,
    serviceType: booking.serviceType,
    scheduledAt: booking.scheduledAt,
    address: booking.address,
    notes: booking.notes || "",
    photos: Array.isArray(booking.photos) ? booking.photos : [],
    status: booking.status,
    cancelledBy: booking.cancelledBy || null,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
    workerId: worker._id ? String(worker._id) : String(booking.workerId || ""),
    homeownerId: homeowner._id ? String(homeowner._id) : String(booking.homeownerId || ""),
    workerName: buildWorkerName(worker),
    homeownerName: buildHomeownerName(homeowner),
    workerEmail: worker.email || "",
    homeownerEmail: homeowner.email || "",
    workerAvatar: publicImageUrl(worker.avatar || worker.profileImage),
    homeownerAvatar: publicImageUrl(homeowner.avatar || homeowner.profileImage),
  };
};

const toAdminWorker = (worker) => {
  const record = worker?.toObject ? worker.toObject() : worker || {};
  const locationLabel = [record.barangay, record.city, record.province]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");

  return {
    ...record,
    id: record?._id ? String(record._id) : "",
    name: buildWorkerName(record),
    skill: String(record.profession || "").trim(),
    locationLabel: locationLabel || String(record.locationLabel || "").trim(),
    address: locationLabel || String(record.locationLabel || "").trim(),
  };
};

const publicImageUrl = (value) => {
  const image = String(value || "").trim();
  return /^(https?:\/\/|\/|blob:)/i.test(image) ? image : "";
};

export const getWorkers = async (req, res) => {
  try {
    const statusFilter = String(req.query.status || "").trim();
    const summaryOnly = String(req.query.summary || "").toLowerCase() === "true";
    const includeDocuments = String(req.query.includeDocuments || "").toLowerCase() === "true";
    const filter = {};

    if (statusFilter) {
      filter.status = statusFilter;
    }

    if (summaryOnly) {
      const [count, ratingStats] = await Promise.all([
        Worker.countDocuments(filter),
        Worker.aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              averageRating: { $avg: "$rating" },
            },
          },
        ]),
      ]);

      return res.status(200).json({
        success: true,
        count,
        averageRating: Number(ratingStats?.[0]?.averageRating || 0),
        data: [],
      });
    }

    const selectFields = includeDocuments ? ADMIN_WORKER_FULL_SELECT : ADMIN_WORKER_LIST_SELECT;
    const workers = await Worker.find(filter)
      .select(selectFields)
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({
      success: true,
      count: workers.length,
      data: workers.map(toAdminWorker),
    });
  } catch (error) {
    console.error("Get workers error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const getWorkerById = async (req, res) => {
  try {
    const workerId = String(req.params?.id || "").trim();
    if (!workerId) {
      return res.status(400).json({ success: false, message: "Worker ID is required." });
    }

    const worker = await Worker.findById(workerId)
      .select(ADMIN_WORKER_FULL_SELECT)
      .lean();

    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    return res.status(200).json({
      success: true,
      data: toAdminWorker(worker),
      worker: toAdminWorker(worker),
    });
  } catch (error) {
    console.error("Get worker by ID error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const updateWorkerInformation = async (req, res) => {
  try {
    const workerId = String(req.params?.id || "").trim();
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = normalizePhilippineMobile(req.body?.phone);
    const profession = String(req.body?.profession || "").trim();
    const barangay = String(req.body?.barangay || "").trim();
    const city = String(req.body?.city || "").trim();
    const province = String(req.body?.province || "").trim();

    if (!workerId || !firstName || !lastName || !profession || !barangay || !city || !province) {
      return res.status(400).json({ success: false, message: "Complete Worker account information is required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Enter a valid email address." });
    }
    if (!phone) {
      return res.status(400).json({ success: false, message: "Enter a valid Philippine mobile number." });
    }

    const worker = await Worker.findById(workerId);
    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    const emailConflict = await isWorkerEmailTaken(email, worker._id);
    if (emailConflict) {
      return res.status(409).json({ success: false, message: "Email is already registered." });
    }

    const oldEmail = String(worker.email || "").trim().toLowerCase();
    const locationChanged =
      String(worker.barangay || "").trim() !== barangay ||
      String(worker.city || "").trim() !== city ||
      String(worker.province || "").trim() !== province;

    worker.firstName = firstName;
    worker.lastName = lastName;
    worker.email = email;
    worker.phone = phone;
    worker.profession = profession;
    worker.barangay = barangay;
    worker.city = city;
    worker.province = province;

    if (locationChanged) {
      worker.location = undefined;
      worker.locationLabel = [barangay, city, province].join(", ");
    }

    await worker.save();
    if (locationChanged) {
      await resolveWorkerLocation(worker, { persist: true, geocode: true });
    }

    if (oldEmail) clearLoginFailures(buildLoginRateLimitKey("worker", oldEmail));
    clearLoginFailures(buildLoginRateLimitKey("worker", email));

    const updatedWorker = await Worker.findById(worker._id).select(ADMIN_WORKER_FULL_SELECT).lean();

    void createWorkerNotification({
      userId: worker._id,
      title: "Account Information Updated",
      message: "An administrator updated your account information.",
      type: "info",
      meta: { route: "/worker-own-profile" },
    }).catch((err) => console.error("Worker admin update notification error:", err));

    return res.status(200).json({
      success: true,
      message: "Worker information updated.",
      data: toAdminWorker(updatedWorker),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "Email or mobile number is already registered." });
    }
    console.error("Update Worker information error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const listBookings = async (req, res) => {
  try {
    const summaryOnly = String(req.query.summary || "").toLowerCase() === "true";
    if (summaryOnly) {
      const [count, pendingCount] = await Promise.all([
        Booking.countDocuments(),
        Booking.countDocuments({ status: "Pending" }),
      ]);
      return res.status(200).json({ success: true, count, pendingCount, items: [] });
    }

    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .select("bookingNumber workerId homeownerId serviceType scheduledAt address notes photos status cancelledBy createdAt updatedAt")
      .lean();

    const workerIds = [...new Set(bookings.map((booking) => String(booking.workerId || "")).filter(Boolean))];
    const homeownerIds = [...new Set(bookings.map((booking) => String(booking.homeownerId || "")).filter(Boolean))];
    const [workers, homeowners] = await Promise.all([
      workerIds.length
        ? Worker.find({ _id: { $in: workerIds } })
          .select("firstName lastName name email avatar profileImage")
          .lean()
        : Promise.resolve([]),
      homeownerIds.length
        ? HomeOwner.find({ _id: { $in: homeownerIds } })
          .select("firstName lastName name email avatar profileImage")
          .lean()
        : Promise.resolve([]),
    ]);
    const workerById = new Map(workers.map((worker) => [String(worker._id), worker]));
    const homeownerById = new Map(homeowners.map((homeowner) => [String(homeowner._id), homeowner]));

    const items = bookings.map((booking) =>
      normalizeBooking({
        ...booking,
        workerId: workerById.get(String(booking.workerId)) || booking.workerId,
        homeownerId: homeownerById.get(String(booking.homeownerId)) || booking.homeownerId,
        photos: Array.isArray(booking.photos)
          ? booking.photos.filter((item) => /^(https?:\/\/|\/|blob:)/i.test(String(item || "").trim()))
          : [],
      })
    );
    return res.status(200).json({ success: true, count: items.length, items });
  } catch (error) {
    console.error("List admin bookings error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const listSupportTickets = async (req, res) => {
  try {
    const summaryOnly = String(req.query.summary || "").toLowerCase() === "true";
    if (summaryOnly) {
      const count = await SupportTicket.countDocuments();
      return res.status(200).json({ success: true, count, items: [] });
    }
    const tickets = await SupportTicket.find()
      .select("ticketNumber name email role issueCategory status createdAt updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .lean();
    const items = tickets.map((ticket) => normalizeSupportTicket(ticket));
    return res.status(200).json({ success: true, count: items.length, items });
  } catch (error) {
    console.error("List support tickets error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const updateSupportTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowedStatuses = ["Open", "In Progress", "Resolved", "Closed"];

    if (!id || !status || !allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid ticket status." });
    }

    const ticket = await SupportTicket.findById(id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }

    ticket.status = status;
    await ticket.save();

    const normalizedTicket = normalizeSupportTicket(ticket, { includeConversation: true });
    emitToAdmin("support-ticket:updated", normalizedTicket);
    emitToAdmin("dashboard:refresh", { source: "support-ticket:status-updated" });
    if (ticket.role === "Worker") {
      emitToWorker(ticket.userId, "support-ticket:updated", normalizedTicket);
    } else {
      emitToHomeowner(ticket.userId, "support-ticket:updated", normalizedTicket);
    }

    if (status === "Resolved") {
      const isWorker = ticket.role === "Worker";
      const notifyUser = isWorker ? createWorkerNotification : createHomeownerNotification;
      void notifyUser({
        userId: ticket.userId,
        title: "Support ticket resolved",
        message: `Your support ticket #${ticket.ticketNumber} has been marked as resolved by admin.`,
        type: "success",
        meta: {
          route: isWorker ? "/worker-support-history" : "/homeowner-help",
          ticketId: String(ticket._id),
          ticketNumber: ticket.ticketNumber,
        },
      }).catch((err) => console.error("Ticket resolved notification error:", err));
    } else if (status === "Closed") {
      const isWorker = ticket.role === "Worker";
      const notifyUser = isWorker ? createWorkerNotification : createHomeownerNotification;
      void notifyUser({
        userId: ticket.userId,
        title: "Support ticket closed",
        message: `Your support ticket #${ticket.ticketNumber} has been closed.`,
        type: "info",
        meta: {
          route: isWorker ? "/worker-support-history" : "/homeowner-help",
          ticketId: String(ticket._id),
          ticketNumber: ticket.ticketNumber,
        },
      }).catch((err) => console.error("Ticket closed notification error:", err));
    }

    return res.status(200).json({ success: true, message: "Ticket status updated.", ticket: normalizedTicket });
  } catch (error) {
    console.error("Update support ticket status error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const updateWorkerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!id || !status || !["Pending", "Verified", "Rejected", "Suspended"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid request payload." });
    }

    const worker = await Worker.findById(id);
    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    const isVerified = status === "Verified";
    const isBlocked = status === "Suspended" || status === "Rejected";

    worker.status = status;
    worker.isVerified = isVerified;
    worker.disabled = isBlocked;
    worker.isDisabled = isBlocked;
    worker.isActive = !isBlocked;
    await worker.save();

    if (isVerified && worker.email) {
      clearLoginFailures(buildLoginRateLimitKey("worker", worker.email));
    }

    void notifyAllAdmins({
      title: "Worker status updated",
      message: `${String(worker.firstName || worker.name || worker.email || "Worker")} changed to ${status}.`,
      type: status === "Verified" ? "success" : "info",
      meta: {
        route: `/admin-workers?workerId=${encodeURIComponent(String(worker._id || ""))}`,
        workerId: String(worker._id || ""),
        workerName: `${worker.firstName || ""} ${worker.lastName || ""}`.trim() || worker.email,
        workerAvatar: worker.avatar || worker.profileImage || "",
        workerProfileImage: worker.profileImage || worker.avatar || "",
        actorId: String(worker._id || ""),
        actorRole: "worker",
        actorName: `${worker.firstName || ""} ${worker.lastName || ""}`.trim() || worker.email,
        actorAvatar: worker.avatar || worker.profileImage || "",
        status,
      },
    });

    emitToAdmin("worker:updated", { id: worker._id, status: worker.status, isVerified: worker.isVerified });
    emitToAll("worker:updated", { id: worker._id, status: worker.status, isVerified: worker.isVerified });
    emitToAdmin("dashboard:refresh", { source: "worker:status-updated" });
    emitToAll("dashboard:refresh", { source: "worker:status-updated" });
    emitToWorker(worker._id, "account:status-updated", { status: worker.status, isVerified: worker.isVerified });

    void createWorkerNotification({
      userId: worker._id,
      title: "Account Status Updated",
      message: `Your account verification status has been updated to ${status}.`,
      type: status === "Verified" ? "success" : "warning",
      meta: { route: "/worker-own-profile" },
    }).catch((err) => console.error("Worker status change notification error:", err));

    return res.status(200).json({
      success: true,
      message: "Worker status updated.",
      data: {
        id: worker._id,
        status: worker.status,
        isVerified: worker.isVerified,
        disabled: worker.disabled,
        isDisabled: worker.isDisabled,
        isActive: worker.isActive,
      },
    });
  } catch (error) {
    console.error("Update worker status error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const updateHomeownerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!id || !status || !["Active", "Suspended"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid request payload." });
    }

    const homeowner = await HomeOwner.findById(id);
    if (!homeowner) {
      return res.status(404).json({ success: false, message: "Homeowner not found." });
    }

    homeowner.status = status === "Suspended" ? "Suspended" : "Verified";
    await homeowner.save();

    if (status === "Active" && homeowner.email) {
      clearLoginFailures(buildLoginRateLimitKey("homeowner", homeowner.email));
    }

    emitToAdmin("homeowner:updated", { id: homeowner._id, status: homeowner.status });
    emitToAll("homeowner:updated", { id: homeowner._id, status: homeowner.status });
    emitToAdmin("dashboard:refresh", { source: "homeowner:status-updated" });
    emitToAll("dashboard:refresh", { source: "homeowner:status-updated" });
    emitToHomeowner(homeowner._id, "account:status-updated", { status: homeowner.status });

    void createHomeownerNotification({
      userId: homeowner._id,
      title: "Account Status Updated",
      message: `Your account status has been updated to ${status}.`,
      type: status === "Active" ? "success" : "warning",
      meta: { route: "/homeowner-own-profile" },
    }).catch((err) => console.error("Homeowner status change notification error:", err));

    return res.status(200).json({
      success: true,
      message: "Homeowner status updated.",
      data: {
        id: homeowner._id,
        status: homeowner.status,
      },
    });
  } catch (error) {
    console.error("Update homeowner status error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// POST /api/admins/workers
export const createWorkerByAdmin = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      mobileNumber,
      password,
      profession,
      city,
      barangay,
      province = "Pangasinan",
      status = "Verified",
      bio = "",
      yearsExperience = 1,
      workingSchedule = "Monday to Saturday, 8:00 AM - 5:00 PM",
      availabilityStatus = "Available",
      price = "",
      validId = "",
      idType = "Government Valid ID",
      idCardImage = "",
      proofOfWork = [],
    } = req.body || {};

    const nameRegex = /^[A-Za-z\s-]{2,30}$/;
    if (!firstName || !nameRegex.test(String(firstName).trim())) {
      return res.status(400).json({ success: false, message: "First name must contain only letters (2-30 characters)." });
    }
    if (!lastName || !nameRegex.test(String(lastName).trim())) {
      return res.status(400).json({ success: false, message: "Last name must contain only letters (2-30 characters)." });
    }

    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: "A valid email address is required." });
    }

    const rawPhone = phone ?? mobileNumber;
    const normalizedPhone = normalizePhilippineMobile(rawPhone);
    if (!normalizedPhone || !/^09\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({ success: false, message: "Phone number must be exactly 11 digits starting with 09." });
    }

    const selectedProfs = String(profession || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (selectedProfs.length < 1 || selectedProfs.length > 8) {
      return res.status(400).json({ success: false, message: "Please select between 1 and 8 professions." });
    }
    const cleanProfession = selectedProfs.join(", ");

    if (!city || !barangay) {
      return res.status(400).json({ success: false, message: "City and barangay are required." });
    }

    const emailConflict = await isWorkerEmailTaken(normalizedEmail);
    if (emailConflict) {
      return res.status(409).json({ success: false, message: "Email is already registered." });
    }

    // Admin does not set permanent passwords; generate a valid temporary password that meets all requirements
    const temporaryPassword = generateSecureTemporaryPassword();
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, salt);

    const locationGeo = await resolveWorkerLocation({
      barangay: String(barangay).trim(),
      city: String(city).trim(),
      province: String(province || "Pangasinan").trim(),
    });

    const locationPoint = locationGeo?.coords
      ? {
          type: "Point",
          coordinates: [locationGeo.coords.lng, locationGeo.coords.lat],
        }
      : undefined;

    const isVerified = (status || "Verified") === "Verified";
    const rawIdImage = String(validId || idCardImage || "").trim();
    let idDocKey = "";

    if (rawIdImage) {
      const parsed = parseBase64DataUrl(rawIdImage);
      if (parsed) {
        const doc = await uploadEncryptedIdDocument(parsed.buffer, {
          mimetype: parsed.mimetype,
          prefix: "admin-id",
        });
        idDocKey = doc.idDocumentKey;
      }
    }

    const rawProofs = Array.isArray(proofOfWork)
      ? proofOfWork.map(String).filter(Boolean)
      : [];
    const resolvedProofOfWork = [];
    for (const item of rawProofs) {
      const url = await convertBase64ToPublicAsset(item, STORAGE_FOLDERS.PROOF_OF_WORK, req);
      if (url) resolvedProofOfWork.push(url);
    }

    const newWorker = await Worker.create({
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      password: hashedPassword,
      mustChangePassword: true,
      profession: cleanProfession,
      city: String(city).trim(),
      barangay: String(barangay).trim(),
      province: String(province || "Pangasinan").trim(),
      status: status || "Verified",
      isVerified,
      agreeToTerms: true,
      agreeToPrivacy: true,
      bio: String(bio || "").trim(),
      yearsExperience: Number(yearsExperience) || 0,
      workingSchedule: String(workingSchedule || "Monday to Saturday, 8:00 AM - 5:00 PM").trim(),
      availabilityStatus: String(availabilityStatus || "Available").trim(),
      price: String(price || "").trim(),
      rating: 5,
      idType: (rawIdImage || idDocKey) ? (idType || "Government Valid ID") : "admin_created",
      idNumber: `ADMIN-${Date.now()}`,
      idCardImage: "",
      proofOfWork: resolvedProofOfWork,
      aiVerification: {
        status: isVerified ? "Approved" : "Pending",
        verifiedAt: isVerified ? new Date() : undefined,
        idType: (rawIdImage || idDocKey) ? (idType || "Government Valid ID") : "admin_created",
        idDocumentKey: idDocKey || undefined,
        confidenceScore: 100,
        provider: "Admin Manual Registration",
      },
      location: locationPoint,
      locationLabel: locationGeo?.locationLabel,
    });

    // Send credentials email with temporary password
    try {
      await sendEmail({
        to: normalizedEmail,
        subject: "Your TrabaHome Skilled Worker Account Details",
        text: `Hello ${String(firstName).trim()},\n\nYour TrabaHome skilled worker account has been created by the administrator.\n\nHere are your login credentials:\nEmail: ${normalizedEmail}\nTemporary Password: ${temporaryPassword}\n\nPlease sign in at TrabaHome with your temporary password. You will receive a verification code (OTP), after which you will be prompted to set your own permanent password before accessing your dashboard.\n\nThank you,\nTrabaHome Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 16px;">
            <h2 style="color: #0B3B68; margin-bottom: 16px;">Welcome to TrabaHome!</h2>
            <p>Hello <strong>${String(firstName).trim()}</strong>,</p>
            <p>Your skilled worker account has been created by the administrator.</p>
            <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin: 20px 0;">
              <p style="margin: 4px 0;"><strong>Email:</strong> ${normalizedEmail}</p>
              <p style="margin: 4px 0;"><strong>Temporary Password:</strong> <code style="background-color: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 15px;">${temporaryPassword}</code></p>
            </div>
            <p style="color: #475569; font-size: 14px;">Please sign in with your email and temporary password. Upon entering your one-time verification code (OTP), you will be prompted to set your new permanent password.</p>
            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">For security reasons, please do not share your credentials with anyone.</p>
          </div>
        `,
      });
    } catch (mailErr) {
      console.error("[createWorkerByAdmin] Failed to send temporary password email:", mailErr);
    }

    const adminWorker = toAdminWorker(newWorker);
    emitToAll("user-registered", { type: "worker", id: newWorker._id });
    emitToAll("worker-changed", { type: "create", id: newWorker._id });

    return res.status(201).json({
      success: true,
      message: "Worker created successfully. Temporary credentials have been emailed to the worker.",
      worker: adminWorker,
      data: adminWorker,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "Email or phone number is already registered." });
    }
    console.error("Create worker by admin error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// GET /api/admins/workers/:id/id-documents/signed-url
export const getWorkerIdDocumentsSignedUrl = async (req, res) => {
  try {
    const workerId = String(req.params?.id || "").trim();
    if (!workerId) {
      return res.status(400).json({ success: false, message: "Worker ID is required." });
    }

    const worker = await Worker.findById(workerId)
      .select("+aiVerification.idDocumentKey +aiVerification.selfieDocumentKey aiVerification idType firstName lastName status isVerified idCardImage")
      .lean();

    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    const idDocumentKey = worker.aiVerification?.idDocumentKey;
    const selfieDocumentKey = worker.aiVerification?.selfieDocumentKey;

    if (!idDocumentKey && !selfieDocumentKey && !worker.idCardImage) {
      return res.status(404).json({
        success: false,
        message: "No private encrypted ID documents found for this worker.",
      });
    }

    // Short-lived signed URLs with 10-minute expiry (600 seconds)
    const idCardSignedUrl = idDocumentKey
      ? generateSignedUrl({
          documentKey: idDocumentKey,
          expiresInSeconds: 600,
          purpose: "audit",
          req,
        })
      : (worker.idCardImage || null);

    const selfieSignedUrl = selfieDocumentKey
      ? generateSignedUrl({
          documentKey: selfieDocumentKey,
          expiresInSeconds: 600,
          purpose: "audit",
          req,
        })
      : null;

    return res.status(200).json({
      success: true,
      workerId,
      workerName: `${worker.firstName || ""} ${worker.lastName || ""}`.trim() || worker.email,
      idType: worker.idType || worker.aiVerification?.idType || "Philippine Government ID",
      expiresInSeconds: 600,
      expiresAt: new Date(Date.now() + 600 * 1000).toISOString(),
      documents: {
        idCardUrl: idCardSignedUrl,
        selfieUrl: selfieSignedUrl,
      },
    });
  } catch (error) {
    console.error("Get worker ID signed URL error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const getPendingWorkerProfileUpdates = async (_req, res) => {
  try {
    const workers = await Worker.find({ "pendingProfileUpdate.status": "pending" })
      .select("firstName lastName email phone profession city barangay province locationLabel pendingProfileUpdate createdAt")
      .sort({ "pendingProfileUpdate.submittedAt": -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: workers.length,
      updates: workers.map((w) => ({
        workerId: w._id,
        email: w.email,
        currentDetails: {
          fullName: `${w.firstName || ""} ${w.lastName || ""}`.trim(),
          firstName: w.firstName,
          lastName: w.lastName,
          phone: w.phone,
          profession: w.profession,
          city: w.city,
          barangay: w.barangay,
          province: w.province,
          location: w.locationLabel || `${w.barangay}, ${w.city}, ${w.province}`,
        },
        proposedChanges: w.pendingProfileUpdate?.changes || {},
        submittedAt: w.pendingProfileUpdate?.submittedAt || w.createdAt,
      })),
    });
  } catch (error) {
    console.error("Get pending worker profile updates error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const reviewWorkerProfileUpdate = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, rejectionReason } = req.body || {};

    if (!["approve", "reject"].includes(String(action).toLowerCase())) {
      return res.status(400).json({ success: false, message: "Action must be either 'approve' or 'reject'." });
    }

    const worker = await Worker.findById(id);
    if (!worker) {
      return res.status(404).json({ success: false, message: "Worker not found." });
    }

    if (worker.pendingProfileUpdate?.status !== "pending") {
      return res.status(400).json({ success: false, message: "No pending profile update found for this worker." });
    }

    const isApprove = String(action).toLowerCase() === "approve";

    if (isApprove) {
      const changes = worker.pendingProfileUpdate.changes || {};
      if (changes.firstName) worker.firstName = changes.firstName;
      if (changes.lastName) worker.lastName = changes.lastName;
      if (changes.phone) worker.phone = changes.phone;
      if (changes.profession) worker.profession = changes.profession;
      if (changes.city) worker.city = changes.city;
      if (changes.barangay) worker.barangay = changes.barangay;
      if (changes.province) worker.province = changes.province;
      if (changes.location) worker.locationLabel = changes.location;

      await resolveWorkerLocation(worker, { persist: true, geocode: true });

      worker.pendingProfileUpdate.status = "approved";
      worker.pendingProfileUpdate.reviewedAt = new Date();
      worker.pendingProfileUpdate.rejectionReason = "";
      await worker.save();

      createWorkerNotification(worker._id, {
        title: "Profile Changes Approved",
        message: "Your profile details have been approved by the administrator and are now live.",
        type: "profile_update_approved",
        timestamp: new Date(),
      });
      emitToWorker(worker._id, "worker:profile-updated", {
        status: "approved",
        worker: {
          firstName: worker.firstName,
          lastName: worker.lastName,
          phone: worker.phone,
          profession: worker.profession,
          city: worker.city,
          barangay: worker.barangay,
          locationLabel: worker.locationLabel,
        },
      });

      return res.status(200).json({
        success: true,
        message: "Worker profile update approved and applied successfully.",
        worker,
      });
    } else {
      const reason = String(rejectionReason || "").trim() || "Details could not be verified by the administrator.";
      worker.pendingProfileUpdate.status = "rejected";
      worker.pendingProfileUpdate.reviewedAt = new Date();
      worker.pendingProfileUpdate.rejectionReason = reason;
      await worker.save();

      createWorkerNotification(worker._id, {
        title: "Profile Changes Declined",
        message: `Your profile update was declined by the administrator: ${reason}`,
        type: "profile_update_rejected",
        timestamp: new Date(),
      });
      emitToWorker(worker._id, "worker:profile-updated", {
        status: "rejected",
        rejectionReason: reason,
      });

      return res.status(200).json({
        success: true,
        message: "Worker profile update declined successfully.",
        rejectionReason: reason,
      });
    }
  } catch (error) {
    console.error("Review worker profile update error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

