import { Schema, model } from "mongoose";

const emailLogSchema = new Schema(
  {
    requestId: { type: String, default: "" },
    recipientName: { type: String, default: "" },
    recipientRole: { type: String, default: "User" },
    emailAddress: { type: String, required: true, trim: true, lowercase: true },
    emailType: { type: String, default: "System Notification" },
    subject: { type: String, required: true },
    message: { type: String, default: "" },
    status: { type: String, enum: ["Delivered", "Failed", "Sent"], default: "Delivered" },
    gatewayResponse: { type: String, default: "250 2.0.0 OK SMTP Delivery via Gmail TLS" },
    attempts: { type: Number, default: 1 },
    error: { type: String, default: "" },
    dateSent: { type: String, default: "" },
  },
  { timestamps: true }
);

emailLogSchema.index({ createdAt: -1 });
emailLogSchema.index({ emailAddress: 1, createdAt: -1 });

export default model("EmailLog", emailLogSchema);
