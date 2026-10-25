import { Types } from "mongoose";
import Counter from "../models/counter.Model.js";
import ServiceRequest from "../models/serviceRequest.Model.js";
import Worker from "../models/worker.Model.js";
import HomeOwner from "../models/homeOwner.Model.js";
import Skill from "../models/skill.Model.js";
import { emitToAdmin, emitToHomeowner, emitToWorker } from "../services/socket.js";
import { notifyBookingStatus, notifyWorkerJobRequest } from "../services/notification.service.js";
import {
  notifyAllAdmins,
  notifyAdminReviewReceived,
  notifyWorkerJobCancelled,
  notifyWorkerJobStatus,
  notifyWorkerReviewReceived,
  createHomeownerNotification,
  createWorkerNotification,
} from "../services/notify.js";
import { refreshStoredWorkerRating } from "../services/workerRating.service.js";
import { isAccountDisabled } from "../utils/auth.utils.js";
import { validateServiceRequestContactAndLocation } from "../utils/serviceRequestValidation.js";
import {
  convertBase64ToPublicAsset,
  convertBase64ToPrivatePaymentProof,
  generateSignedUrl,
  STORAGE_FOLDERS,
} from "../services/cloudStorage.service.js";

const WORKER_REQUEST_CACHE_TTL_MS = 10_000;
const workerRequestCache = new Map();
const HOMEOWNER_REQUEST_CACHE_TTL_MS = 10_000;
const homeownerRequestCache = new Map();
const ADMIN_REQUEST_CACHE_TTL_MS = 5_000;
const adminRequestCache = new Map();

const invalidateWorkerRequestCache = (workerId) => {
  if (workerId) workerRequestCache.delete(String(workerId));
};

const invalidateHomeownerRequestCache = (homeownerId) => {
  if (homeownerId) homeownerRequestCache.delete(String(homeownerId));
};

const invalidateAdminRequestCache = () => {
  adminRequestCache.clear();
};

export const invalidateServiceRequestCaches = () => {
  workerRequestCache.clear();
  homeownerRequestCache.clear();
  adminRequestCache.clear();
};

const normalizeDateKey = (val) => {
  if (!val) return "";
  if (typeof val === "string") {
    const match = val.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
  }
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

const normalizeTimeKey = (val) => {
  const trimmed = String(val || "").trim();
  if (!trimmed) return "00:00";
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m24) {
    const h = String(m24[1]).padStart(2, "0");
    const m = String(m24[2]).padStart(2, "0");
    return `${h}:${m}`;
  }
  const m12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const m = m12[2];
    const isPM = m12[3].toUpperCase() === "PM";
    if (isPM && h < 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }
  return trimmed;
};

const ACTIVE_REQUEST_STATUSES = ["PENDING", "ONGOING", "ACCEPTED", "IN_PROGRESS"];

const nextRequestNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    { key: "service-request" }, { $inc: { seq: 1 } }, { new: true, upsert: true }
  );
  return `SR-${String(Number(counter?.seq || 0)).padStart(6, "0")}`;
};

const nameOf = (person, fallback) =>
  [person?.firstName, person?.lastName].filter(Boolean).join(" ") || person?.name || person?.email || fallback;

const requestIdOf = (request) => String(request?._id || request?.requestNumber || "").trim();

const buildRequestLookupFilter = (id) => {
  const value = String(id || "").trim();
  if (!value) return null;

  const filters = [
    { requestNumber: value.toUpperCase() },
    { requestNumber: value },
  ];
  if (Types.ObjectId.isValid(value)) {
    filters.unshift({ _id: new Types.ObjectId(value) });
  }

  return { $or: filters };
};

const isBlockedHomeowner = (homeowner) => isAccountDisabled(homeowner);

// Embedded base64 photos make every request response several megabytes because
// the same image is repeated for each job. List endpoints return URL images only;
// the frontend falls back to a lightweight generated avatar when none is present.
const publicProfileImage = (person) => {
  if (typeof person === "object" && person !== null) {
    return String(
      person.avatar ||
        person.profileImage ||
        person.profilePicture ||
        person.photoUrl ||
        person.image ||
        person.photo ||
        person.picture ||
        ""
    ).trim();
  }
  return String(person || "").trim();
};

const serializeProfile = (person, fallbackName, { includeAvatar = true } = {}) => ({
  id: person?._id ? String(person._id) : String(person?.id || ""),
  firstName: person?.firstName || "",
  lastName: person?.lastName || "",
  name: nameOf(person, fallbackName),
  email: person?.email || "",
  phone: person?.phone || "",
  ...(includeAvatar ? { avatar: publicProfileImage(person) } : {}),
});

const serializeActors = (people, role, fallbackName) =>
  people.map((person) => ({
    id: person?._id ? String(person._id) : String(person?.id || ""),
    role,
    name: nameOf(person, fallbackName),
    avatar: publicProfileImage(person),
  }));

const loadActorImages = async (Model, ids, role, fallbackName) => {
  const objectIds = [...new Set(ids.map((id) => String(id || "")).filter(Types.ObjectId.isValid))]
    .map((id) => new Types.ObjectId(id));
  if (objectIds.length === 0) return [];
  const people = await Model.aggregate([
    { $match: { _id: { $in: objectIds } } },
    {
      $project: {
        firstName: 1,
        lastName: 1,
        name: 1,
        email: 1,
        avatar: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 0] },
            "$avatar",
            "$profileImage",
          ],
        },
      },
    },
  ]);
  return serializeActors(people, role, fallbackName);
};

