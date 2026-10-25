// routes/worker.routes.js
import express from 'express';
import {
  registerWorker,
  checkWorkerEmailAvailability,
  getAllWorkers,
  getWorkerById,
  getWorkerMe,
  signInWorker,
  searchWorkers,
  updateWorkerMe,
  updateWorkerById,
  verifyWorkerId,
  updateWorkerInitialPassword,
  markWorkerGuideSeen,
  requestProfileUpdate,
} from '../controllers/worker-auth/worker.controller.js';
import { changeWorkerPassword, requestWorkerChangePasswordOtp, resendWorkerLoginOtp, verifyWorkerLoginOtp } from '../controllers/auth/otp.controller.js';
import { requireWorkerAuth } from "../middleware/authWorker.js";
import { updateWorkerBookingStatus, listWorkerBookings } from "../controllers/worker-auth/bookings.controller.js";
import { getSharedHomeownerProfile } from "../controllers/homeOwner-auth/homeOwner.controller.js";

import { uploadMiddleware, handleUploadError } from "../middleware/uploadMiddleware.js";

const router = express.Router();

router.get('/check-email', checkWorkerEmailAvailability);
router.post('/check-email', checkWorkerEmailAvailability);

router.post('/register', uploadMiddleware.fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'profileImage', maxCount: 1 },
  { name: 'proofOfWork', maxCount: 10 },
  { name: 'idCard', maxCount: 1 },
  { name: 'idFront', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
]), handleUploadError, registerWorker);
router.post('/verify-id', uploadMiddleware.fields([
  { name: 'idCard', maxCount: 1 },
  { name: 'idFront', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
]), handleUploadError, verifyWorkerId);
router.post('/signin', signInWorker);
router.post('/login', signInWorker);
router.post('/verify-login-otp', verifyWorkerLoginOtp);
router.post('/verify-otp', verifyWorkerLoginOtp);
router.post('/resend-login-otp', resendWorkerLoginOtp);
router.post('/logout', (_req, res) => res.status(200).json({ success: true, message: 'Logged out successfully.' }));
router.get('/me', requireWorkerAuth, getWorkerMe);
router.patch('/me', requireWorkerAuth, updateWorkerMe);
router.post('/profile-update-request', requireWorkerAuth, requestProfileUpdate);
router.post('/change-password/request-otp', requireWorkerAuth, requestWorkerChangePasswordOtp);
router.post('/change-password', requireWorkerAuth, changeWorkerPassword);
router.post('/update-initial-password', requireWorkerAuth, updateWorkerInitialPassword);
router.patch('/guide-seen', requireWorkerAuth, markWorkerGuideSeen);
router.patch('/:id', requireWorkerAuth, updateWorkerById);
router.get('/bookings', requireWorkerAuth, listWorkerBookings);
router.patch('/bookings/:id/status', requireWorkerAuth, updateWorkerBookingStatus);
router.get('/homeowner-profiles/:id', requireWorkerAuth, getSharedHomeownerProfile);
router.get('/search', searchWorkers);

router.get('/', getAllWorkers);
router.get('/:id', getWorkerById);

export default router;
