import { Schema, model } from 'mongoose';

const workerSchema = new Schema({
  // ── Step 1: Account Info ──────────────────────────────────────
  firstName:        { type: String, required: true, trim: true },
  lastName:         { type: String, required: true, trim: true },
  email:            { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone:            { type: String, required: true, maxlength: 13 },
  password:         { type: String, required: true, minlength: 8 },
  mustChangePassword: { type: Boolean, default: false },
  hasSeenGuide:     { type: Boolean, default: false },
  agreeToTerms:     { type: Boolean, required: true, default: false },
  agreeToPrivacy:   { type: Boolean, required: true, default: false },

  // ── Work & Location ───────────────────────────────────────────
  profession:       { type: String, required: true, trim: true },
  province:         { type: String, default: 'Pangasinan', trim: true },
  city:             { type: String, required: true, trim: true },
  barangay:         { type: String, required: true, trim: true },

  // Profile extras
  avatar:           { type: String, trim: true },
  profileImage:     { type: String, trim: true },
  bio:              { type: String, trim: true, default: '' },
  yearsExperience:  { type: Number, default: 0 },
  languages:        { type: [String], default: [] },
  proofOfWork:      { type: [String], default: [], select: false },
  rating:           { type: Number, default: 0 },
  availabilityStatus:{ type: String, trim: true, default: '' },
  workingSchedule:  { type: String, trim: true, default: '' },
  price:            { type: String, trim: true },
  status:           { type: String, enum: ['Pending', 'Verified', 'Rejected', 'Suspended'], default: 'Pending' },
  isVerified:       { type: Boolean, default: false },

  // Philippine Government ID & AI Verification
  idType:           { type: String, trim: true },
  idNumber:         { type: String, trim: true },
  idCardImage:      { type: String, trim: true, select: false },
  idSelfieImage:    { type: String, trim: true, select: false },
  aiVerification: {
    status:          { type: String, enum: ['Approved', 'Failed', 'Pending', 'None'], default: 'None' },
    verifiedAt:      { type: Date },
    confidenceScore: { type: Number, default: 0 },
    faceMatchScore:  { type: Number, default: 0 },
    livenessScore:   { type: Number, default: 0 },
    extractedName:   { type: String, trim: true },
    extractedIdNumber:{ type: String, trim: true },
    provider:        { type: String, default: 'AWS Rekognition / Textract & Cloud AI' },
    reason:          { type: String, trim: true },
    idDocumentKey:   { type: String, trim: true, select: false },
    selfieDocumentKey:{ type: String, trim: true, select: false },
  },

  // Geo location for search
  location: {
    type: {
      type: String,
      enum: ["Point"],
    },
    coordinates: {
      type: [Number],
    },
  },
  locationLabel:    { type: String, trim: true },

  // Direct profile edit approval flow
  pendingProfileUpdate: {
    status: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, trim: true, default: '' },
    changes: {
      fullName: { type: String, trim: true },
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      phone: { type: String, trim: true },
      profession: { type: String, trim: true },
      province: { type: String, trim: true },
      city: { type: String, trim: true },
      barangay: { type: String, trim: true },
      address: { type: String, trim: true },
      location: { type: String, trim: true },
    },
  },

}, { timestamps: true });

workerSchema.index({ location: "2dsphere" });
workerSchema.index({ createdAt: -1 });
workerSchema.index({ status: 1, createdAt: -1 });

export default model('Worker', workerSchema);
