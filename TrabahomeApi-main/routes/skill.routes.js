import express from "express";
import {
  getActiveSkills,
  getAllSkillsAdmin,
  createSkill,
  updateSkill,
  deleteSkill,
} from "../controllers/skill.controller.js";
import { requireAdminAuth } from "../middleware/authAdmin.js";

const router = express.Router();

// Public / User routes
router.get("/", getActiveSkills);

// Admin-only management routes
router.get("/admin", requireAdminAuth, getAllSkillsAdmin);
router.post("/admin", requireAdminAuth, createSkill);
router.patch("/admin/:id", requireAdminAuth, updateSkill);
router.delete("/admin/:id", requireAdminAuth, deleteSkill);

export default router;
