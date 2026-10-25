import { Schema, model } from "mongoose";

const workerNotificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
      ref: "Worker",
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

workerNotificationSchema.index({ userId: 1, createdAt: -1 });
workerNotificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });
workerNotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

export default model("WorkerNotification", workerNotificationSchema);
