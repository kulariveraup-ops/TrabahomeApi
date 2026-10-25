import express from "express";
import {
  registerHomeOwner,
  requestHomeownerRegistrationOtp,
  checkHomeownerEmailAvailability,
  loginHomeOwner,
  getHomeownerMe,
  updateHomeownerMe,
  getSharedHomeownerProfile,
  updateHomeownerInitialPassword,
  markGuideSeen,
} from "../controllers/homeOwner-auth/homeOwner.controller.js";
import {
  deleteSavedWorker,
  listSavedWorkers,
  toggleSavedWorker,
} from "../controllers/homeOwner-auth/savedWorkers.controller.js";
import {
  cancelHomeownerBooking,
  createBooking,
  listHomeownerBookings,
} from "../controllers/homeOwner-auth/bookings.controller.js";
import {
  resendHomeOwnerLoginOtp,
  verifyHomeOwnerLoginOtp,
  requestHomeownerChangePasswordOtp,
  changeHomeownerPassword,
} from "../controllers/auth/otp.controller.js";
import { requireHomeownerAuth } from "../middleware/authHomeowner.js";

const router = express.Router();

router.get("/check-email", checkHomeownerEmailAvailability);
router.post("/check-email", checkHomeownerEmailAvailability);
router.post("/register/send-otp", requestHomeownerRegistrationOtp);
router.post("/register/request-otp", requestHomeownerRegistrationOtp);
router.post("/register", registerHomeOwner);
router.post("/login", loginHomeOwner);
router.post("/verify-login-otp", verifyHomeOwnerLoginOtp);
router.post("/verify-otp", verifyHomeOwnerLoginOtp);
router.post("/resend-login-otp", resendHomeOwnerLoginOtp);
router.post("/logout", (_req, res) => res.status(200).json({ success: true, message: "Logged out successfully." }));

router.get("/me", requireHomeownerAuth, getHomeownerMe);
router.patch("/me", requireHomeownerAuth, updateHomeownerMe);
router.get("/homeowner-profiles/:id", requireHomeownerAuth, getSharedHomeownerProfile);
router.post("/change-password/request-otp", requireHomeownerAuth, requestHomeownerChangePasswordOtp);
router.post("/change-password", requireHomeownerAuth, changeHomeownerPassword);
router.post("/update-initial-password", requireHomeownerAuth, updateHomeownerInitialPassword);
router.patch("/guide-seen", requireHomeownerAuth, markGuideSeen);

router.post(
  "/saved-workers/:workerId",
  requireHomeownerAuth,
  toggleSavedWorker
);
router.get("/saved-workers", requireHomeownerAuth, listSavedWorkers);
router.delete(
  "/saved-workers/:workerId",
  requireHomeownerAuth,
  deleteSavedWorker
);

router.post("/bookings", requireHomeownerAuth, createBooking);
router.get("/bookings", requireHomeownerAuth, listHomeownerBookings);
router.patch("/bookings/:id/cancel", requireHomeownerAuth, cancelHomeownerBooking);

export default router;
