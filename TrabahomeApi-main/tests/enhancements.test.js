import assert from "node:assert/strict";
import test from "node:test";

// ── 1. Uncapped Skills Tests ──────────────────────────────────────────
test("Uncapped skills: allows workers to have more than 8 skills", () => {
  const nineSkills = [
    "Plumbing", "Carpentry", "Electrical", "Welding", "Painting",
    "Aircon Repair", "Masonry", "Appliance Repair", "Tile Setting"
  ];
  
  const validateSkills = (skills) => {
    if (!Array.isArray(skills) || skills.length < 1) {
      return { valid: false, error: "At least 1 skill is required." };
    }
    // No upper cap!
    return { valid: true };
  };

  assert.equal(validateSkills(nineSkills).valid, true);
  assert.equal(validateSkills(["Plumbing"]).valid, true);
  assert.equal(validateSkills([]).valid, false);
});

// ── 2. Worker Profile Update Request & Admin Approval ─────────────────
test("Worker Profile Update Request: state transitions and validation", () => {
  const initialWorker = {
    _id: "worker123",
    fullName: "Juan Dela Cruz",
    phone: "09123456789",
    city: "Dagupan City",
    barangay: "Pantal",
    profession: "Plumbing, Electrical",
    pendingProfileUpdate: null,
  };

  // Step A: Worker submits an update request
  const submitUpdateRequest = (worker, fields, notes = "") => {
    return {
      ...worker,
      pendingProfileUpdate: {
        status: "pending",
        requestedAt: new Date("2026-10-21T08:00:00.000Z"),
        reviewedAt: null,
        declineReason: "",
        fields: {
          fullName: fields.fullName || worker.fullName,
          phone: fields.phone || worker.phone,
          city: fields.city || worker.city,
          barangay: fields.barangay || worker.barangay,
          skills: fields.skills || worker.profession.split(",").map((s) => s.trim()),
        },
        notes,
      },
    };
  };

  const pendingWorker = submitUpdateRequest(
    initialWorker,
    {
      fullName: "Juan S. Dela Cruz",
      phone: "09987654321",
      city: "Lingayen",
      barangay: "Poblacion",
      skills: ["Plumbing", "Electrical", "Carpentry", "Welding"],
    },
    "Relocated and added trade skills"
  );

  assert.equal(pendingWorker.pendingProfileUpdate.status, "pending");
  assert.equal(pendingWorker.fullName, "Juan Dela Cruz"); // Core profile unapproved yet

  // Step B: Admin Approves
  const approveUpdateRequest = (worker) => {
    const update = worker.pendingProfileUpdate;
    if (!update || update.status !== "pending") {
      throw new Error("No pending update to approve");
    }
    return {
      ...worker,
      fullName: update.fields.fullName || worker.fullName,
      phone: update.fields.phone || worker.phone,
      city: update.fields.city || worker.city,
      barangay: update.fields.barangay || worker.barangay,
      profession: update.fields.skills ? update.fields.skills.join(", ") : worker.profession,
      pendingProfileUpdate: {
        ...update,
        status: "approved",
        reviewedAt: new Date("2026-10-21T09:00:00.000Z"),
      },
    };
  };

  const approvedWorker = approveUpdateRequest(pendingWorker);
  assert.equal(approvedWorker.fullName, "Juan S. Dela Cruz");
  assert.equal(approvedWorker.phone, "09987654321");
  assert.equal(approvedWorker.city, "Lingayen");
  assert.equal(approvedWorker.profession, "Plumbing, Electrical, Carpentry, Welding");
  assert.equal(approvedWorker.pendingProfileUpdate.status, "approved");

  // Step C: Admin Declines with reason
  const declineUpdateRequest = (worker, reason) => {
    const update = worker.pendingProfileUpdate;
    if (!update || update.status !== "pending") {
      throw new Error("No pending update to decline");
    }
    return {
      ...worker, // Original fields preserved!
      pendingProfileUpdate: {
        ...update,
        status: "rejected",
        declineReason: reason,
        reviewedAt: new Date("2026-10-21T09:00:00.000Z"),
      },
    };
  };

  const declinedWorker = declineUpdateRequest(pendingWorker, "Phone number could not be verified.");
  assert.equal(declinedWorker.fullName, "Juan Dela Cruz"); // Preserved
  assert.equal(declinedWorker.pendingProfileUpdate.status, "rejected");
  assert.equal(declinedWorker.pendingProfileUpdate.declineReason, "Phone number could not be verified.");
});

