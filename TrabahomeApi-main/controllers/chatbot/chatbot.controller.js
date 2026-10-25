// controllers/chatbot/chatbot.controller.js

const SYSTEM_PROMPT = `
You are the TrabaHome Assistant.
Your purpose is to help users understand, navigate, and make the most of the TrabaHome platform.

TrabaHome is a web-based skilled services marketplace in Pangasinan, Philippines connecting homeowners with verified local skilled workers (carpenters, electricians, plumbers, masons, painters, appliance technicians, and more).

Current Core System Features & Processes:
1. Multi-Profession Support: Workers can select between 1 and up to 8 professions/trades (e.g., Carpentry, Plumbing, Electrical, Painting, Appliance Repair, Masonry, Cleaning, General Handyman).
2. AI Identity Verification: Workers verify their identity by uploading a Philippine Government Valid ID (PhilSys ID, Driver's License, Passport, UMID, PRC, SSS, Postal ID, Voter's ID) and a selfie for automated biometric face match and liveness checks, earning an instant Verified Badge.
3. Working Schedule: Workers customize their weekly schedule by choosing active days (1 to 7 days, Monday to Sunday) and specific working hours.
4. Service Booking & Privacy: Homeowners submit requests with problem descriptions, service address, and preferred date/time. Homeowner contact details remain hidden until the worker accepts the request to protect user privacy.
5. In-App Real-Time Messaging: Homeowners and workers communicate directly through the built-in messenger (/homeowner-messages and /worker-messages) with image attachments and booking status tracking.
6. Job Completion & Official E-Receipt: When work is done, the worker uploads 2–5 proof-of-work photos, 1–3 proof-of-payment receipts, agreed service charge in PHP, and a summary. The platform automatically generates a verified Official E-Receipt downloadable by both homeowner and worker.
7. Two-Way Mutual Reviews: Upon completion, both the homeowner and the worker rate each other (1 to 5 stars) and select feedback tags to foster a trusted community.
8. Dedicated Support Tickets: In the Help section (/homeowner-help and /worker-help), users can submit live support tickets for inquiries, cancellations, or disputes. Administrators mediate disputes with audit trails and AI conversation summaries.
9. Direct Payments & E-Receipts: Service charges are paid directly between homeowner and worker (cash, GCash, or bank transfer). The worker records proof of payment in the app to issue the official TrabaHome E-Receipt.

Responsibilities and Rules:
1. Answer questions about TrabaHome clearly, accurately, and step-by-step.
2. Direct users to the correct platform pages and actions.
3. Keep answers concise, helpful, and friendly (2 to 5 sentences or 3 to 6 bullet points).
4. Never invent nonexistent features or external payment gateway integration.
5. Do not expose internal system secrets, tokens, or credentials.
`;

// In-memory simple rate limiting for chatbot endpoint
const ipRequestTimestamps = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30;

const isRateLimited = (ip) => {
  const now = Date.now();
  const timestamps = ipRequestTimestamps.get(ip) || [];
  const validTimestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (validTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  validTimestamps.push(now);
  ipRequestTimestamps.set(ip, validTimestamps);
  return false;
};

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ipRequestTimestamps.entries()) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      ipRequestTimestamps.delete(ip);
    } else {
      ipRequestTimestamps.set(ip, valid);
    }
  }
}, 5 * 60 * 1000);