const serialize = (request, { useMongoId = false, includeAvatars = true } = {}) => {
  const worker = request.targetWorkerId || {};
  const homeowner = request.homeownerId || {};
  return {
    id: useMongoId ? requestIdOf(request) : String(request.requestNumber || requestIdOf(request)),
    requestNumber: request.requestNumber,
    homeownerId: homeowner._id ? String(homeowner._id) : String(request.homeownerId || ""),
    targetWorkerId: worker._id ? String(worker._id) : String(request.targetWorkerId || ""),
    homeownerName: nameOf(homeowner, "Homeowner"),
    homeownerEmail: homeowner.email || "",
    homeownerPhone: homeowner.phone || "",
    ...(includeAvatars ? { homeownerAvatar: publicProfileImage(homeowner) } : {}),
    homeownerCity: homeowner.city || "",
    homeownerBarangay: homeowner.barangay || "",
    homeownerRating: typeof homeowner.rating === "number" ? homeowner.rating : (typeof request.homeownerRating === "number" ? request.homeownerRating : 5),
    homeownerRatingCount: typeof homeowner.ratingCount === "number" ? homeowner.ratingCount : (typeof request.homeownerRatingCount === "number" ? request.homeownerRatingCount : 0),
    homeownerReviews: Array.isArray(request.homeownerReviews) ? request.homeownerReviews : [],
    homeowner: serializeProfile(homeowner, "Homeowner", { includeAvatar: false }),
    workerName: nameOf(worker, "Worker"),
    workerEmail: worker.email || "",
    ...(includeAvatars ? { workerAvatar: publicProfileImage(worker) } : {}),
    worker: serializeProfile(worker, "Worker", { includeAvatar: false }),
    description: request.description,
    preferredDate: request.preferredDate,
    preferredTime: request.preferredTime,
    serviceType: request.serviceType,
    estimatedStartingCost: typeof request.estimatedStartingCost === "number" ? request.estimatedStartingCost : Number(request.estimatedStartingCost || 0),
    rescheduleRequest: request.rescheduleRequest || null,
    contactNumber: request.contactNumber || "",
    province: request.province || "",
    city: request.city || "",
    barangay: request.barangay || "",
    location: request.location || "",
    address: request.address,
    status: request.status,
    cancelledBy: request.cancelledBy || null,
    declineReason: request.declineReason || "",
    adminNote: request.adminNote || "",
    reviewRating: request.reviewRating ?? null,
    reviewText: request.reviewText || "",
    reviewTags: Array.isArray(request.reviewTags) ? request.reviewTags : [],
    reviewedAt: request.reviewedAt || null,
    workerReviewRating: request.workerReviewRating ?? null,
    workerReviewText: request.workerReviewText || "",
    workerReviewTags: Array.isArray(request.workerReviewTags) ? request.workerReviewTags : [],
    workerReviewedAt: request.workerReviewedAt || null,
    acceptedOn: request.acceptedOn || null,
    completedOn: request.completedOn || null,
    cancelledOn: request.cancelledOn || null,
    completionDetails: request.completionDetails || {
      proofOfWork: [],
      paymentAmount: 0,
      jobSummary: "",
      completedAt: null,
    },
    supportRequestId: request.supportRequestId || "",
    messages: Array.isArray(request.messages) ? request.messages : [],
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
};

const populated = (query) => query.populate("targetWorkerId").populate("homeownerId");

const publish = (request, event, options = {}) => {
  const item = serialize(request, options);
  emitToHomeowner(item.homeownerId, event, item);
  emitToWorker(item.targetWorkerId, event, item);
  emitToAdmin(event, item);
  emitToAdmin("dashboard:refresh", { source: event });
  return item;
};

export const createServiceRequest = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    const { targetWorkerId, description, preferredDate, preferredTime, serviceType } = req.body || {};
    if (!homeownerId) return res.status(401).json({ success: false, message: "Unauthorized." });
    if (!Types.ObjectId.isValid(targetWorkerId)) return res.status(400).json({ success: false, message: "Invalid target worker." });
    if (!String(description || "").trim() || !preferredDate || !String(preferredTime || "").trim()) {
      return res.status(400).json({ success: false, message: "Description, preferred date, and preferred time are required." });
    }
    if (Number.isNaN(new Date(preferredDate).getTime())) return res.status(400).json({ success: false, message: "Invalid preferred date." });

    const reqDateKey = normalizeDateKey(preferredDate);
    const reqTimeKey = normalizeTimeKey(preferredTime);

    // Compute Philippine local time (Asia/Manila / UTC+8)
    const phNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
    const todayKey = `${phNow.getFullYear()}-${String(phNow.getMonth() + 1).padStart(2, "0")}-${String(phNow.getDate()).padStart(2, "0")}`;
    const maxDate = new Date(phNow);
    maxDate.setDate(maxDate.getDate() + 90);
    const maxDateKey = `${maxDate.getFullYear()}-${String(maxDate.getMonth() + 1).padStart(2, "0")}-${String(maxDate.getDate()).padStart(2, "0")}`;

    if (reqDateKey < todayKey) {
      return res.status(400).json({
        success: false,
        message: "Booking date cannot be in the past.",
      });
    }

    if (reqDateKey === todayKey) {
      const currentHour = phNow.getHours();
      const currentMinute = phNow.getMinutes();
      const isMorningWindow = currentHour < 10 || (currentHour === 10 && currentMinute === 0);

      if (!isMorningWindow) {
        return res.status(400).json({
          success: false,
          message: "Same-day bookings can only be requested between 12:00 AM and 10:00 AM. For requests after 10:00 AM, please select tomorrow or a later date.",
        });
      }

      if (reqTimeKey < "13:00") {
        return res.status(400).json({
          success: false,
          message: "Same-day bookings requested before 10:00 AM must be scheduled for the afternoon (1:00 PM onwards).",
        });
      }
    }

    if (reqDateKey > maxDateKey) {
      return res.status(400).json({
        success: false,
        message: "Booking date cannot exceed 90 days ahead from today. Dates beyond 90 days are locked and will unlock as days go by.",
      });
    }
    const locationValidation = validateServiceRequestContactAndLocation(req.body);
    if (locationValidation.error) {
      return res.status(400).json({ success: false, message: locationValidation.error });
    }
    const requestDetails = locationValidation.value;
    const homeowner = await HomeOwner.findById(homeownerId)
      .select("firstName lastName name email avatar profileImage profilePicture photoUrl image photo picture city barangay status isVerified")
      .lean();
    if (!homeowner) return res.status(404).json({ success: false, message: "Homeowner not found." });
    if (isBlockedHomeowner(homeowner)) {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended by the administrator. You cannot send service requests at this time.",
      });
    }
    if (
      !(await Worker.exists({
        _id: targetWorkerId,
        $or: [{ status: "Verified" }, { isVerified: true }],
      }))
    ) return res.status(404).json({ success: false, message: "Worker not found." });

    // 1. Homeowner active booking limit: max 10 active bookings total across workers
    const homeownerActiveCount = await ServiceRequest.countDocuments({
      homeownerId,
      status: { $in: ACTIVE_REQUEST_STATUSES },
    });
    if (homeownerActiveCount >= 10) {
      return res.status(400).json({
        success: false,
        message: "You have reached the maximum limit of 10 active bookings across workers. You can only request new bookings once current active bookings are completed or done.",
      });
    }

    // 2. Homeowner active booking limit with target worker: max 3 active bookings
    const activeWithWorker = await ServiceRequest.find({
      homeownerId,
      targetWorkerId,
      status: { $in: ACTIVE_REQUEST_STATUSES },
    }).select("preferredDate preferredTime status");

    if (activeWithWorker.length >= 3) {
      return res.status(400).json({
        success: false,
        message: "You can only have up to 3 active bookings with this worker. Please wait until existing bookings are completed.",
      });
    }

    // 3. Prevent duplicate booking at the same date and time with that worker
    const hasDuplicateSchedule = activeWithWorker.some((booking) => {
      const bDateKey = normalizeDateKey(booking.preferredDate);
      const bTimeKey = normalizeTimeKey(booking.preferredTime);
      return bDateKey === reqDateKey && bTimeKey === reqTimeKey;
    });

    if (hasDuplicateSchedule) {
      return res.status(400).json({
        success: false,
        message: "You already have an active booking with this worker on this date and time. Duplicate bookings on the same schedule are not allowed.",
      });
    }

    // 4. Worker active bookings capacity check (max 50)
    const workerOngoingCount = await ServiceRequest.countDocuments({
      targetWorkerId,
      status: { $in: ["ONGOING", "ACCEPTED", "IN_PROGRESS"] },
    });
    if (workerOngoingCount >= 50) {
      return res.status(400).json({
        success: false,
        message: "This worker currently has reached their maximum capacity of 50 active bookings. Please choose another worker or try again later.",
      });
    }

    let resolvedStartingCost = Number(req.body?.estimatedStartingCost);
    if (!Number.isFinite(resolvedStartingCost) || resolvedStartingCost <= 0) {
      const matchedSkill = await Skill.findOne({
        name: { $regex: new RegExp(`^${String(serviceType || "").trim()}$`, "i") },
      }).lean();
      resolvedStartingCost = matchedSkill?.startingPrice || 0;
    }

    const request = await ServiceRequest.create({
      requestNumber: await nextRequestNumber(), homeownerId, targetWorkerId,
      description: String(description).trim(), preferredDate: new Date(preferredDate), preferredTime: String(preferredTime).trim(),
      serviceType: String(serviceType || "General Repair").trim(),
      estimatedStartingCost: resolvedStartingCost,
      contactNumber: requestDetails.contactNumber,
      province: requestDetails.province,
      city: requestDetails.city,
      barangay: requestDetails.barangay,
      location: requestDetails.location,
      address: requestDetails.address,
      status: "PENDING",
    });
    invalidateWorkerRequestCache(targetWorkerId);
    invalidateHomeownerRequestCache(homeownerId);
    invalidateAdminRequestCache();
    let lightweight = serialize(request, { useMongoId: true });
    try {
      const full = await populated(ServiceRequest.findById(request._id));
      lightweight = serialize(full, { useMongoId: true });
      const item = publish(full, "service-request:created", { useMongoId: true });
      void Promise.allSettled([
        notifyAllAdmins({
          title: "New service request",
          message: `${item.homeownerName || "A homeowner"} submitted a ${item.serviceType || "service"} request.`,
          type: "info",
          meta: {
            route: `/admin-requests?requestId=${encodeURIComponent(item.id)}`,
            requestId: item.id,
            homeownerId,
            homeownerName: nameOf(homeowner, "Homeowner"),
            homeownerAvatar: publicProfileImage(homeowner),
            homeownerProfileImage: publicProfileImage(homeowner),
            actorId: String(homeownerId || ""),
            actorRole: "homeowner",
            actorName: nameOf(homeowner, "Homeowner"),
            actorAvatar: publicProfileImage(homeowner),
            targetWorkerId,
            serviceType: item.serviceType || "General Repair",
          },
        }),
        notifyWorkerJobRequest(targetWorkerId, {
          requestId: item.id,
          homeownerId,
          homeownerName: nameOf(homeowner, "Homeowner"),
          homeownerAvatar: publicProfileImage(homeowner),
          homeownerProfileImage: publicProfileImage(homeowner),
          serviceType: item.serviceType || "General Repair",
          route: "/worker-jobs",
        }),
      ]).then((results) => {
        results.forEach((result) => {
          if (result.status === "rejected") {
            console.error("Background service request notification error:", result.reason);
          }
        });
      });
    } catch (backgroundError) {
      console.error("Background service request publish error:", backgroundError);
    }
    return res.status(201).json({ success: true, request: lightweight });
  } catch (error) {
    console.error("Create service request error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const listHomeownerServiceRequests = async (req, res) => {
  try {
    const homeownerId = String(req.user.id);
    const avatarMode = String(req.query?.avatars || "include").trim().toLowerCase();
    const cacheKey = `${homeownerId}:${avatarMode}`;
    const cached = homeownerRequestCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < HOMEOWNER_REQUEST_CACHE_TTL_MS) {
      return res.json({ success: true, count: cached.items.length, items: cached.items, actors: cached.actors });
    }

    if (avatarMode === "only") {
      const requestActors = await ServiceRequest.find({ homeownerId: req.user.id })
        .select("targetWorkerId")
        .lean();
      const actors = await loadActorImages(
        Worker,
        requestActors.map((request) => request.targetWorkerId),
        "worker",
        "Worker"
      );
      homeownerRequestCache.set(cacheKey, { createdAt: Date.now(), items: [], actors });
      return res.json({ success: true, count: 0, items: [], actors });
    }

    const includeProof = String(req.query.includeProof || "").toLowerCase() === "true";
    const baseRequestSelect = "requestNumber homeownerId targetWorkerId description preferredDate preferredTime serviceType contactNumber province city barangay location address status cancelledBy declineReason reviewRating reviewText reviewTags reviewedAt workerReviewRating workerReviewText workerReviewTags workerReviewedAt acceptedOn completedOn cancelledOn createdAt updatedAt";
    const requestSelect = includeProof
      ? `${baseRequestSelect} completionDetails messages`
      : `${baseRequestSelect} completionDetails.paymentAmount completionDetails.jobSummary completionDetails.completedAt`;

    const requests = await ServiceRequest.find({ homeownerId: req.user.id })
      .sort({ createdAt: -1 })
      .select(requestSelect)
      .lean();

    const workerIds = [...new Set(requests.map((request) => String(request.targetWorkerId || "")).filter(Boolean))];
    const workers = workerIds.length
      ? await Worker.find({
          _id: { $in: workerIds },
          $or: [{ status: "Verified" }, { isVerified: true }],
        })
          .select("firstName lastName name email phone city barangay rating")
          .lean()
      : [];
    const workerById = new Map(workers.map((worker) => [String(worker._id), worker]));

    const items = requests.map((request) => {
      const worker = workerById.get(String(request.targetWorkerId)) || {};
      return {
        id: requestIdOf(request),
        requestNumber: request.requestNumber,
        homeownerId: String(request.homeownerId || ""),
        targetWorkerId: String(request.targetWorkerId || ""),
        workerName: nameOf(worker, "Worker"),
        workerPhone: worker.phone || "",
        workerEmail: worker.email || "",
        worker: serializeProfile(worker, "Worker", { includeAvatar: false }),
        workerCity: worker.city || "",
        workerBarangay: worker.barangay || "",
        rating: Number(worker?.rating || 0) || 0,
        serviceType: request.serviceType,
        scheduledAt: request.preferredDate,
        preferredDate: request.preferredDate,
        preferredTime: request.preferredTime || "",
        contactNumber: request.contactNumber || "",
        province: request.province || "",
        city: request.city || "",
        barangay: request.barangay || "",
        location: request.location || request.address || "",
        address: request.address || "",
        description: request.description || "",
        notes: request.description || "",
        photos: [],
        status: request.status,
        cancelledBy: request.cancelledBy || null,
        declineReason: request.declineReason || "",
        reviewRating: request.reviewRating ?? null,
        reviewText: request.reviewText || "",
        reviewTags: Array.isArray(request.reviewTags) ? request.reviewTags : [],
        reviewedAt: request.reviewedAt || null,
        workerReviewRating: request.workerReviewRating ?? null,
        workerReviewText: request.workerReviewText || "",
        workerReviewTags: Array.isArray(request.workerReviewTags) ? request.workerReviewTags : [],
        workerReviewedAt: request.workerReviewedAt || null,
        completionDetails: {
          paymentAmount: Number(request.completionDetails?.paymentAmount) || 0,
          jobSummary: String(request.completionDetails?.jobSummary || "").trim(),
          completedAt: request.completionDetails?.completedAt || null,
          proofOfWorkCount: Array.isArray(request.completionDetails?.proofOfWork) ? request.completionDetails.proofOfWork.length : 0,
          proofOfPaymentCount: Array.isArray(request.completionDetails?.proofOfPayment) ? request.completionDetails.proofOfPayment.length : 0,
          proofOfWork: Array.isArray(request.completionDetails?.proofOfWork)
            ? request.completionDetails.proofOfWork.map((img) => (typeof img === 'string' && img.length > 50000 ? '[photo]' : img))
            : [],
          proofOfPayment: Array.isArray(request.completionDetails?.proofOfPayment)
            ? request.completionDetails.proofOfPayment.map((img) => (typeof img === 'string' && img.length > 50000 ? '[receipt]' : img))
            : [],
        },
        messages: Array.isArray(request.messages) && includeProof ? request.messages : [],
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      };
    });

    const actors = avatarMode === "none" ? [] : serializeActors(workers, "worker", "Worker");
    homeownerRequestCache.set(cacheKey, { createdAt: Date.now(), items, actors });
    return res.json({ success: true, count: items.length, items, actors });
  } catch (error) {
    console.error("List homeowner service requests error:", error);
    return res.status(500).json({ success: false, message: "Unable to load service requests." });
  }
};
export const listWorkerServiceRequests = async (req, res) => {
  try {
    const workerId = String(req.user.id);
    const avatarMode = String(req.query?.avatars || "include").trim().toLowerCase();
    const cacheKey = `${workerId}:${avatarMode}`;
    const cached = workerRequestCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < WORKER_REQUEST_CACHE_TTL_MS) {
      return res.json({ success: true, count: cached.items.length, items: cached.items, actors: cached.actors });
    }

    if (avatarMode === "only") {
      const requestActors = await ServiceRequest.find({ targetWorkerId: req.user.id })
        .select("homeownerId")
        .lean();
      const actors = await loadActorImages(
        HomeOwner,
        requestActors.map((request) => request.homeownerId),
        "homeowner",
        "Homeowner"
      );
      workerRequestCache.set(cacheKey, { createdAt: Date.now(), items: [], actors });
      return res.json({ success: true, count: 0, items: [], actors });
    }

    const includeProof = String(req.query.includeProof || "").toLowerCase() === "true";
    const baseRequestSelect = "requestNumber homeownerId targetWorkerId description preferredDate preferredTime serviceType contactNumber province city barangay location address status cancelledBy declineReason reviewRating reviewText reviewTags reviewedAt workerReviewRating workerReviewText workerReviewTags workerReviewedAt acceptedOn completedOn cancelledOn createdAt updatedAt";
    const requestSelect = includeProof
      ? `${baseRequestSelect} completionDetails messages`
      : `${baseRequestSelect} completionDetails.paymentAmount completionDetails.jobSummary completionDetails.completedAt`;

    const requests = await ServiceRequest.find({ targetWorkerId: req.user.id })
      .sort({ createdAt: -1 })
      .select(requestSelect)
      .lean();

    const homeownerIds = requests.map((request) => request.homeownerId).filter(Boolean);
    const homeowners = homeownerIds.length
      ? await HomeOwner.find({ _id: { $in: homeownerIds } })
        .select("firstName lastName email phone city barangay rating ratingCount")
        .lean()
      : [];
    const homeownerById = new Map(homeowners.map((homeowner) => [String(homeowner._id), homeowner]));

    const pastWorkerReviews = homeownerIds.length
      ? await ServiceRequest.find({
          homeownerId: { $in: homeownerIds },
          workerReviewRating: { $ne: null },
        })
          .select("homeownerId workerReviewRating workerReviewText workerReviewTags workerReviewedAt completedOn targetWorkerId serviceType")
          .populate("targetWorkerId", "firstName lastName name profession")
          .sort({ workerReviewedAt: -1 })
          .lean()
      : [];
    const reviewsByHomeownerId = new Map();
    pastWorkerReviews.forEach((rev) => {
      const hId = String(rev.homeownerId);
      if (!reviewsByHomeownerId.has(hId)) reviewsByHomeownerId.set(hId, []);
      reviewsByHomeownerId.get(hId).push({
        id: String(rev._id),
        workerName: [rev.targetWorkerId?.firstName, rev.targetWorkerId?.lastName].filter(Boolean).join(" ") || rev.targetWorkerId?.name || "Skilled Worker",
        workerProfession: rev.targetWorkerId?.profession || rev.serviceType || "Skilled Worker",
        workerAvatar: "",
        rating: rev.workerReviewRating,
        comment: rev.workerReviewText,
        tags: rev.workerReviewTags || [],
        reviewedAt: rev.workerReviewedAt || rev.completedOn,
      });
    });

    const items = requests.map((request) => {
      const hId = String(request.homeownerId?._id || request.homeownerId || "");
      const matchedHomeowner = homeownerById.get(hId);
      const item = serialize({
        ...request,
        homeownerId: matchedHomeowner || request.homeownerId,
        homeownerRating: typeof matchedHomeowner?.rating === "number" ? matchedHomeowner.rating : 5,
        homeownerRatingCount: typeof matchedHomeowner?.ratingCount === "number" ? matchedHomeowner.ratingCount : (reviewsByHomeownerId.get(hId)?.length || 0),
        homeownerReviews: reviewsByHomeownerId.get(hId) || [],
        targetWorkerId: request.targetWorkerId,
      }, { useMongoId: true, includeAvatars: false });

      if (!includeProof && item.completionDetails) {
        item.completionDetails = {
          paymentAmount: Number(item.completionDetails.paymentAmount) || 0,
          jobSummary: String(item.completionDetails.jobSummary || "").trim(),
          completedAt: item.completionDetails.completedAt || null,
          proofOfWorkCount: Array.isArray(item.completionDetails.proofOfWork) ? item.completionDetails.proofOfWork.length : 0,
          proofOfPaymentCount: Array.isArray(item.completionDetails.proofOfPayment) ? item.completionDetails.proofOfPayment.length : 0,
          proofOfWork: Array.isArray(item.completionDetails.proofOfWork)
            ? item.completionDetails.proofOfWork.map((img) => (typeof img === 'string' && img.length > 50000 ? '[photo]' : img))
            : [],
          proofOfPayment: Array.isArray(item.completionDetails.proofOfPayment)
            ? item.completionDetails.proofOfPayment.map((img) => (typeof img === 'string' && img.length > 50000 ? '[receipt]' : img))
            : [],
        };
      }
      return item;
    });

    const actors = avatarMode === "none" ? [] : serializeActors(homeowners, "homeowner", "Homeowner");
    workerRequestCache.set(cacheKey, { createdAt: Date.now(), items, actors });
    return res.json({ success: true, count: items.length, items, actors });
  } catch (error) {
    console.error("List worker service requests error:", error);
    return res.status(500).json({ success: false, message: "Unable to load service requests." });
  }
};
export const listAdminServiceRequests = async (req, res) => {
  try {
    const status = String(req.query.status || "").trim().toUpperCase();
    const avatarMode = String(req.query?.avatars || "include").trim().toLowerCase();
    const cacheKey = `${status || "ALL"}:${avatarMode}`;
    const cached = adminRequestCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < ADMIN_REQUEST_CACHE_TTL_MS) {
      return res.json({ success: true, count: cached.items.length, items: cached.items, actors: cached.actors });
    }

    if (avatarMode === "only") {
      const requestActors = await ServiceRequest.find(status ? { status } : {})
        .select("homeownerId targetWorkerId")
        .lean();
      const [workerActors, homeownerActors] = await Promise.all([
        loadActorImages(Worker, requestActors.map((request) => request.targetWorkerId), "worker", "Worker"),
        loadActorImages(HomeOwner, requestActors.map((request) => request.homeownerId), "homeowner", "Homeowner"),
      ]);
      const actors = [...workerActors, ...homeownerActors];
      adminRequestCache.set(cacheKey, { createdAt: Date.now(), items: [], actors });
      return res.json({ success: true, count: 0, items: [], actors });
    }

    const includeProof = String(req.query.includeProof || "").toLowerCase() === "true";
    const filter = status ? { status } : {};
    const baseRequestSelect = "requestNumber homeownerId targetWorkerId description preferredDate preferredTime serviceType contactNumber province city barangay location address status cancelledBy declineReason supportRequestId adminNote reviewRating reviewText reviewTags reviewedAt workerReviewRating workerReviewText workerReviewTags workerReviewedAt acceptedOn completedOn cancelledOn createdAt updatedAt";
    const requestSelect = `${baseRequestSelect} completionDetails`;

    const requests = await ServiceRequest.find(filter)
      .sort({ createdAt: -1 })
      .select(requestSelect)
      .lean();

    const workerIds = [...new Set(requests.map((request) => String(request.targetWorkerId || "")).filter(Boolean))];
    const homeownerIds = [...new Set(requests.map((request) => String(request.homeownerId || "")).filter(Boolean))];
    const [workers, homeowners] = await Promise.all([
      workerIds.length
        ? Worker.find({ _id: { $in: workerIds } })
          .select("firstName lastName name email city barangay rating")
          .lean()
        : Promise.resolve([]),
      homeownerIds.length
        ? HomeOwner.find({ _id: { $in: homeownerIds } })
          .select("firstName lastName name email city barangay")
          .lean()
        : Promise.resolve([]),
    ]);

    const workerById = new Map(workers.map((worker) => [String(worker._id), worker]));
    const homeownerById = new Map(homeowners.map((homeowner) => [String(homeowner._id), homeowner]));
    const serialized = requests.map((request) => {
      const item = serialize({
        ...request,
        targetWorkerId: workerById.get(String(request.targetWorkerId)) || request.targetWorkerId,
        homeownerId: homeownerById.get(String(request.homeownerId)) || request.homeownerId,
      }, { useMongoId: false, includeAvatars: false });

      if (item.completionDetails) {
        const rawProofOfWork = Array.isArray(item.completionDetails.proofOfWork)
          ? item.completionDetails.proofOfWork
          : [];
        const rawPaymentProof = Array.isArray(item.completionDetails.proofOfPayment)
          ? item.completionDetails.proofOfPayment
          : [];

        item.completionDetails = {
          paymentAmount: Number(item.completionDetails.paymentAmount) || 0,
          jobSummary: String(item.completionDetails.jobSummary || "").trim(),
          completedAt: item.completionDetails.completedAt || null,
          proofOfWorkCount: rawProofOfWork.length,
          proofOfPaymentCount: rawPaymentProof.length,
          proofOfWork: rawProofOfWork,
          proofOfPayment: rawPaymentProof.map((img) => {
            const str = String(img || "").trim();
            if (str.startsWith(STORAGE_FOLDERS.PROOF_OF_PAYMENT)) {
              return generateSignedUrl({
                documentKey: str,
                expiresInSeconds: 600,
                purpose: "payment",
                req,
              });
            }
            return str;
          }),
        };
      }
      return item;
    });
    const actors = avatarMode === "none" ? [] : [
      ...serializeActors(workers, "worker", "Worker"),
      ...serializeActors(homeowners, "homeowner", "Homeowner"),
    ];
    adminRequestCache.set(cacheKey, { createdAt: Date.now(), items: serialized, actors });
    return res.json({ success: true, count: serialized.length, items: serialized, actors });
  } catch (error) {
    console.error("List admin service requests error:", error);
    return res.status(500).json({ success: false, message: "Unable to load service requests." });
  }
};