// ── 3. PHP Starting Rates & Dynamic Price Lookup ──────────────────────
test("Skills and Starting Price: resolves starting price in Philippine Peso (PHP)", () => {
  const seededSkills = [
    { name: "Plumbing", category: "Plumbing", startingPrice: 500 },
    { name: "Aircon Repair & Maintenance", category: "HVAC", startingPrice: 750 },
    { name: "Electrical & Wiring", category: "Electrical", startingPrice: 550 },
    { name: "Carpentry & Woodwork", category: "Carpentry", startingPrice: 600 },
  ];

  const resolveStartingCost = (serviceType, skills) => {
    const normalized = String(serviceType || "").trim().toLowerCase();
    const match = skills.find(
      (s) => String(s.name || "").trim().toLowerCase() === normalized
    );
    return match?.startingPrice ?? 500;
  };

  assert.equal(resolveStartingCost("Plumbing", seededSkills), 500);
  assert.equal(resolveStartingCost("aircon repair & maintenance", seededSkills), 750);
  assert.equal(resolveStartingCost("Electrical & Wiring", seededSkills), 550);
  assert.equal(resolveStartingCost("Unknown Custom Service", seededSkills), 500); // Default fallback
});

// ── 4. Same-Day Booking Window Validation (Manila Timezone) ───────────
test("Same-Day Booking Window: 12:00 AM - 10:00 AM allows 1:00 PM+ today; 10:01 AM restricts to tomorrow", () => {
  const checkBookingWindow = (manilaHour, manilaMinute, requestedDate, requestedTime, todayStr, tomorrowStr) => {
    const isSameDay = requestedDate === todayStr;
    const isMorningWindow = manilaHour < 10 || (manilaHour === 10 && manilaMinute === 0);

    if (isSameDay) {
      if (!isMorningWindow) {
        return {
          allowed: false,
          error: "Same-day booking cutoff reached (10:00 AM). Bookings must be scheduled from tomorrow onwards.",
        };
      }

      // Check afternoon requirement (1:00 PM / 13:00 onwards)
      const [h, m] = requestedTime.split(":").map((v) => parseInt(v, 10));
      const reqMinutes = h * 60 + (m || 0);
      if (reqMinutes < 13 * 60) {
        return {
          allowed: false,
          error: "Same-day booking requires appointment in the afternoon (1:00 PM / 13:00 onwards).",
        };
      }
    }

    if (requestedDate < (isMorningWindow ? todayStr : tomorrowStr)) {
      return { allowed: false, error: "Booking date cannot be in the past." };
    }

    return { allowed: true };
  };

  const today = "2026-10-21";
  const tomorrow = "2026-10-22";

  // Case 1: At 8:30 AM, book today at 2:00 PM (14:00) -> PASS
  const case1 = checkBookingWindow(8, 30, today, "14:00", today, tomorrow);
  assert.equal(case1.allowed, true);

  // Case 2: At 8:30 AM, book today at 10:00 AM (morning) -> FAIL (Must be 1 PM onwards)
  const case2 = checkBookingWindow(8, 30, today, "10:00", today, tomorrow);
  assert.equal(case2.allowed, false);
  assert.match(case2.error, /1:00 PM/);

  // Case 3: At 10:00 AM exactly, book today at 1:30 PM (13:30) -> PASS (10:00 AM is inclusive)
  const case3 = checkBookingWindow(10, 0, today, "13:30", today, tomorrow);
  assert.equal(case3.allowed, true);

  // Case 4: At 10:01 AM, book today at 2:00 PM -> FAIL (Cutoff reached, only tomorrow allowed)
  const case4 = checkBookingWindow(10, 1, today, "14:00", today, tomorrow);
  assert.equal(case4.allowed, false);
  assert.match(case4.error, /cutoff reached/i);

  // Case 5: At 10:01 AM, book tomorrow at 9:00 AM -> PASS
  const case5 = checkBookingWindow(10, 1, tomorrow, "09:00", today, tomorrow);
  assert.equal(case5.allowed, true);

  // Case 6: At 3:00 PM (15:00), book today -> FAIL
  const case6 = checkBookingWindow(15, 0, today, "16:00", today, tomorrow);
  assert.equal(case6.allowed, false);
  assert.match(case6.error, /cutoff reached/i);
});

