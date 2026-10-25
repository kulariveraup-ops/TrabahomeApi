import { Schema, model } from "mongoose";

const adminSchema = new Schema(
  {
    name: { type: String, trim: true, default: "" },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
    },
    role: { type: String, default: "admin" },
  },
  { timestamps: true }
);

export default model("Admin", adminSchema);
