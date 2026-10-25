import express from "express";
import {
  requestForgotPasswordOtp,
  verifyOtp,
  resetPassword,
} from "../controllers/auth/otp.controller.js";
import {
  isValidEmail,
  normalizeEmail,
  isHomeownerEmailTaken,
  isWorkerEmailTaken,
  isAdminEmailTaken,
} from "../utils/auth.utils.js";

const router = express.Router();

const handleCheckEmail = async (req, res) => {
  try {
    const rawEmail = req.query?.email || req.body?.email;
    const role = String(req.query?.role || req.body?.role || "homeowner").toLowerCase();
    const normalizedEmail = normalizeEmail(rawEmail);

    if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        available: false,
        message: "Please enter a valid email address.",
      });
    }

    let isTaken = false;
    let roleLabel = "homeowner";
    if (role === "worker") {
      isTaken = await isWorkerEmailTaken(normalizedEmail);
      roleLabel = "skilled worker";
    } else if (role === "admin") {
      isTaken = await isAdminEmailTaken(normalizedEmail);
      roleLabel = "admin";
    } else {
      isTaken = await isHomeownerEmailTaken(normalizedEmail);
      roleLabel = "homeowner";
    }

    if (isTaken) {
      return res.status(200).json({
        success: true,
        available: false,
        message: `This email is already registered as a ${roleLabel}.`,
      });
    }

    return res.status(200).json({
      success: true,
      available: true,
      message: "Email is available.",
    });
  } catch (error) {
    console.error("Auth check-email error:", error);
    return res.status(500).json({
      success: false,
      available: false,
      message: "Unable to check email availability.",
    });
  }
};

router.get("/check-email", handleCheckEmail);
router.post("/check-email", handleCheckEmail);
router.post("/otp/request", requestForgotPasswordOtp);
router.post("/otp/verify", verifyOtp);
router.post("/reset-password", resetPassword);

export default router;
