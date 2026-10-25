import express from "express";
import {
  getWorkers,
  getWorkerById,
  getWorkerIdDocumentsSignedUrl,
  createWorkerByAdmin,
  listBookings,
  listSupportTickets,
  updateHomeownerStatus,
  updateSupportTicketStatus,
  updateWorkerInformation,
  updateWorkerStatus,
  getPendingWorkerProfileUpdates,
  reviewWorkerProfileUpdate,
} from "../controllers/admin-auth/admin.worker.controller.js";
import { requireAdminAuth } from "../middleware/authAdmin.js";
import {
  getAdminSupportTicket,
  replyToSupportTicketAsAdmin,
} from "../controllers/support/support.controller.js";

const router = express.Router();

router.get("/workers", requireAdminAuth, getWorkers);
router.get("/workers/:id", requireAdminAuth, getWorkerById);
router.get("/workers/:id/id-documents/signed-url", requireAdminAuth, getWorkerIdDocumentsSignedUrl);
router.post("/workers", requireAdminAuth, createWorkerByAdmin);
router.get("/bookings", requireAdminAuth, listBookings);
router.get("/support/tickets", requireAdminAuth, listSupportTickets);
router.get("/support/tickets/:id", requireAdminAuth, getAdminSupportTicket);
router.post("/support/tickets/:id/replies", requireAdminAuth, replyToSupportTicketAsAdmin);
router.patch("/support/tickets/:id/status", requireAdminAuth, updateSupportTicketStatus);
router.get("/workers/profile-updates", requireAdminAuth, getPendingWorkerProfileUpdates);
router.patch("/workers/:id/profile-update", requireAdminAuth, reviewWorkerProfileUpdate);
router.patch("/workers/:id", requireAdminAuth, updateWorkerInformation);
router.patch("/workers/:id/status", requireAdminAuth, updateWorkerStatus);
router.patch("/homeowners/:id/status", requireAdminAuth, updateHomeownerStatus);

export default router;
