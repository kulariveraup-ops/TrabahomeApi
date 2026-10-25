import { Schema, model } from "mongoose";

const supportMessageSchema = new Schema(
  {
    senderId: { type: Schema.Types.Mixed, required: true },
    senderRole: {
      type: String,
      enum: ["Homeowner", "Worker", "Admin"],
      required: true,
    },
    message: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const supportTicketSchema = new Schema(
  {
    ticketNumber: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true, ref: "HomeOwner" },
    role: {
      type: String,
      enum: ["Homeowner", "Worker"],
      default: "Homeowner",
    },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    issueCategory: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    messages: { type: [supportMessageSchema], default: [] },
    status: {
      type: String,
      enum: ["Open", "In Progress", "Resolved", "Closed"],
      default: "Open",
    },
  },
  { timestamps: true }
);

supportTicketSchema.index({ userId: 1, createdAt: -1 });

export default model("SupportTicket", supportTicketSchema);
