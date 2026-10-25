import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";

process.env.SMTP_HOST = "smtp.test";
process.env.SMTP_USER = "sender@example.com";
process.env.SMTP_PASS = "test-password";

nodemailer.createTransport = () => ({
  verify(callback) {
    callback(null, true);
  },
  async sendMail({ to }) {
    return { accepted: [to], rejected: [] };
  },
});

const [{ default: Otp }, { createAndSendOtp }] = await Promise.all([
  import("../models/otp.Model.js"),
  import("../services/otp.service.js"),
]);

const originals = {
  deleteMany: Otp.deleteMany,
  create: Otp.create,
  deleteOne: Otp.deleteOne,
};

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const matchesScope = (document, query) =>
  document.userType === query.userType &&
  String(document.userId) === String(query.userId) &&
  document.purpose === query.purpose;

const runOverlap = async (role, iteration) => {
  const activeDocuments = [];
  let nextId = 0;
  let pendingDeletes = 0;
  let releaseDeleteBarrier;
  let deleteBarrier = new Promise((resolve) => {
    releaseDeleteBarrier = resolve;
  });

  Otp.deleteMany = async (query) => {
    // Force overlapping requests through the original delete-before-create gap.
    pendingDeletes += 1;
    if (pendingDeletes === 2) {
      releaseDeleteBarrier();
    }
    await Promise.race([deleteBarrier, wait(25)]);
    for (let index = activeDocuments.length - 1; index >= 0; index -= 1) {
      if (matchesScope(activeDocuments[index], query)) {
        activeDocuments.splice(index, 1);
      }
    }
    pendingDeletes -= 1;
    if (pendingDeletes === 0) {
      deleteBarrier = new Promise((resolve) => {
        releaseDeleteBarrier = resolve;
      });
    }
  };
  Otp.create = async (values) => {
    nextId += 1;
    const document = { ...values, _id: `${role}-${iteration}-otp-${nextId}` };
    activeDocuments.push(document);
    return document;
  };
  Otp.deleteOne = async ({ _id }) => {
    const index = activeDocuments.findIndex((document) => document._id === _id);
    if (index >= 0) activeDocuments.splice(index, 1);
  };

  const options = {
    userType: role,
    userId: `${role}-user-${iteration}`,
    email: `${role}@example.com`,
    purpose: "login",
    length: 6,
    ttlSeconds: 300,
    maxAttempts: 3,
    replaceExisting: true,
  };
  const [first, second] = await Promise.all([
    createAndSendOtp(options),
    createAndSendOtp(options),
  ]);

  assert.notEqual(first.otpId, second.otpId, "each issuance must return its exact new otpId");
  assert.equal(activeDocuments.length, 1, "only one active login OTP may remain");
  assert.equal(activeDocuments[0]._id, second.otpId, "the newest returned otpId must be active");
};

test("overlapping login OTP issuance leaves exactly one newest active record", async (t) => {
  try {
    for (const role of ["homeowner", "worker"]) {
      await t.test(`${role} repeated overlap`, async () => {
        for (let iteration = 1; iteration <= 5; iteration += 1) {
          await runOverlap(role, iteration);
        }
      });
    }
  } finally {
    Otp.deleteMany = originals.deleteMany;
    Otp.create = originals.create;
    Otp.deleteOne = originals.deleteOne;
  }
});
