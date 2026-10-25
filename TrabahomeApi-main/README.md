# TrabaHome Backend API 🚀🛠️
**Express 5 & MongoDB REST / WebSocket Engine for TrabaHome**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.2-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose_9-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Socket.io](https://img.shields.io/badge/Socket.io-4.8-010101?logo=socketdotio&logoColor=white)](https://socket.io/)
[![JWT](https://img.shields.io/badge/Auth-JWT-000000?logo=jsonwebtokens&logoColor=white)](https://jwt.io/)
[![Deployed on Render](https://img.shields.io/badge/Deployed-Render-46E3B7?logo=render&logoColor=white)](https://render.com/)

This repository powers the backend infrastructure for **TrabaHome**—an on-demand home services marketplace for Pangasinan, Philippines. It handles multi-role authentication (Homeowners, Skilled Workers, Administrators), service requests, real-time messaging, scheduled appointment alerts, email logs, biometric verification audits, and official E-Receipt generation.

---

## 📑 Core Modules & Services

1. **Authentication & Authorization (`controllers/auth/`, `middleware/`)**:
   - Multi-role JWT authentication: `authHomeowner`, `authWorker`, `authAdmin`.
   - Password hashing with `bcryptjs`.
   - OTP email verification for user registration.
   - Account lockout safeguards against brute force login attempts.

2. **Service Request & Booking Pipeline (`controllers/serviceRequests.controller.js`)**:
   - Manages complete lifecycle: `Pending` ➔ `Accepted` ➔ `In Progress` ➔ `Completed` / `Cancelled` / `Declined`.
   - Proof-of-work (2–5 photos) and proof-of-payment image uploads via Multer.
   - Official electronic receipts (E-Receipts) generation with tamper-proof records.
   - Rating, review submission, and review locking.

3. **Background Scheduling Engine (`services/bookingSchedule.service.js`)**:
   - Midnight reminders: Automated cron checks at 12:00 AM on scheduled appointment dates dispatching notifications to both homeowner and worker.
   - Live status triggers: Automatically advances bookings to `In Progress` when the scheduled date/time arrives.

4. **Real-Time WebSocket Engine (`index.js`, `services/notify.js`)**:
   - Powered by Socket.io 4.8.
   - Instant messaging rooms between homeowner and assigned skilled worker upon booking acceptance.
   - Live multi-role notification broadcasts for all booking events, admin actions, and support tickets.

5. **Transactional Email & Real-Time Logging (`services/email.service.js`, `models/emailLog.Model.js`)**:
   - Nodemailer integration for automated OTPs, status updates, and support messages.
   - Comprehensive MongoDB audit log tracking delivery status (`sent`, `failed`), recipients, and timestamps viewable in `/admin-emaillogs`.

6. **Administrative Auditing (`controllers/admin-auth/`)**:
   - Worker verification (PhilSys ID, Driver's License, selfie match audit).
   - Homeowner and worker account information updates, suspension, and reinstatement.
   - Administrative booking cancellations with required support ticket references.

---

## 🚀 Environment Variables

Create a `.env` file in the root of `TrabahomeApi`:

```env
PORT=8000
MONGO_URI=mongodb://127.0.0.1:27017/trabahome
JWT_SECRET=your_jwt_secret_key

# Default Admin Account
ADMIN_EMAIL=admin@admin.com
ADMIN_PASSWORD=Admin1234!
ADMIN_NAME=Platform Administrator

# SMTP Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
SMTP_SECURE=false

# Optional AI Key
GEMINI_API_KEY=your_gemini_api_key
```

---

## 💻 Local Development

```bash
# Install dependencies
npm install

# Start in development mode (nodemon)
npm run dev

# Start in production mode
npm start
```

---

## 📄 License
Academic and commercial deployment. All rights reserved.
