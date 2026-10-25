import jwt from "jsonwebtoken";

const getJwtSecret = () => process.env.JWT_SECRET || "change-this-secret";

export const requireHomeownerAuth = (req, res, next) => {
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (!payload || payload.role !== "homeowner") {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
};
