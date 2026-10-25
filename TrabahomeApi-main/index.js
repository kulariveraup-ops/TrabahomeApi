import http from "http";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import connectDB from "./dbconnection/dbcon.js";
import Admin from "./models/admin.Model.js";
import workerRoutes from "./routes/worker.routes.js";
import homeOwnerRoutes from "./routes/homeOwner.routes.js";
import homeownerNotificationsRoutes from "./routes/homeownerNotifications.js";
import workerNotificationsRoutes from "./routes/workerNotifications.js";
import adminRoutes from "./routes/admin.routes.js";
import adminWorkerRoutes from "./routes/admin.worker.routes.js";
import authRoutes from "./routes/auth.routes.js";
import supportRoutes from "./routes/support.routes.js";
import chatbotRoutes from "./routes/chatbot.routes.js";
import storageRoutes from "./routes/storage.routes.js";
import skillRoutes from "./routes/skill.routes.js";
import { homeownerRouter as serviceRequestHomeownerRoutes, workerRouter as serviceRequestWorkerRoutes, adminRouter as serviceRequestAdminRoutes } from "./routes/serviceRequest.routes.js";
import { initSocket } from "./services/socket.js";
import { PUBLIC_STORAGE_ROOT, ensureStorageDirectories } from "./services/cloudStorage.service.js";
import { startBookingScheduler } from "./services/bookingSchedule.service.js";
import { seedDefaultSkills } from "./services/skillSeed.service.js";

const app = express();
const PORT = process.env.PORT || 8000;
const server = http.createServer(app);

const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@admin.com";
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin1234!";
const DEFAULT_ADMIN_NAME = process.env.ADMIN_NAME || "Admin";

const seedDefaultAdmin = async () => {
  if (!DEFAULT_ADMIN_EMAIL || !DEFAULT_ADMIN_PASSWORD) return;

  const normalizedEmail = DEFAULT_ADMIN_EMAIL.trim().toLowerCase();
  const existingAdmin = await Admin.findOne({ email: normalizedEmail });
  if (existingAdmin) {
    console.log(`Default admin already exists: ${normalizedEmail}`);
    return;
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, salt);

  await Admin.create({
    name: DEFAULT_ADMIN_NAME,
    email: normalizedEmail,
    password: hashedPassword,
    role: "admin",
  });

  console.log(`Default admin created: ${normalizedEmail}`);
  console.log(`Use password: ${DEFAULT_ADMIN_PASSWORD}`);
};

// ── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── Static Cloud Storage Mirror ────────────────────────────────
ensureStorageDirectories();
app.use("/storage/public", express.static(PUBLIC_STORAGE_ROOT));

// ── Routes (mounted on both /api/* and root paths) ────────────
const mountRoute = (path, ...handlers) => {
  app.use(`/api${path}`, ...handlers);
  app.use(path, ...handlers);
};

mountRoute("/storage", storageRoutes);
mountRoute("/upload", storageRoutes);
mountRoute("/workers", serviceRequestWorkerRoutes);
mountRoute("/worker", serviceRequestWorkerRoutes);
mountRoute("/workers/notifications", workerNotificationsRoutes);
mountRoute("/workers", workerRoutes);

// Homeowner routes
mountRoute("/homeowners", serviceRequestHomeownerRoutes);
mountRoute("/homeowner", serviceRequestHomeownerRoutes);
mountRoute("/homeowners", homeOwnerRoutes);
mountRoute("/homeowner", homeOwnerRoutes);
mountRoute("/homeowners/notifications", homeownerNotificationsRoutes);
mountRoute("/homeowner/notifications", homeownerNotificationsRoutes);

// Admin routes
mountRoute("/admins", serviceRequestAdminRoutes);
mountRoute("/admin", serviceRequestAdminRoutes);
mountRoute("/admins", adminRoutes);
mountRoute("/admin", adminRoutes);
mountRoute("/admins", adminWorkerRoutes);
mountRoute("/admin", adminWorkerRoutes);

// Worker routes
mountRoute("/worker/notifications", workerNotificationsRoutes);
mountRoute("/worker", workerRoutes);
mountRoute("/auth", authRoutes);
mountRoute("/support", supportRoutes);
mountRoute("/chatbot", chatbotRoutes);
mountRoute("/skills", skillRoutes);


// ── Health Check ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'Worker Registration API is running.' });
});

initSocket(server);

connectDB().then(async () => {
  await seedDefaultAdmin();
  await seedDefaultSkills();
  startBookingScheduler();

  server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Stop the other process or set PORT=...`);
    } else {
      console.error("Server error:", error);
    }
    process.exit(1);
  });
});
