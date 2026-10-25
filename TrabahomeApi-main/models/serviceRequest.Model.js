import { Schema, model } from "mongoose";

const serviceRequestMessageSchema = new Schema(
  {
    senderId: { type: String, required: true },
    senderRole: { type: String, enum: ["homeowner", "worker", "admin"], required: true },
    senderName: { type: String, default: "" },
    message: { type: String, default: "" },
    attachments: [
      {
        url: { type: String, required: true },
        name: { type: String, default: "" },
        fileType: { type: String, default: "" },
      },
    ],
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// The canonical request record shared by homeowner, worker, and admin portals.
const serviceRequestSchema = new Schema(
  {
    requestNumber: { type: String, required: true, unique: true, index: true },
    homeownerId: { type: Schema.Types.ObjectId, ref: "HomeOwner", required: true, index: true },
    targetWorkerId: { type: Schema.Types.ObjectId, ref: "Worker", required: true, index: true },
    description: { type: String, required: true, trim: true },
    preferredDate: { type: Date, required: true },
    preferredTime: { type: String, required: true, trim: true },
    serviceType: { type: String, trim: true, default: "General Repair" },
    estimatedStartingCost: { type: Number, default: 0 },
    contactNumber: { type: String, trim: true, default: "" },
    province: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    barangay: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "ONGOING", "COMPLETED", "CANCELLED", "DECLINED"],
      default: "PENDING",
      index: true,
    },
    cancelledBy: { type: String, enum: ["homeowner", "worker", "admin", null], default: null },
    declineReason: { type: String, trim: true, default: "" },
    supportRequestId: { type: String, trim: true, default: "" },
    adminNote: { type: String, trim: true, default: "" },
    reviewRating: { type: Number, default: null },
    reviewText: { type: String, trim: true, default: "" },
    reviewTags: [{ type: String, trim: true }],
    reviewedAt: { type: Date, default: null },
    workerReviewRating: { type: Number, default: null },
    workerReviewText: { type: String, trim: true, default: "" },
    workerReviewTags: [{ type: String, trim: true }],
    workerReviewedAt: { type: Date, default: null },
    acceptedOn: { type: Date, default: null },
    completedOn: { type: Date, default: null },
    cancelledOn: { type: Date, default: null },
    completionDetails: {
      proofOfWork: [{ type: String }],
      proofOfPayment: [{ type: String }],
      paymentAmount: { type: Number, default: 0 },
      jobSummary: { type: String, trim: true, default: "" },
      completedAt: { type: Date, default: null },
    },
    midnightReminderSent: { type: Boolean, default: false },
    inProgressNotified: { type: Boolean, default: false },
    rescheduleRequest: {
      status: {
        type: String,
        enum: ["none", "pending", "confirmed", "declined"],
        default: "none",
      },
      proposedDate: { type: Date, default: null },
      proposedTime: { type: String, trim: true, default: "" },
      reason: { type: String, trim: true, default: "" },
      proposedBy: { type: String, enum: ["worker", "homeowner"], default: "worker" },
      requestedAt: { type: Date, default: null },
      respondedAt: { type: Date, default: null },
    },
    messages: [serviceRequestMessageSchema],
  },
  { timestamps: true }
);

serviceRequestSchema.index({ homeownerId: 1, createdAt: -1 });
serviceRequestSchema.index({ targetWorkerId: 1, createdAt: -1 });
serviceRequestSchema.index({ targetWorkerId: 1, status: 1, createdAt: -1 });
serviceRequestSchema.index({ status: 1, createdAt: -1 });
serviceRequestSchema.index({ createdAt: -1 });

export default model("ServiceRequest", serviceRequestSchema);