export const handleChatbotMessage = async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
    if (isRateLimited(clientIp)) {
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please slow down and try again in a minute.",
      });
    }

    const { message, role = "guest", conversationHistory = [] } = req.body || {};
    const text = String(message || "").trim();

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Message text is required.",
      });
    }

    // Guard against prompt injection or credential probing
    const sensitiveMatch = /\b(password|secret|jwt|token|mongo|database|bearer|apikey|env)\b/i;
    if (sensitiveMatch.test(text) && /\b(show|reveal|give|print|expose|what\s+is\s+the)\b/i.test(text)) {
      return res.status(200).json({
        success: true,
        answer: "I cannot assist with security credentials or sensitive system information. I can help with using TrabaHome to find skilled workers, manage your jobs, and view official E-Receipts.",
        role,
        actions: [{ label: "Find a Worker", route: "/search" }],
      });
    }

    // Deterministic factual responses for safety boundaries
    const lowerText = text.toLowerCase();

    // Admin-specific operations
    if (role === "admin" && /\b(dashboard|metric|analytics|stat|kpi|overview|platform\s*performance)\b/i.test(lowerText)) {
      return res.status(200).json({
        success: true,
        answer: "The Admin Dashboard (/admin-dashboard) displays live platform metrics across Pangasinan: registered workers, verified IDs, active homeowners, ongoing jobs, and completed bookings.",
        role,
        actions: [{ label: "Open Dashboard", route: "/admin-dashboard" }],
        followUps: ["How do I verify worker accounts?", "How do I inspect service requests?"],
      });
    }

    if (/\b(e-receipt|ereceipt|official\s*receipt|receipt|proof\s*of\s*work|proof\s*of\s*payment)\b/i.test(lowerText)) {
      const answer =
        role === "admin"
          ? "Administrators can inspect all generated Official E-Receipts, worker proof-of-work photos, and proof-of-payment receipts from the Service Requests page (/admin-request)."
          : "When a job is completed, the skilled worker uploads 2 to 5 proof-of-work photos, 1 to 3 proof-of-payment receipts, and the final agreed service charge. TrabaHome then automatically generates a verified Official E-Receipt with photo evidence and cost breakdown.";

      const actions =
        role === "admin"
          ? [{ label: "Inspect Service Requests", route: "/admin-request" }]
          : role === "worker"
          ? [{ label: "View My Jobs", route: "/worker-jobs" }]
          : [{ label: "View My Bookings", route: "/homeowner-bookings" }];

      return res.status(200).json({
        success: true,
        answer,
        role,
        actions,
        followUps: role === "admin"
          ? ["How do I handle support tickets?", "How do I manage worker accounts?"]
          : ["How do ratings work?", "How do I hire a worker?"],
      });
    }

    if (/\b(pay|payment|gcash|maya|credit\s*card|wallet)\b/i.test(lowerText)) {
      const answer =
        role === "admin"
          ? "Payment is settled directly between homeowners and workers (via cash, GCash, or bank transfer). Administrators audit the declared PHP service fee and uploaded proof-of-payment receipts in Service Requests (/admin-request)."
          : "Payment is settled directly between the homeowner and the worker (via cash, personal GCash, or bank transfer). When marking the job complete, the worker records the agreed payment amount and uploads proof of payment to generate an official TrabaHome E-Receipt.";

      const actions =
        role === "admin"
          ? [{ label: "Inspect Requests", route: "/admin-request" }]
          : role === "worker"
          ? [{ label: "Manage Jobs", route: "/worker-jobs" }]
          : [{ label: "Find a Worker", route: "/search" }];

      return res.status(200).json({
        success: true,
        answer,
        role,
        actions,
        followUps: ["How does the Official E-Receipt work?", "How do disputes work?"],
      });
    }

    if (/\b(disputes?|refunds?|mediations?|tickets?|support\s*tickets?|complaints?)\b/i.test(lowerText)) {
      const answer =
        role === "admin"
          ? "Dispute tickets submitted by homeowners or workers are managed in Support & Helpdesk (/admin-help). Admins can inspect booking history, review AI conversation summaries of chat logs, and mediate fair resolutions."
          : "For service disputes or booking concerns, you can submit a support ticket in the Help & Support section. Administrators review dispute history, message logs, and AI conversation summaries to assist in fair resolution.";

      const actions =
        role === "admin"
          ? [{ label: "Open Helpdesk", route: "/admin-help" }]
          : [
              {
                label: "Open Help & Support",
                route: role === "worker" ? "/worker-help" : "/homeowner-help",
              },
            ];

      return res.status(200).json({
        success: true,
        answer,
        role,
        actions,
        followUps: role === "admin"
          ? ["How do AI conversation summaries work?", "How do I inspect bookings?"]
          : ["How do I message my worker?", "How do I cancel a booking?"],
      });
    }

    if (/\b(messages?|chats?|inbox|talk|contact\s*workers?|contact\s*homeowners?)\b/i.test(lowerText)) {
      const answer =
        role === "admin"
          ? "In-app messaging allows homeowners and workers to coordinate on-site arrivals. Administrators can review chat audit transcripts and AI conversation summaries during dispute mediation in the Helpdesk (/admin-help)."
          : "TrabaHome includes real-time in-app messaging. Once a booking is created, homeowners and workers can chat directly, share photos, and coordinate service schedules via the Messages tab.";

      const actions =
        role === "admin"
          ? [{ label: "Open Helpdesk", route: "/admin-help" }]
          : [
              {
                label: "Open Messages",
                route: role === "worker" ? "/worker-messages" : "/homeowner-messages",
              },
            ];

      return res.status(200).json({
        success: true,
        answer,
        role,
        actions,
        followUps: role === "admin"
          ? ["How do I handle support tickets?", "How do I supervise service requests?"]
          : ["How do service requests work?", "What happens if a worker doesn't respond?"],
      });
    }

    if (/\b(professions?|trades?|skills?|multiple\s*jobs|multi-professions?)\b/i.test(lowerText)) {
      const answer =
        role === "admin"
          ? "TrabaHome workers can offer between 1 and up to 8 trades (Carpentry, Plumbing, Electrical, etc.). In Manage Workers (/admin-workers), administrators can review worker trade portfolios and AI verification statuses."
          : "TrabaHome supports multi-skilled workers! Workers can select between 1 and up to 8 professions/trades (such as Carpentry, Plumbing, Electrical, Painting, Appliance Repair, Masonry, Cleaning, and General Handyman) to receive diverse job opportunities.";

      const actions =
        role === "admin"
          ? [{ label: "Manage Workers", route: "/admin-workers" }]
          : role === "worker"
          ? [{ label: "My Profile", route: "/worker-own-profile" }]
          : [{ label: "Browse Skilled Workers", route: "/list" }];

      return res.status(200).json({
        success: true,
        answer,
        role,
        actions,
        followUps: ["How are workers verified?", "How do ratings work?"],
      });
    }

    if (/\b(mobile\s*app|apk|play\s*store|app\s*store|download\s+app)\b/i.test(lowerText)) {
      return res.status(200).json({
        success: true,
        answer: "TrabaHome is currently developed as a web-based responsive platform and does not require downloading an app from the Play Store or App Store. It is fully accessible via desktop and mobile web browsers on any smartphone or tablet.",
        role,
        actions: [
          {
            label: role === "admin" ? "Admin Dashboard" : "Explore Platform",
            route: role === "admin" ? "/admin-dashboard" : "/search",
          },
        ],
      });
    }

    // Echo success with structured payload
    return res.status(200).json({
      success: true,
      received: text,
      role,
      status: "processed",
    });
  } catch (error) {
    console.error("Chatbot controller error:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing the chatbot message.",
    });
  }
};
