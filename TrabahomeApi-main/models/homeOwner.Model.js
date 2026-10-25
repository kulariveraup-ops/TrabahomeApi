import { Schema, model } from "mongoose";

const homeOwnerSchema = new Schema(
  {
    // ── Account Info ─────────────────────────
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      maxlength: 11   // PH format: 09XXXXXXXXX
    },
    status: { type: String, default: "Verified" },
    isVerified: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    hasSeenGuide: { type: Boolean, default: false },
    rating: { type: Number, default: 5 },
    ratingCount: { type: Number, default: 0 },
    avatar: { type: String, default: "" },
    profileImage: { type: String, default: "" },
    email_notifications: { type: Boolean, default: true },

    password: {
      type: String,
      required: true,
      minlength: 8,
    },

    agreeToTerms:   { type: Boolean, required: true },
    agreeToPrivacy: { type: Boolean, required: true },

    // ── Location ─────────────────────────────
    city:     { type: String, required: true, trim: true },
    barangay: { type: String, required: true, trim: true },
    // Optional at schema level so legacy accounts can still save passwords/status.
    // Current registration and Admin validation require real values going forward.
    province: { type: String, trim: true, default: "" },
    address:  { type: String, trim: true, default: "" },

  },
  { timestamps: true }
);

homeOwnerSchema.index({ createdAt: -1 });
homeOwnerSchema.index({ status: 1, createdAt: -1 });

export default model("HomeOwner", homeOwnerSchema);
