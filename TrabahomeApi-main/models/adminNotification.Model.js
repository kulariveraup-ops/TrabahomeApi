import { Schema, model } from "mongoose";

const adminNotificationSchema = new Schema(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
      ref: "Admin",
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["info", "success", "warning", "error"],
      default: "info",
    },
    readAt: { type: Date, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

adminNotificationSchema.index({ adminId: 1, createdAt: -1 });
adminNotificationSchema.index({ adminId: 1, createdAt: -1, _id: -1 });
adminNotificationSchema.index({ adminId: 1, readAt: 1, createdAt: -1 });

export default model("AdminNotification", adminNotificationSchema);
