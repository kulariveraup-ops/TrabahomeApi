import dotenv from "dotenv";
import mongoose from "mongoose";
import HomeOwner from "../models/homeOwner.Model.js";
import Worker from "../models/worker.Model.js";

dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });
const mongoUrl = process.env.MONGO_URL || process.env.MONGO_URI;
if (!mongoUrl) throw new Error("MongoDB connection is not configured.");
await mongoose.connect(mongoUrl);

const timeQuery = async (label, query) => {
  const startedAt = performance.now();
  const value = await query.lean();
  return { label, durationMs: Math.round(performance.now() - startedAt), value };
};
const lengths = (record, fields) => Object.fromEntries(fields.map((field) => [
  field,
  Array.isArray(record?.[field])
    ? record[field].reduce((total, item) => total + String(item || "").length, 0)
    : String(record?.[field] || "").length,
]));

const homeowner = await HomeOwner.findOne({}).sort({ updatedAt: -1 }).select("_id").lean();
const worker = await Worker.findOne({ $or: [{ status: "Verified" }, { isVerified: true }] })
  .sort({ updatedAt: -1 })
  .select("_id")
  .lean();
const checks = [
  await timeQuery("homeowner-scalars", HomeOwner.findById(homeowner?._id).select("firstName lastName email phone city barangay province address status isVerified createdAt updatedAt")),
  await timeQuery("homeowner-avatar", HomeOwner.findById(homeowner?._id).select("avatar")),
  await timeQuery("homeowner-profileImage", HomeOwner.findById(homeowner?._id).select("profileImage")),
  await timeQuery("worker-scalars", Worker.findById(worker?._id).select("firstName lastName email phone profession city barangay province rating status isVerified createdAt updatedAt")),
  await timeQuery("worker-avatar", Worker.findById(worker?._id).select("avatar")),
  await timeQuery("worker-profileImage", Worker.findById(worker?._id).select("profileImage")),
  await timeQuery("worker-proofOfWork", Worker.findById(worker?._id).select("proofOfWork")),
];

console.log(JSON.stringify(checks.map(({ label, durationMs, value }) => ({
  label,
  durationMs,
  lengths: lengths(value, ["avatar", "profileImage", "proofOfWork"]),
})), null, 2));
await mongoose.disconnect();