// ── 5. Worker Reschedule Negotiation Workflow ─────────────────────────
test("Worker Reschedule Negotiation: Worker proposes, Homeowner accepts or declines", () => {
  const initialBooking = {
    id: "booking-001",
    status: "Accepted",
    preferredDate: "2026-10-23",
    preferredTime: "09:00",
    scheduledAt: "2026-10-23T09:00:00.000Z",
    rescheduleRequest: {
      status: "none",
    },
  };

  // Step A: Worker proposes reschedule
  const proposeReschedule = (booking, proposedDate, proposedTime, reason = "") => {
    if (!["Accepted", "In Progress"].includes(booking.status)) {
      throw new Error("Reschedule can only be proposed on accepted or in-progress bookings.");
    }
    return {
      ...booking,
      rescheduleRequest: {
        status: "pending",
        proposedDate,
        proposedTime,
        reason,
        proposedBy: "worker",
        proposedAt: new Date("2026-10-21T10:00:00.000Z"),
        respondedAt: null,
      },
    };
  };

  const pendingReschedule = proposeReschedule(
    initialBooking,
    "2026-10-24",
    "14:00",
    "Delayed on previous job"
  );

  assert.equal(pendingReschedule.rescheduleRequest.status, "pending");
  assert.equal(pendingReschedule.preferredDate, "2026-10-23"); // Original date untouched until accepted

  // Step B: Homeowner Accepts Reschedule
  const respondReschedule = (booking, action) => {
    if (booking.rescheduleRequest?.status !== "pending") {
      throw new Error("No pending reschedule request to respond to.");
    }

    if (action === "accept") {
      return {
        ...booking,
        preferredDate: booking.rescheduleRequest.proposedDate,
        preferredTime: booking.rescheduleRequest.proposedTime,
        scheduledAt: `${booking.rescheduleRequest.proposedDate}T${booking.rescheduleRequest.proposedTime}:00.000Z`,
        rescheduleRequest: {
          ...booking.rescheduleRequest,
          status: "accepted",
          respondedAt: new Date("2026-10-21T11:00:00.000Z"),
        },
      };
    }

    if (action === "decline") {
      return {
        ...booking, // Original schedule preserved
        rescheduleRequest: {
          ...booking.rescheduleRequest,
          status: "declined",
          respondedAt: new Date("2026-10-21T11:00:00.000Z"),
        },
      };
    }

    throw new Error("Invalid action: must be accept or decline");
  };

  // Acceptance test
  const acceptedBooking = respondReschedule(pendingReschedule, "accept");
  assert.equal(acceptedBooking.preferredDate, "2026-10-24");
  assert.equal(acceptedBooking.preferredTime, "14:00");
  assert.equal(acceptedBooking.rescheduleRequest.status, "accepted");

  // Decline test
  const declinedBooking = respondReschedule(pendingReschedule, "decline");
  assert.equal(declinedBooking.preferredDate, "2026-10-23"); // Preserved original date!
  assert.equal(declinedBooking.preferredTime, "09:00"); // Preserved original time!
  assert.equal(declinedBooking.rescheduleRequest.status, "declined");
});
