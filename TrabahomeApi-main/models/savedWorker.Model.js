import { Schema, model } from "mongoose";

const savedWorkerSchema = new Schema(
  {
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
  },
  { timestamps: true }
);

savedWorkerSchema.index({ homeownerId: 1, workerId: 1 }, { unique: true });
savedWorkerSchema.index({ homeownerId: 1, createdAt: -1 });

export default model("SavedWorker", savedWorkerSchema);