export const getServiceRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const lookup = buildRequestLookupFilter(id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });

    const request = await ServiceRequest.findOne(lookup).lean();
    if (!request) return res.status(404).json({ success: false, message: "Service request not found." });

    const userId = String(req.user?.id || req.user?._id || req.user?.userId || "").trim();
    const role = String(req.user?.role || "").trim().toLowerCase();
    const homeownerId = String(request.homeownerId?._id || request.homeownerId || "").trim();
    const workerId = String(request.targetWorkerId?._id || request.targetWorkerId || "").trim();

    const isAuthorizedParticipant =
      role === "admin" ||
      (role === "homeowner" && userId === homeownerId) ||
      (role === "worker" && userId === workerId);

    const [worker, homeowner] = await Promise.all([
      request.targetWorkerId ? Worker.findById(request.targetWorkerId).select("firstName lastName name email phone rating avatar profileImage").lean() : null,
      request.homeownerId ? HomeOwner.findById(request.homeownerId).select("firstName lastName name email phone rating avatar profileImage").lean() : null,
    ]);

    const serialized = serialize({
      ...request,
      targetWorkerId: worker || request.targetWorkerId,
      homeownerId: homeowner || request.homeownerId,
    }, { useMongoId: false, includeAvatars: false });

    // Restrict access so only the paying user, recipient, and admin can generate viewable access links
    if (serialized.completionDetails) {
      const rawPaymentProof = Array.isArray(serialized.completionDetails.proofOfPayment)
        ? serialized.completionDetails.proofOfPayment
        : [];

      if (isAuthorizedParticipant) {
        serialized.completionDetails.proofOfPayment = rawPaymentProof.map((item) => {
          const str = String(item || "").trim();
          if (str.startsWith(STORAGE_FOLDERS.PROOF_OF_PAYMENT)) {
            return generateSignedUrl({
              documentKey: str,
              expiresInSeconds: 600,
              purpose: "payment",
              req,
            });
          }
          return str;
        });
      } else {
        serialized.completionDetails.proofOfPayment = [];
      }
    }

    return res.json({ success: true, request: serialized, item: serialized, data: serialized });
  } catch (error) {
    console.error("Get service request by id error:", error);
    return res.status(500).json({ success: false, message: "Unable to load service request." });
  }
};

