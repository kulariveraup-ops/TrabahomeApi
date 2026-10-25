import express from "express";
import {
  getWorkerNotifications,
  markWorkerNotificationRead,
  markWorkerNotificationsReadAll,
} from "../controllers/worker-auth/notification.controller.js";
import { requireWorkerAuth } from "../middleware/authWorker.js";

const router = express.Router();

router.get("/", requireWorkerAuth, getWorkerNotifications);
router.post("/:id/read", requireWorkerAuth, markWorkerNotificationRead);
router.post("/read-all", requireWorkerAuth, markWorkerNotificationsReadAll);

export default router;
