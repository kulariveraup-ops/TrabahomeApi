import { Schema, model } from "mongoose";

const otpSchema = new Schema(
  {
    userType: {
      type: String,
      required: true,
      enum: ["admin", "homeowner", "worker"],
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: false,
      default: null,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    purpose: {
      type: String,
      required: true,
      enum: ["login", "forgot_password", "change_password", "registration"],
    },
    channel: {
      type: String,
      required: true,
      enum: ["email"],
      default: "email",
    },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true },
    usedAt: { type: Date, default: null },
    sentCount: { type: Number, default: 1 },
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model("Otp", otpSchema);
