import ServiceRequest from "../models/serviceRequest.Model.js";
import {
  createHomeownerNotification,
  createWorkerNotification,
  notifyAllAdmins,
} from "./notify.js";
import { emitToAdmin, emitToHomeowner, emitToWorker } from "./socket.js";

const parseTimeToMinutes = (timeStr) => {
  const str = String(timeStr || "").trim();
  if (!str) return 0;
  const m12 = str.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const m = parseInt(m12[2], 10);
    const isPM = m12[3].toUpperCase() === "PM";
    if (isPM && h < 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return h * 60 + m;
  }
  const m24 = str.match(/^(\d{1,2}):(\d{2})/);
  if (m24) {
    return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
  }
  return 0;
};

const getPhilippineDateTime = () => {
  const now = new Date();
  // Philippine Time (PHT) is UTC+8
  const phtDate = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dateStr = phtDate.toISOString().slice(0, 10);
  const hours = phtDate.getUTCHours();
  const minutes = phtDate.getUTCMinutes();
  const currentMinutes = hours * 60 + minutes;
  return { dateStr, currentMinutes };
};

export const checkScheduledBookings = async () => {
  try {
    const { dateStr: phtDateStr, currentMinutes: phtCurrentMinutes } = getPhilippineDateTime();

    const bookings = await ServiceRequest.find({
      status: { $in: ["ONGOING", "ACCEPTED"] },
      $or: [
        { midnightReminderSent: { $ne: true } },
        { inProgressNotified: { $ne: true } },
      ],
    })
      .populate("homeownerId", "firstName lastName name email")
      .populate("targetWorkerId", "firstName lastName name email")
      .lean();

    if (!bookings || bookings.length === 0) return;

    for (const booking of bookings) {
      const bDate = new Date(booking.preferredDate);
      if (isNaN(bDate.getTime())) continue;
      const bookingDateStr = bDate.toISOString().slice(0, 10);

      const homeownerId = String(booking.homeownerId?._id || booking.homeownerId || "");
      const workerId = String(booking.targetWorkerId?._id || booking.targetWorkerId || "");
      const homeownerName =
        [booking.homeownerId?.firstName, booking.homeownerId?.lastName].filter(Boolean).join(" ") ||
        booking.homeownerId?.name ||
        "Homeowner";
      const workerName =
        [booking.targetWorkerId?.firstName, booking.targetWorkerId?.lastName].filter(Boolean).join(" ") ||
        booking.targetWorkerId?.name ||
        "Worker";
      const serviceType = booking.serviceType || "service";
      const preferredTime = booking.preferredTime || "scheduled time";
      const requestNumber = booking.requestNumber || String(booking._id);
      const scheduledMinutes = parseTimeToMinutes(booking.preferredTime);

      // 1. Midnight Reminder (notified on the scheduled date at 12:00 AM)
      if (!booking.midnightReminderSent && bookingDateStr <= phtDateStr) {
        await ServiceRequest.updateOne(
          { _id: booking._id },
          { $set: { midnightReminderSent: true } }
        );

        if (homeownerId) {
          void createHomeownerNotification({
            userId: homeownerId,
            title: "Booking Reminder",
            message: `Reminder: You have a scheduled ${serviceType} appointment with ${workerName} today at ${preferredTime}.`,
            type: "info",
            meta: {
              route: "/homeowner-bookings?tab=Ongoing",
              requestId: String(booking._id),
              bookingId: String(booking._id),
              requestNumber,
              workerId,
              workerName,
              serviceType,
              preferredDate: booking.preferredDate,
              preferredTime,
            },
          }).catch((err) => console.error("Midnight reminder homeowner notification error:", err));
        }

        if (workerId) {
          void createWorkerNotification({
            userId: workerId,
            title: "Job Reminder",
            message: `Reminder: You have a scheduled ${serviceType} job with ${homeownerName} today at ${preferredTime}.`,
            type: "info",
            meta: {
              route: "/worker-jobs",
              requestId: String(booking._id),
              bookingId: String(booking._id),
              requestNumber,
              homeownerId,
              homeownerName,
              serviceType,
              preferredDate: booking.preferredDate,
              preferredTime,
            },
          }).catch((err) => console.error("Midnight reminder worker notification error:", err));
        }
      }

      // 2. Booking in progress (notified on the scheduled date and time)
      const isTimeReached =
        bookingDateStr < phtDateStr ||
        (bookingDateStr === phtDateStr && phtCurrentMinutes >= scheduledMinutes);

      if (!booking.inProgressNotified && isTimeReached) {
        await ServiceRequest.updateOne(
          { _id: booking._id },
          { $set: { inProgressNotified: true } }
        );

        if (homeownerId) {
          void createHomeownerNotification({
            userId: homeownerId,
            title: "Booking in progress",
            message: `Your ${serviceType} booking with ${workerName} is now in progress.`,
            type: "info",
            meta: {
              route: "/homeowner-bookings?tab=Ongoing",
              requestId: String(booking._id),
              bookingId: String(booking._id),
              requestNumber,
              workerId,
              workerName,
              serviceType,
            },
          }).catch((err) => console.error("In-progress homeowner notification error:", err));

          emitToHomeowner(homeownerId, "service-request:in-progress", {
            id: String(booking._id),
            requestNumber,
            status: "IN_PROGRESS",
          });
        }

        if (workerId) {
          void createWorkerNotification({
            userId: workerId,
            title: "Job in progress",
            message: `Your ${serviceType} job with ${homeownerName} is now in progress.`,
            type: "info",
            meta: {
              route: "/worker-jobs",
              requestId: String(booking._id),
              bookingId: String(booking._id),
              requestNumber,
              homeownerId,
              homeownerName,
              serviceType,
            },
          }).catch((err) => console.error("In-progress worker notification error:", err));

          emitToWorker(workerId, "service-request:in-progress", {
            id: String(booking._id),
            requestNumber,
            status: "IN_PROGRESS",
          });
        }

        void notifyAllAdmins({
          title: "Booking in progress",
          message: `${serviceType} booking #${requestNumber} between ${homeownerName} and ${workerName} is now in progress.`,
          type: "info",
          meta: {
            route: `/admin-requests?requestId=${encodeURIComponent(String(booking._id))}`,
            requestId: String(booking._id),
            requestNumber,
            homeownerId,
            homeownerName,
            workerId,
            workerName,
            serviceType,
          },
        }).catch((err) => console.error("In-progress admin notification error:", err));

        emitToAdmin("service-request:in-progress", {
          id: String(booking._id),
          requestNumber,
          status: "IN_PROGRESS",
        });
        emitToAdmin("dashboard:refresh", { source: "service-request:in-progress" });
      }
    }
  } catch (err) {
    console.error("Booking schedule checker error:", err);
  }
};

export const startBookingScheduler = () => {
  console.log("[SCHEDULER] Booking schedule reminder & in-progress service started.");
  void checkScheduledBookings();
  setInterval(checkScheduledBookings, 30_000);
};