// GET /api/service-requests/:id/proof-of-payment/access-urls
export const getServiceRequestProofOfPaymentAccessUrls = async (req, res) => {
  try {
    const { id } = req.params;
    const lookup = buildRequestLookupFilter(id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });

    const request = await ServiceRequest.findOne(lookup)
      .select("homeownerId targetWorkerId completionDetails.proofOfPayment")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Service request not found." });

    const userId = String(req.user?.id || req.user?._id || req.user?.userId || "").trim();
    const role = String(req.user?.role || "").trim().toLowerCase();
    const homeownerId = String(request.homeownerId?._id || request.homeownerId || "").trim();
    const workerId = String(request.targetWorkerId?._id || request.targetWorkerId || "").trim();

    const isAuthorized =
      role === "admin" ||
      (role === "homeowner" && userId === homeownerId) ||
      (role === "worker" && userId === workerId);

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        message: "Forbidden. Only the paying homeowner, recipient worker, or admin can access proof of payment.",
      });
    }

    const rawProofs = Array.isArray(request.completionDetails?.proofOfPayment)
      ? request.completionDetails.proofOfPayment
      : [];

    const signedUrls = rawProofs.map((item) => {
      const str = String(item || "").trim();
      if (str.startsWith(STORAGE_FOLDERS.PROOF_OF_PAYMENT)) {
        return generateSignedUrl({
          documentKey: str,
          expiresInSeconds: 600,
          purpose: "payment",
          req,
        });
      }
      return str;
    });

    return res.status(200).json({
      success: true,
      serviceRequestId: id,
      expiresInSeconds: 600,
      expiresAt: new Date(Date.now() + 600 * 1000).toISOString(),
      proofOfPaymentUrls: signedUrls,
    });
  } catch (error) {
    console.error("Get proof of payment access URLs error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const updateServiceRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const actor = req.user?.role;
    const body = req.body || {};
    const lookup = buildRequestLookupFilter(id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });
    const request = await ServiceRequest.findOne(lookup);
    if (!request) return res.status(404).json({ success: false, message: "Service request not found." });
    if (actor === "homeowner" && String(request.homeownerId) !== req.user.id) return res.status(403).json({ success: false, message: "Forbidden." });
    if (actor === "worker" && String(request.targetWorkerId) !== req.user.id) return res.status(403).json({ success: false, message: "Forbidden." });

    const status = String(body.status || "").toUpperCase();
    if (status) {
      const allowed = actor === "worker"
        ? ["ONGOING", "COMPLETED", "DECLINED", "CANCELLED"]
        : actor === "homeowner"
          ? ["ONGOING", "CANCELLED"]
          : ["PENDING", "ONGOING", "COMPLETED", "CANCELLED", "DECLINED"];
      if (!allowed.includes(status)) return res.status(400).json({ success: false, message: "Invalid status update." });

      if (actor === "homeowner" && status === "CANCELLED" && request.status === "ONGOING") {
        return res.status(400).json({
          success: false,
          message: "Accepted bookings cannot be cancelled directly. Please submit a cancellation request to admin for approval via support ticket.",
        });
      }

      if (status === "ONGOING" && request.status !== "ONGOING") {
        if (actor === "worker") {
          // Check worker active bookings limit: max 50
          const workerActiveCount = await ServiceRequest.countDocuments({
            targetWorkerId: req.user.id,
            status: { $in: ["ONGOING", "ACCEPTED", "IN_PROGRESS"] },
            _id: { $ne: request._id },
          });
          if (workerActiveCount >= 50) {
            return res.status(400).json({
              success: false,
              message: "You have reached your maximum limit of 50 active bookings. Please complete existing bookings before accepting new ones.",
            });
          }

          // Check worker active bookings with this homeowner: max 3
          const workerHomeownerActive = await ServiceRequest.find({
            targetWorkerId: req.user.id,
            homeownerId: request.homeownerId,
            status: { $in: ["ONGOING", "ACCEPTED", "IN_PROGRESS"] },
            _id: { $ne: request._id },
          }).select("preferredDate preferredTime status");

          if (workerHomeownerActive.length >= 3) {
            return res.status(400).json({
              success: false,
              message: "You cannot accept more than 3 active bookings from the same homeowner simultaneously.",
            });
          }

          // Check duplicate booking on the same date and time with this homeowner
          const reqDateKey = normalizeDateKey(request.preferredDate);
          const reqTimeKey = normalizeTimeKey(request.preferredTime);

          const hasDuplicateWithHomeowner = workerHomeownerActive.some((booking) => {
            const bDateKey = normalizeDateKey(booking.preferredDate);
            const bTimeKey = normalizeTimeKey(booking.preferredTime);
            return bDateKey === reqDateKey && bTimeKey === reqTimeKey;
          });

          if (hasDuplicateWithHomeowner) {
            return res.status(400).json({
              success: false,
              message: "You already have an active booking with this homeowner on the scheduled date and time.",
            });
          }
        }
        request.acceptedOn = request.acceptedOn || new Date();
      }

      request.status = status;
      if (status === "COMPLETED") {
        request.completedOn = new Date();
        if (body.completionDetails) {
          const rawProofOfWork = Array.isArray(body.completionDetails.proofOfWork)
            ? body.completionDetails.proofOfWork.map(String).filter(Boolean)
            : [];
          const rawProofOfPayment = Array.isArray(body.completionDetails.proofOfPayment)
            ? body.completionDetails.proofOfPayment.map(String).filter(Boolean)
            : [];

          // Upload/convert proofOfWork to public CDN URLs
          const proofOfWork = [];
          for (const item of rawProofOfWork) {
            const converted = await convertBase64ToPublicAsset(item, STORAGE_FOLDERS.PROOF_OF_WORK, req);
            if (converted) proofOfWork.push(converted);
          }

          // Upload/convert proofOfPayment to private asset keys
          const proofOfPayment = [];
          for (const item of rawProofOfPayment) {
            const convertedKey = await convertBase64ToPrivatePaymentProof(item);
            if (convertedKey) proofOfPayment.push(convertedKey);
          }

          const paymentAmount = Number(body.completionDetails.paymentAmount) || 0;
          const jobSummary = String(body.completionDetails.jobSummary || "").trim();
          request.completionDetails = {
            proofOfWork,
            proofOfPayment,
            paymentAmount,
            jobSummary,
            completedAt: new Date(),
          };
        }

        const revObj = body.homeownerReview || body.workerReview || body.review;
        if (revObj && (revObj.rating || revObj.workerReviewRating)) {
          const ratingVal = Math.min(5, Math.max(1, Number(revObj.rating || revObj.workerReviewRating) || 5));
          request.workerReviewRating = ratingVal;
          request.workerReviewText = String(revObj.reviewText || revObj.workerReviewText || "").trim();
          request.workerReviewTags = Array.isArray(revObj.reviewTags || revObj.workerReviewTags)
            ? (revObj.reviewTags || revObj.workerReviewTags).map(String).filter(Boolean)
            : [];
          request.workerReviewedAt = new Date();

          try {
            const homeowner = await HomeOwner.findById(request.homeownerId);
            if (homeowner) {
              const currentCount = Number(homeowner.ratingCount) || 0;
              const currentRating = Number(homeowner.rating) || 5;
              const newCount = currentCount + 1;
              const newRating = Number(((currentRating * currentCount + ratingVal) / newCount).toFixed(1));
              homeowner.rating = newRating;
              homeowner.ratingCount = newCount;
              await homeowner.save();
            }
          } catch (ratingErr) {
            console.error("Failed to update homeowner rating:", ratingErr);
          }
        }
      }
      if (status === "CANCELLED") {
        request.cancelledBy = actor;
        request.cancelledOn = new Date();
        if (actor === "admin") {
          const notes = String(body.cancelReason || body.declineReason || body.notes || "").trim();
          const srNumber = String(body.supportRequestId || body.supportRequestNumber || "").trim();
          const combinedReason = srNumber
            ? `Support Request #${srNumber}: ${notes}`
            : notes;
          request.declineReason = combinedReason;
          if (srNumber) request.supportRequestId = srNumber;
          if (notes) {
            request.adminNote = (request.adminNote ? `${request.adminNote}\n` : "") +
              `[Admin Cancellation via Support #${srNumber || "N/A"} on ${new Date().toLocaleString()}]: ${notes}`;
          }
        } else if (actor === "homeowner" || actor === "worker") {
          const reason = String(body.cancelReason || body.declineReason || body.reason || body.notes || "").trim();
          if (reason) {
            request.declineReason = reason;
          }
        }
      }
      if (status === "DECLINED" || (status === "CANCELLED" && actor === "worker")) {
        if (body.declineReason) {
          request.declineReason = String(body.declineReason || "").trim();
        }
      }
    }
    if (actor === "admin" && typeof body.adminNote === "string") request.adminNote = body.adminNote.trim();
    await request.save();
    invalidateWorkerRequestCache(request.targetWorkerId);
    invalidateHomeownerRequestCache(request.homeownerId);
    invalidateAdminRequestCache();
    const full = await populated(ServiceRequest.findById(request._id));
    const item = publish(full, "service-request:updated", { useMongoId: true });
    if (actor === "worker") {
      void notifyBookingStatus(item.homeownerId, item.status, {
        requestId: item.id,
        workerId: item.targetWorkerId,
        workerName: item.workerName || "Worker",
        workerAvatar: item.workerAvatar || "",
        declineReason: item.declineReason || "",
        cancelledBy: item.cancelledBy || null,
        route: item.status === "COMPLETED"
          ? `/homeowner-bookings?tab=Completed&reviewBookingId=${encodeURIComponent(item.id)}`
          : (item.status === "CANCELLED" || item.status === "DECLINED" ? "/homeowner-bookings?tab=Cancelled" : "/homeowner-bookings"),
      }).catch((error) => console.error("Homeowner status notification error:", error));

      void notifyWorkerJobStatus(item.targetWorkerId, item.status, {
        requestId: item.id,
        bookingId: item.id,
        homeownerId: item.homeownerId,
        homeownerName: item.homeownerName || "Homeowner",
        homeownerAvatar: item.homeownerAvatar || "",
        homeownerProfileImage: item.homeownerProfileImage || "",
        serviceType: item.serviceType || "service",
        route: "/worker-jobs",
        cancelledBy: item.cancelledBy || null,
        declineReason: item.declineReason || "",
      }).catch((error) => console.error("Worker status notification error:", error));

      if (item.status === "ONGOING") {
        void notifyAllAdmins({
          title: "Booking accepted",
          message: `${item.workerName || "Worker"} accepted the ${item.serviceType || "service"} request from ${item.homeownerName || "Homeowner"}.`,
          type: "success",
          meta: {
            route: `/admin-requests?requestId=${encodeURIComponent(item.id)}`,
            requestId: item.id,
            requestNumber: item.requestNumber,
            homeownerId: item.homeownerId,
            homeownerName: item.homeownerName,
            workerId: item.targetWorkerId,
            workerName: item.workerName,
            serviceType: item.serviceType,
          },
        }).catch((err) => console.error("Admin booking accepted notification error:", err));
      } else if (item.status === "COMPLETED") {
        void notifyAllAdmins({
          title: "Booking completed",
          message: `${item.workerName || "Worker"} marked the ${item.serviceType || "service"} request as completed for ${item.homeownerName || "Homeowner"}.`,
          type: "success",
          meta: {
            route: `/admin-requests?requestId=${encodeURIComponent(item.id)}`,
            requestId: item.id,
            requestNumber: item.requestNumber,
            homeownerId: item.homeownerId,
            homeownerName: item.homeownerName,
            workerId: item.targetWorkerId,
            workerName: item.workerName,
            serviceType: item.serviceType,
          },
        }).catch((err) => console.error("Admin booking completed notification error:", err));
      } else if (item.status === "DECLINED") {
        void notifyAllAdmins({
          title: "Booking declined",
          message: `${item.workerName || "Worker"} declined the ${item.serviceType || "service"} request from ${item.homeownerName || "Homeowner"}.${item.declineReason ? ` Reason: ${item.declineReason}` : ""}`,
          type: "warning",
          meta: {
            route: `/admin-requests?requestId=${encodeURIComponent(item.id)}`,
            requestId: item.id,
            requestNumber: item.requestNumber,
            homeownerId: item.homeownerId,
            homeownerName: item.homeownerName,
            workerId: item.targetWorkerId,
            workerName: item.workerName,
            serviceType: item.serviceType,
            declineReason: item.declineReason,
          },
        }).catch((err) => console.error("Admin booking declined notification error:", err));
      } else if (item.status === "CANCELLED") {
        void notifyAllAdmins({
          title: "Booking cancelled",
          message: `${item.workerName || "Worker"} cancelled the ${item.serviceType || "service"} booking #${item.requestNumber || item.id}.${item.declineReason ? ` Reason: ${item.declineReason}` : ""}`,
          type: "warning",
          meta: {
            route: `/admin-requests?requestId=${encodeURIComponent(item.id)}`,
            requestId: item.id,
            requestNumber: item.requestNumber,
            cancelledBy: "worker",
            serviceType: item.serviceType,
            declineReason: item.declineReason,
          },
        }).catch((err) => console.error("Admin booking cancelled notification error:", err));
      }
    } else if (actor === "homeowner" && status === "CANCELLED") {
      void notifyWorkerJobCancelled(item.targetWorkerId, {
        requestId: item.id,
        bookingId: item.id,
        homeownerName: item.homeownerName || "Homeowner",
        homeownerAvatar: item.homeownerAvatar || "",
        serviceType: item.serviceType || "service",
        cancelledBy: "homeowner",
        declineReason: item.declineReason,
        route: "/worker-jobs",
      }).catch((error) => console.error("Worker cancellation notification error:", error));

      void notifyBookingStatus(item.homeownerId, "CANCELLED", {
        requestId: item.id,
        workerId: item.targetWorkerId,
        workerName: item.workerName || "Worker",
        workerAvatar: item.workerAvatar || "",
        cancelledBy: "homeowner",
        declineReason: item.declineReason,
        route: "/homeowner-bookings?tab=Cancelled",
      }).catch((error) => console.error("Homeowner cancellation notification error:", error));

      void notifyAllAdmins({
        title: "Booking cancelled",
        message: `${item.homeownerName || "Homeowner"} cancelled the ${item.serviceType || "service"} booking #${item.requestNumber || item.id}.${item.declineReason ? ` Reason: ${item.declineReason}` : ""}`,
        type: "warning",
        meta: {
          route: `/admin-requests?requestId=${encodeURIComponent(item.id)}`,
          requestId: item.id,
          requestNumber: item.requestNumber,
          cancelledBy: "homeowner",
          serviceType: item.serviceType,
          declineReason: item.declineReason,
        },
      }).catch((err) => console.error("Admin booking cancelled notification error:", err));
    } else if (actor === "admin" && status === "CANCELLED") {
      void notifyWorkerJobCancelled(item.targetWorkerId, {
        requestId: item.id,
        bookingId: item.id,
        homeownerName: item.homeownerName || "Homeowner",
        homeownerAvatar: item.homeownerAvatar || "",
        serviceType: item.serviceType || "service",
        cancelledBy: "admin",
        declineReason: item.declineReason,
        route: "/worker-jobs",
      }).catch((error) => console.error("Worker cancellation notification error:", error));

      void notifyBookingStatus(item.homeownerId, "CANCELLED", {
        requestId: item.id,
        workerId: item.targetWorkerId,
        workerName: item.workerName || "Worker",
        workerAvatar: item.workerAvatar || "",
        cancelledBy: "admin",
        declineReason: item.declineReason,
        route: "/homeowner-bookings?tab=Cancelled",
      }).catch((error) => console.error("Homeowner cancellation notification error:", error));

      void notifyAllAdmins({
        title: "Booking cancelled by admin",
        message: `Administrator cancelled ${item.serviceType || "service"} booking #${item.requestNumber || item.id}.${item.declineReason ? ` Reason: ${item.declineReason}` : ""}`,
        type: "warning",
        meta: {
          route: `/admin-requests?requestId=${encodeURIComponent(item.id)}`,
          requestId: item.id,
          requestNumber: item.requestNumber,
          cancelledBy: "admin",
          serviceType: item.serviceType,
          declineReason: item.declineReason,
        },
      }).catch((err) => console.error("Admin booking cancelled notification error:", err));
    }
    return res.json({ success: true, request: item });
  } catch (error) {
    console.error("Update service request error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const refreshWorkerRating = async (workerId) => {
  if (!workerId) return;
  await refreshStoredWorkerRating(workerId);
};

export const submitServiceRequestReview = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    const { id } = req.params;
    const rating = Number(req.body?.rating);
    const reviewText = String(req.body?.reviewText || "").trim();
    const reviewTags = Array.isArray(req.body?.reviewTags)
      ? req.body.reviewTags.map(String).filter(Boolean)
      : [];

    if (!homeownerId) return res.status(401).json({ success: false, message: "Unauthorized." });
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: "Rating must be between 1 and 5." });
    }

    const lookup = buildRequestLookupFilter(id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });
    const request = await ServiceRequest.findOne({ ...lookup, homeownerId });
    if (!request) {
      return res.status(404).json({ success: false, message: "Service request not found." });
    }
    if (!["COMPLETED"].includes(request.status)) {
      return res.status(400).json({ success: false, message: "You can only review completed requests." });
    }
    if (request.reviewedAt) {
      return res.status(400).json({ success: false, message: "This review has already been submitted." });
    }

    request.reviewRating = rating;
    request.reviewText = reviewText;
    request.reviewTags = reviewTags;
    request.reviewedAt = new Date();
    await request.save();

    const homeowner = await HomeOwner.findById(homeownerId).select("firstName lastName name avatar profileImage profilePicture photoUrl image photo picture").lean();
    await refreshWorkerRating(request.targetWorkerId);
    invalidateHomeownerRequestCache(request.homeownerId);
    invalidateWorkerRequestCache(request.targetWorkerId);
    invalidateAdminRequestCache();

    const full = await populated(ServiceRequest.findById(request._id));
    const item = publish(full, "service-request:updated", { useMongoId: true });
    void notifyWorkerReviewReceived(request.targetWorkerId, {
      requestId: item.id,
      requestNumber: item.requestNumber,
      homeownerId,
      homeownerName:
        [String(homeowner?.firstName || "").trim(), String(homeowner?.lastName || "").trim()]
          .filter(Boolean)
          .join(" ") || String(homeowner?.name || "Homeowner").trim(),
      homeownerAvatar: String(homeowner?.avatar || homeowner?.profileImage || "").trim(),
      homeownerProfileImage: String(homeowner?.profileImage || homeowner?.avatar || "").trim(),
      serviceType: item.serviceType || "service",
      rating,
      reviewText,
      route: "/worker-own-profile",
    }).catch((error) => console.error("Worker review notification error:", error));

    void notifyAdminReviewReceived({
      requestId: item.id,
      requestNumber: item.requestNumber,
      homeownerId,
      homeownerName:
        [String(homeowner?.firstName || "").trim(), String(homeowner?.lastName || "").trim()]
          .filter(Boolean)
          .join(" ") || String(homeowner?.name || "Homeowner").trim(),
      workerId: item.targetWorkerId,
      workerName: item.workerName || "Worker",
      serviceType: item.serviceType || "service",
      rating,
      reviewText,
    }).catch((error) => console.error("Admin review notification error:", error));

    return res.json({ success: true, request: item });
  } catch (error) {
    console.error("Submit service request review error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const submitWorkerServiceRequestReview = async (req, res) => {
  try {
    const workerId = req.user?.id;
    const { id } = req.params;
    const rating = Number(req.body?.rating || req.body?.workerReviewRating);
    const reviewText = String(req.body?.reviewText || req.body?.workerReviewText || "").trim();
    const reviewTags = Array.isArray(req.body?.reviewTags || req.body?.workerReviewTags)
      ? (req.body.reviewTags || req.body.workerReviewTags).map(String).filter(Boolean)
      : [];

    if (!workerId) return res.status(401).json({ success: false, message: "Unauthorized." });
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: "Rating must be between 1 and 5." });
    }

    const lookup = buildRequestLookupFilter(id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });
    const request = await ServiceRequest.findOne({ ...lookup, targetWorkerId: workerId });
    if (!request) {
      return res.status(404).json({ success: false, message: "Service request not found." });
    }
    if (!["COMPLETED"].includes(request.status)) {
      return res.status(400).json({ success: false, message: "You can only review completed requests." });
    }
    if (request.workerReviewedAt) {
      return res.status(400).json({ success: false, message: "This review has already been submitted." });
    }

    request.workerReviewRating = rating;
    request.workerReviewText = reviewText;
    request.workerReviewTags = reviewTags;
    request.workerReviewedAt = new Date();
    await request.save();

    try {
      const homeowner = await HomeOwner.findById(request.homeownerId);
      if (homeowner) {
        const currentCount = Number(homeowner.ratingCount) || 0;
        const currentRating = Number(homeowner.rating) || 5;
        const newCount = currentCount + 1;
        const newRating = Number(((currentRating * currentCount + rating) / newCount).toFixed(1));
        homeowner.rating = newRating;
        homeowner.ratingCount = newCount;
        await homeowner.save();
      }
    } catch (ratingErr) {
      console.error("Failed to update homeowner rating:", ratingErr);
    }

    invalidateHomeownerRequestCache(request.homeownerId);
    invalidateWorkerRequestCache(request.targetWorkerId);
    invalidateAdminRequestCache();

    const full = await populated(ServiceRequest.findById(request._id));
    const item = publish(full, "service-request:updated", { useMongoId: true });
    return res.json({ success: true, request: item });
  } catch (error) {
    console.error("Submit worker service request review error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// A homeowner may remove an unanswered request. Once a worker has acted, use
// the status update endpoint instead so all portals retain the audit trail.
export const deleteServiceRequest = async (req, res) => {
  try {
    const lookup = buildRequestLookupFilter(req.params.id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });
    const request = await ServiceRequest.findOne({ ...lookup, homeownerId: req.user?.id });
    if (!request) return res.status(404).json({ success: false, message: "Service request not found." });
    if (request.status !== "PENDING") return res.status(400).json({ success: false, message: "Only pending requests can be deleted." });
    const full = await populated(ServiceRequest.findById(request._id));
    const item = serialize(full, { useMongoId: true });
    await request.deleteOne();
    invalidateWorkerRequestCache(request.targetWorkerId);
    invalidateHomeownerRequestCache(request.homeownerId);
    emitToHomeowner(item.homeownerId, "service-request:deleted", item);
    emitToWorker(item.targetWorkerId, "service-request:deleted", item);
    emitToAdmin("service-request:deleted", item);
    emitToAdmin("dashboard:refresh", { source: "service-request:deleted" });
    return res.status(204).end();
  } catch (error) {
    console.error("Delete service request error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const getServiceRequestMessages = async (req, res) => {
  try {
    const lookup = buildRequestLookupFilter(req.params.id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });

    const request = await ServiceRequest.findOne(lookup)
      .select("homeownerId targetWorkerId requestNumber messages")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Service request not found." });

    const userId = String(req.user?.id || req.user?._id || req.user?.userId || "").trim();
    const role = String(req.user?.role || "").trim().toLowerCase();
    const homeownerId = String(request.homeownerId?._id || request.homeownerId || "").trim();
    const workerId = String(request.targetWorkerId?._id || request.targetWorkerId || "").trim();

    const isAuthorized =
      role === "admin" ||
      (role === "homeowner" && userId === homeownerId) ||
      (role === "worker" && userId === workerId);

    if (!isAuthorized) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    return res.json({
      success: true,
      requestId: request._id,
      requestNumber: request.requestNumber,
      messages: Array.isArray(request.messages) ? request.messages : [],
    });
  } catch (error) {
    console.error("Get service request messages error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const postServiceRequestMessage = async (req, res) => {
  try {
    const lookup = buildRequestLookupFilter(req.params.id);
    if (!lookup) return res.status(400).json({ success: false, message: "Invalid service request id." });

    const request = await ServiceRequest.findOne(lookup)
      .select("homeownerId targetWorkerId requestNumber status acceptedOn")
      .lean();
    if (!request) return res.status(404).json({ success: false, message: "Service request not found." });

    const userId = String(req.user?.id || req.user?._id || req.user?.userId || "").trim();
    const role = String(req.user?.role || "").trim().toLowerCase();
    const homeownerId = String(request.homeownerId?._id || request.homeownerId || "").trim();
    const workerId = String(request.targetWorkerId?._id || request.targetWorkerId || "").trim();

    const isAuthorized =
      role === "admin" ||
      (role === "homeowner" && userId === homeownerId) ||
      (role === "worker" && userId === workerId);

    if (!isAuthorized) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    if (role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin conversation history is view-only for dispute and audit review.",
      });
    }

    const currentStatus = String(request.status || "").toUpperCase();
    if (["CANCELLED", "CANCELED", "DECLINED"].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: "This booking has been cancelled. Messaging is closed.",
      });
    }
    if (currentStatus === "COMPLETED") {
      return res.status(400).json({
        success: false,
        message: "This booking is marked as Completed. Messaging is closed.",
      });
    }
    const isAccepted = Boolean(
      request.acceptedOn ||
      ["ONGOING", "ACCEPTED", "IN_PROGRESS"].includes(currentStatus)
    );
    if (!isAccepted && currentStatus === "PENDING") {
      return res.status(400).json({
        success: false,
        message: "Chat activates once the skilled worker accepts the booking.",
      });
    }

    const { message = "", attachments = [] } = req.body || {};
    const text = String(message || "").trim();
    const formattedAttachments = Array.isArray(attachments)
      ? attachments
          .filter((att) => att && (att.url || typeof att === "string"))
          .map((att) =>
            typeof att === "string"
              ? { url: att, name: "attachment", fileType: "image" }
              : {
                  url: String(att.url),
                  name: String(att.name || "attachment"),
                  fileType: String(att.fileType || "image"),
                }
          )
      : [];

    if (!text && formattedAttachments.length === 0) {
      return res.status(400).json({ success: false, message: "Message text or attachment is required." });
    }

    let senderName = "User";
    if (role === "homeowner") {
      const ho = await HomeOwner.findById(userId).select("firstName lastName name email").lean();
      senderName = nameOf(ho, "Homeowner");
    } else if (role === "worker") {
      const wk = await Worker.findById(userId).select("firstName lastName name email").lean();
      senderName = nameOf(wk, "Worker");
    } else if (role === "admin") {
      senderName = "TrabaHome Support";
    }

    const newMessage = {
      _id: new Types.ObjectId(),
      senderId: userId,
      senderRole: role,
      senderName,
      message: text,
      attachments: formattedAttachments,
      createdAt: new Date(),
    };

    await ServiceRequest.updateOne(
      { _id: request._id },
      { $push: { messages: newMessage } }
    );

    const socketPayload = {
      requestId: String(request._id),
      requestNumber: request.requestNumber,
      message: newMessage,
    };

    emitToHomeowner(homeownerId, "service-request:message", socketPayload);
    emitToWorker(workerId, "service-request:message", socketPayload);
    emitToAdmin("service-request:message", socketPayload);

    return res.status(201).json({
      success: true,
      message: newMessage,
    });
  } catch (error) {
    console.error("Post service request message error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

export const proposeWorkerReschedule = async (req, res) => {
  try {
    const workerId = req.user?.id;
    const { id } = req.params;
    const { proposedDate, proposedTime, reason } = req.body || {};

    if (!workerId) return res.status(401).json({ success: false, message: "Unauthorized." });
    if (!proposedDate || !String(proposedTime || "").trim()) {
      return res.status(400).json({ success: false, message: "Proposed date and time are required." });
    }

    const request = await ServiceRequest.findById(id);
    if (!request) return res.status(404).json({ success: false, message: "Booking not found." });

    if (String(request.targetWorkerId) !== String(workerId)) {
      return res.status(403).json({ success: false, message: "You can only reschedule your own assigned bookings." });
    }

    if (!["ONGOING", "ACCEPTED"].includes(String(request.status).toUpperCase())) {
      return res.status(400).json({ success: false, message: "Only active, accepted bookings can be rescheduled." });
    }

    const reqDateKey = normalizeDateKey(proposedDate);
    const reqTimeKey = normalizeTimeKey(proposedTime);

    // Validate proposed date is not in past
    const phNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
    const todayKey = `${phNow.getFullYear()}-${String(phNow.getMonth() + 1).padStart(2, "0")}-${String(phNow.getDate()).padStart(2, "0")}`;
    if (reqDateKey < todayKey) {
      return res.status(400).json({ success: false, message: "Proposed date cannot be in the past." });
    }

    request.rescheduleRequest = {
      status: "pending",
      proposedDate: new Date(proposedDate),
      proposedTime: reqTimeKey,
      reason: String(reason || "").trim(),
      proposedBy: "worker",
      requestedAt: new Date(),
      respondedAt: null,
    };

    await request.save();
    invalidateWorkerRequestCache(request.targetWorkerId);
    invalidateHomeownerRequestCache(request.homeownerId);
    invalidateAdminRequestCache();

    const full = await populated(ServiceRequest.findById(request._id));
    const item = publish(full, "service-request:reschedule-proposed", { useMongoId: true });

    createHomeownerNotification({
      homeownerId: request.homeownerId,
      title: "Schedule Change Proposed",
      message: `Your worker proposed to reschedule Request #${request.requestNumber} to ${reqDateKey} at ${reqTimeKey}. Please review and confirm.`,
      type: "reschedule_proposed",
      requestId: request._id,
    });

    return res.status(200).json({
      success: true,
      message: "Reschedule proposal sent to homeowner for confirmation.",
      request: item,
    });
  } catch (error) {
    console.error("Propose worker reschedule error:", error);
    return res.status(500).json({ success: false, message: "Failed to propose reschedule." });
  }
};

export const respondHomeownerReschedule = async (req, res) => {
  try {
    const homeownerId = req.user?.id;
    const { id } = req.params;
    const { action } = req.body || {};

    if (!homeownerId) return res.status(401).json({ success: false, message: "Unauthorized." });
    const cleanAction = String(action || "").toLowerCase().trim();
    if (!["accept", "decline"].includes(cleanAction)) {
      return res.status(400).json({ success: false, message: "Action must be 'accept' or 'decline'." });
    }

    const request = await ServiceRequest.findById(id);
    if (!request) return res.status(404).json({ success: false, message: "Booking not found." });

    if (String(request.homeownerId) !== String(homeownerId)) {
      return res.status(403).json({ success: false, message: "You can only respond to your own bookings." });
    }

    if (!request.rescheduleRequest || request.rescheduleRequest.status !== "pending") {
      return res.status(400).json({ success: false, message: "No pending reschedule proposal found for this booking." });
    }

    const isAccept = cleanAction === "accept";

    if (isAccept) {
      request.preferredDate = request.rescheduleRequest.proposedDate;
      request.preferredTime = request.rescheduleRequest.proposedTime;
      request.rescheduleRequest.status = "confirmed";
      request.rescheduleRequest.respondedAt = new Date();
      await request.save();

      invalidateWorkerRequestCache(request.targetWorkerId);
      invalidateHomeownerRequestCache(request.homeownerId);
      invalidateAdminRequestCache();

      const full = await populated(ServiceRequest.findById(request._id));
      const item = publish(full, "service-request:reschedule-confirmed", { useMongoId: true });

      createWorkerNotification({
        workerId: request.targetWorkerId,
        title: "Reschedule Accepted",
        message: `The homeowner accepted your schedule change for Request #${request.requestNumber}.`,
        type: "reschedule_confirmed",
        requestId: request._id,
      });

      return res.status(200).json({
        success: true,
        message: "New schedule confirmed successfully.",
        request: item,
      });
    } else {
      request.rescheduleRequest.status = "declined";
      request.rescheduleRequest.respondedAt = new Date();
      await request.save();

      invalidateWorkerRequestCache(request.targetWorkerId);
      invalidateHomeownerRequestCache(request.homeownerId);
      invalidateAdminRequestCache();

      const full = await populated(ServiceRequest.findById(request._id));
      const item = publish(full, "service-request:reschedule-declined", { useMongoId: true });

      createWorkerNotification({
        workerId: request.targetWorkerId,
        title: "Reschedule Declined",
        message: `The homeowner declined the proposed schedule change for Request #${request.requestNumber}. Original schedule remains active.`,
        type: "reschedule_declined",
        requestId: request._id,
      });

      return res.status(200).json({
        success: true,
        message: "Reschedule proposal declined. Original schedule remains active.",
        request: item,
      });
    }
  } catch (error) {
    console.error("Respond homeowner reschedule error:", error);
    return res.status(500).json({ success: false, message: "Failed to respond to reschedule proposal." });
  }
};
