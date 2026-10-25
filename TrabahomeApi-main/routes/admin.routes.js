import express from "express";
import {
  listHomeowners,
  createHomeownerByAdmin,
  updateHomeownerInformation,
  listEmailLogs,
  getDashboardStats,
  registerAdmin,
  loginAdmin,
} from "../controllers/admin-auth/admin.controller.js";
import { verifyAdminLoginOtp, resendAdminLoginOtp } from "../controllers/auth/otp.controller.js";
import { requireAdminAuth } from "../middleware/authAdmin.js";
import { getSharedHomeownerProfile } from "../controllers/homeOwner-auth/homeOwner.controller.js";
import {
  getAdminNotifications,
  markAdminNotificationRead,
  markAdminNotificationsReadAll,
} from "../controllers/admin-auth/admin.notification.controller.js";

const router = express.Router();

router.post("/register", registerAdmin);
router.post("/login", loginAdmin);
router.post("/verify-login-otp", verifyAdminLoginOtp);
router.post("/verify-otp", verifyAdminLoginOtp);
router.post("/resend-login-otp", resendAdminLoginOtp);
router.post("/resend-otp", resendAdminLoginOtp);
router.post("/logout", (_req, res) => res.status(200).json({ success: true, message: "Logged out successfully." }));
router.get("/dashboard", requireAdminAuth, getDashboardStats);
router.get("/homeowner-profiles/:id", requireAdminAuth, getSharedHomeownerProfile);
router.get("/homeowners", requireAdminAuth, listHomeowners);
router.post("/homeowners", requireAdminAuth, createHomeownerByAdmin);
router.patch("/homeowners/:id", requireAdminAuth, updateHomeownerInformation);
router.get("/email-logs", requireAdminAuth, listEmailLogs);
router.get("/emaillogs", requireAdminAuth, listEmailLogs);
router.get("/notifications", requireAdminAuth, getAdminNotifications);
router.post("/notifications/:id/read", requireAdminAuth, markAdminNotificationRead);
router.post("/notifications/read-all", requireAdminAuth, markAdminNotificationsReadAll);

export default router;
