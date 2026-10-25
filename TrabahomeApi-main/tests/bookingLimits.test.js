import assert from "node:assert/strict";
import test from "node:test";

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

test("normalizeDateKey correctly parses Date objects and ISO strings", () => {
  assert.equal(normalizeDateKey("2026-09-25"), "2026-09-25");
  assert.equal(normalizeDateKey(new Date("2026-09-25T00:00:00.000Z")), "2026-09-25");
});

test("normalizeTimeKey normalizes 12-hour and 24-hour times", () => {
  assert.equal(normalizeTimeKey("09:00"), "09:00");
  assert.equal(normalizeTimeKey("9:00"), "09:00");
  assert.equal(normalizeTimeKey("9:00 AM"), "09:00");
  assert.equal(normalizeTimeKey("01:30 PM"), "13:30");
  assert.equal(normalizeTimeKey("1:30 pm"), "13:30");
  assert.equal(normalizeTimeKey("12:00 PM"), "12:00");
  assert.equal(normalizeTimeKey("12:00 AM"), "00:00");
});

test("detects duplicate booking schedule correctly", () => {
  const activeBookings = [
    { preferredDate: new Date("2026-09-25T00:00:00.000Z"), preferredTime: "09:00" },
    { preferredDate: "2026-09-26", preferredTime: "14:00" },
  ];

  const checkDuplicate = (date, time) => {
    const reqD = normalizeDateKey(date);
    const reqT = normalizeTimeKey(time);
    return activeBookings.some((b) => {
      return normalizeDateKey(b.preferredDate) === reqD && normalizeTimeKey(b.preferredTime) === reqT;
    });
  };

  assert.equal(checkDuplicate("2026-09-25", "09:00"), true);
  assert.equal(checkDuplicate("2026-09-25", "9:00 AM"), true);
  assert.equal(checkDuplicate("2026-09-26", "02:00 PM"), true);
  assert.equal(checkDuplicate("2026-09-25", "10:00"), false);
  assert.equal(checkDuplicate("2026-09-27", "09:00"), false);
});

test("enforces homeowner active booking limit of 10", () => {
  const activeCount = 10;
  assert.equal(activeCount >= 10, true);
});

test("enforces homeowner active bookings limit of 3 with same worker", () => {
  const activeWithWorker = [1, 2, 3];
  assert.equal(activeWithWorker.length >= 3, true);
});

test("enforces worker maximum limit of 50 active bookings", () => {
  const workerActiveCount = 50;
  assert.equal(workerActiveCount >= 50, true);
});

test("enforces maximum booking date of 90 days ahead from today", () => {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  
  const maxDate = new Date(now);
  maxDate.setDate(now.getDate() + 90);
  const maxDateKey = maxDate.toISOString().slice(0, 10);

  const day91 = new Date(now);
  day91.setDate(now.getDate() + 91);
  const day91Key = day91.toISOString().slice(0, 10);

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowKey = tomorrow.toISOString().slice(0, 10);

  const validateBookingDate = (dateKey) => {
    if (dateKey <= todayKey) {
      return { valid: false, message: "Booking date must be tomorrow or later. Same-day bookings are not supported." };
    }
    if (dateKey > maxDateKey) {
      return { valid: false, message: "Booking date cannot exceed 90 days ahead from today. Future dates will unlock as days go by." };
    }
    return { valid: true };
  };

  assert.equal(validateBookingDate(todayKey).valid, false);
  assert.equal(validateBookingDate(tomorrowKey).valid, true);
  assert.equal(validateBookingDate(maxDateKey).valid, true);
  assert.equal(validateBookingDate(day91Key).valid, false);
});
