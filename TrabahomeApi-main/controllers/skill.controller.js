import Skill from "../models/skill.Model.js";

// GET /api/skills - Public / Authenticated list of active skills
export const getActiveSkills = async (req, res) => {
  try {
    const skills = await Skill.find({ isActive: true })
      .select("name category startingPrice description isActive")
      .sort({ name: 1 })
      .lean();
    return res.status(200).json({ success: true, count: skills.length, skills });
  } catch (error) {
    console.error("Get active skills error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch skills." });
  }
};

// GET /api/admin/skills - Admin list of all skills (including inactive)
export const getAllSkillsAdmin = async (req, res) => {
  try {
    const skills = await Skill.find({})
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, count: skills.length, skills });
  } catch (error) {
    console.error("Admin get all skills error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch skills for admin." });
  }
};

// POST /api/admin/skills - Admin add new skill
export const createSkill = async (req, res) => {
  try {
    const { name, category, startingPrice, description, isActive } = req.body || {};
    const trimmedName = String(name || "").trim();

    if (!trimmedName) {
      return res.status(400).json({ success: false, message: "Skill name is required." });
    }

    const price = Number(startingPrice);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ success: false, message: "Starting price must be a valid non-negative number." });
    }

    const existing = await Skill.findOne({ name: { $regex: new RegExp(`^${trimmedName}$`, "i") } });
    if (existing) {
      return res.status(409).json({ success: false, message: "A skill with this name already exists." });
    }

    const skill = await Skill.create({
      name: trimmedName,
      category: String(category || "Home Repairs").trim(),
      startingPrice: price,
      description: String(description || "").trim(),
      isActive: isActive !== undefined ? Boolean(isActive) : true,
    });

    return res.status(201).json({ success: true, message: "Skill created successfully.", skill });
  } catch (error) {
    console.error("Create skill error:", error);
    return res.status(500).json({ success: false, message: "Failed to create skill." });
  }
};

// PATCH /api/admin/skills/:id - Admin update skill
export const updateSkill = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, startingPrice, description, isActive } = req.body || {};

    const skill = await Skill.findById(id);
    if (!skill) {
      return res.status(404).json({ success: false, message: "Skill not found." });
    }

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ success: false, message: "Skill name cannot be empty." });
      }
      const existing = await Skill.findOne({
        _id: { $ne: id },
        name: { $regex: new RegExp(`^${trimmedName}$`, "i") },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: "Another skill with this name already exists." });
      }
      skill.name = trimmedName;
    }

    if (category !== undefined) {
      skill.category = String(category).trim() || skill.category;
    }

    if (startingPrice !== undefined) {
      const price = Number(startingPrice);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ success: false, message: "Starting price must be a valid non-negative number." });
      }
      skill.startingPrice = price;
    }

    if (description !== undefined) {
      skill.description = String(description).trim();
    }

    if (isActive !== undefined) {
      skill.isActive = Boolean(isActive);
    }

    await skill.save();
    return res.status(200).json({ success: true, message: "Skill updated successfully.", skill });
  } catch (error) {
    console.error("Update skill error:", error);
    return res.status(500).json({ success: false, message: "Failed to update skill." });
  }
};

// DELETE /api/admin/skills/:id - Admin delete skill
export const deleteSkill = async (req, res) => {
  try {
    const { id } = req.params;
    const skill = await Skill.findByIdAndDelete(id);
    if (!skill) {
      return res.status(404).json({ success: false, message: "Skill not found." });
    }
    return res.status(200).json({ success: true, message: "Skill deleted successfully." });
  } catch (error) {
    console.error("Delete skill error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete skill." });
  }
};
