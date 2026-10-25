import express from "express";
import jwt from "jsonwebtoken";
import {
  createSupportTicket,
  getMySupportTicket,
  listMySupportTickets,
  replyToMySupportTicket,
} from "../controllers/support/support.controller.js";
import { requireHomeownerAuth } from "../middleware/authHomeowner.js";
import { requireWorkerAuth } from "../middleware/authWorker.js";

const router = express.Router();

const requireSupportUserAuth = (req, res, next) => {
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const decoded = token ? jwt.decode(token) : null;

  return decoded?.role === "worker"
    ? requireWorkerAuth(req, res, next)
    : requireHomeownerAuth(req, res, next);
};

router.post("/tickets", requireSupportUserAuth, createSupportTicket);
router.get("/tickets", requireSupportUserAuth, listMySupportTickets);
router.get("/tickets/:id", requireSupportUserAuth, getMySupportTicket);
router.post("/tickets/:id/replies", requireSupportUserAuth, replyToMySupportTicket);

export default router;
