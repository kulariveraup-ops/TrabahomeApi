import express from "express";
import {
  getHomeownerNotifications,
  markHomeownerNotificationRead,
  markHomeownerNotificationsReadAll,
} from "../controllers/homeOwner-auth/notification.controller.js";
import { requireHomeownerAuth } from "../middleware/authHomeowner.js";

const router = express.Router();

router.get("/", requireHomeownerAuth, getHomeownerNotifications);
router.post("/:id/read", requireHomeownerAuth, markHomeownerNotificationRead);
router.post("/read-all", requireHomeownerAuth, markHomeownerNotificationsReadAll);

export default router;
