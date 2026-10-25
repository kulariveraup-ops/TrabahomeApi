import { Schema, model } from "mongoose";

const skillSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    category: {
      type: String,
      trim: true,
      default: "Home Repairs",
    },
    startingPrice: {
      type: Number,
      required: true,
      min: 0,
      default: 500,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

skillSchema.index({ name: 1 });
skillSchema.index({ isActive: 1, name: 1 });

export default model("Skill", skillSchema);
