import { Schema, model } from "mongoose";

const bookingSchema = new Schema(
  {
    bookingNumber: { type: String, required: true, unique: true, index: true },
    homeownerId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
      ref: "HomeOwner",
    },
    workerId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
      ref: "Worker",
    },
    serviceType: { type: String, required: true, trim: true },
    scheduledAt: { type: Date, required: true },
    address: { type: String, required: true, trim: true },
    notes: { type: String, trim: true, default: "" },
    photos: { type: [String], default: [] },
    status: {
      type: String,
      enum: [
        "Pending",
        "Accepted",
        "In Progress",
        "Completed",
        "Cancelled",
        "Declined",
      ],
      default: "Pending",
    },
    cancelledBy: {
      type: String,
      enum: ["homeowner", "worker", null],
      default: null,
    },
  },
  { timestamps: true }
);

bookingSchema.index({ homeownerId: 1, createdAt: -1 });
bookingSchema.index({ workerId: 1, createdAt: -1 });
bookingSchema.index({ workerId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ homeownerId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ status: 1, createdAt: -1 });

export default model("Booking", bookingSchema);
