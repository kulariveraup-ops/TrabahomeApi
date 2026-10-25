import assert from "node:assert/strict";
import test from "node:test";
import dotenv from "dotenv";

dotenv.config({ path: new URL("../.env", import.meta.url) });

const [
  { default: Otp },
  { default: HomeOwner },
  { default: Worker },
  { default: Admin },
  { hashOtp },
  { verifyHomeOwnerLoginOtp, verifyWorkerLoginOtp, verifyAdminLoginOtp },
] = await Promise.all([
  import("../models/otp.Model.js"),
  import("../models/homeOwner.Model.js"),
  import("../models/worker.Model.js"),
  import("../models/admin.Model.js"),
  import("../services/otp.service.js"),
  import("../controllers/auth/otp.controller.js"),
]);

const NEWEST_OTP_ID = "64b000000000000000000002";
const OLDER_OTP_ID = "64b000000000000000000001";

const originals = {
  otpFindOne: Otp.findOne,
  otpFindOneAndUpdate: Otp.findOneAndUpdate,
  homeownerFindOne: HomeOwner.findOne,
  homeownerFindById: HomeOwner.findById,
  workerFindOne: Worker.findOne,
  workerFindById: Worker.findById,
  adminFindOne: Admin.findOne,
  adminFindById: Admin.findById,
};

const restoreModelMethods = () => {
  Otp.findOne = originals.otpFindOne;
  Otp.findOneAndUpdate = originals.otpFindOneAndUpdate;
  HomeOwner.findOne = originals.homeownerFindOne;
  HomeOwner.findById = originals.homeownerFindById;
  Worker.findOne = originals.workerFindOne;
  Worker.findById = originals.workerFindById;
  Admin.findOne = originals.adminFindOne;
  Admin.findById = originals.adminFindById;
};

const createResponse = () => {
  const result = { statusCode: 200, body: null };
  result.status = (statusCode) => {
    result.statusCode = statusCode;
    return result;
  };
  result.json = (body) => {
    result.body = body;
    return result;
  };
  return result;
};

const runVerification = async ({
  role,
  code,
  otpId = NEWEST_OTP_ID,
  selectedExists = true,
  selectedIsLatest = true,
  latestCode = "654321",
  expired = false,
  used = false,
}) => {
  const user = {
    _id: `${role}-user-id`,
    email: `${role}@example.com`,
    firstName: "Test",
    lastName: "User",
    status: "verified",
    isVerified: true,
  };
  const latestOtp = {
    _id: NEWEST_OTP_ID,
    userType: role,
    userId: user._id,
    purpose: "login",
    codeHash: hashOtp(latestCode),
    expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)),
    usedAt: used ? new Date() : null,
    attempts: 0,
    maxAttempts: 3,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
  };
  const selectedOtp = selectedIsLatest
    ? latestOtp
    : {
        ...latestOtp,
        _id: OLDER_OTP_ID,
        codeHash: hashOtp("123456"),
        saveCalls: 0,
        async save() {
          this.saveCalls += 1;
          return this;
        },
      };
  const model = role === "homeowner" ? HomeOwner : (role === "admin" ? Admin : Worker);
  let exactQuery;
  let latestQuery;
  let sortQuery;
  let consumeCalls = 0;

  model.findOne = async ({ email }) => email === user.email ? user : null;
  model.findById = (userId) => ({
    select: async () => userId === user._id ? user : null,
  });
  Otp.findOne = (query) => {
    if (query._id) {
      exactQuery = query;
      return Promise.resolve(selectedExists ? selectedOtp : null);
    }

    latestQuery = query;
    return {
      sort: async (sort) => {
        sortQuery = sort;
        return latestOtp;
      },
    };
  };
  Otp.findOneAndUpdate = async (query) => {
    consumeCalls += 1;
    assert.equal(String(query._id), NEWEST_OTP_ID);
    assert.equal(query.userId, user._id);
    return { ...latestOtp, usedAt: new Date() };
  };

  const req = {
    baseUrl: `/api/${role === "homeowner" ? "homeowners" : (role === "admin" ? "admins" : "workers")}`,
    route: { path: "/verify-login-otp" },
    body: { email: user.email.toUpperCase(), code, otpId },
  };
  const res = createResponse();
  const handler = role === "homeowner"
    ? verifyHomeOwnerLoginOtp
    : (role === "admin" ? verifyAdminLoginOtp : verifyWorkerLoginOtp);

  await handler(req, res);

  assert.deepEqual(exactQuery, {
    userType: role,
    userId: user._id,
    purpose: "login",
    _id: otpId,
  });
  assert.deepEqual(latestQuery, {
    userType: role,
    userId: user._id,
    purpose: "login",
  });
  assert.deepEqual(sortQuery, { createdAt: -1, _id: -1 });

  return { res, selectedOtp, consumeCalls };
};

test("homeowner and worker verify the exact newest login otpId", async (t) => {
  try {
    await t.test("homeowner signin OTP succeeds", async () => {
      const { res, consumeCalls } = await runVerification({
        role: "homeowner",
        code: "654321",
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.token);
      assert.equal(consumeCalls, 1);
    });

    await t.test("worker signin OTP succeeds", async () => {
      const { res, consumeCalls } = await runVerification({
        role: "worker",
        code: "654321",
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.token);
      assert.equal(consumeCalls, 1);
    });

    await t.test("admin signin OTP succeeds", async () => {
      const { res, consumeCalls } = await runVerification({
        role: "admin",
        code: "654321",
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.token);
      assert.ok(res.body.admin);
      assert.equal(consumeCalls, 1);
    });

    await t.test("deleted OTP1 fails after homeowner resend", async () => {
      const { res, consumeCalls } = await runVerification({
        role: "homeowner",
        code: "123456",
        otpId: OLDER_OTP_ID,
        selectedExists: false,
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, "Invalid or expired code.");
      assert.equal(consumeCalls, 0);
    });

    await t.test("OTP2 succeeds after homeowner resend", async () => {
      const { res } = await runVerification({
        role: "homeowner",
        code: "654321",
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
    });

    await t.test("deleted OTP1 fails after worker resend", async () => {
      const { res, consumeCalls } = await runVerification({
        role: "worker",
        code: "123456",
        otpId: OLDER_OTP_ID,
        selectedExists: false,
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, "Invalid or expired code.");
      assert.equal(consumeCalls, 0);
    });

    await t.test("older active record is rejected when its otpId is not newest", async () => {
      const { res, consumeCalls } = await runVerification({
        role: "worker",
        code: "123456",
        otpId: OLDER_OTP_ID,
        selectedIsLatest: false,
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, "Invalid or expired code.");
      assert.equal(consumeCalls, 0);
    });

    await t.test("OTP2 succeeds after worker resend", async () => {
      const { res } = await runVerification({
        role: "worker",
        code: "654321",
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
    });

    await t.test("wrong code fails", async () => {
      const { res, selectedOtp } = await runVerification({
        role: "homeowner",
        code: "000000",
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, "Invalid or expired code.");
      assert.equal(selectedOtp.saveCalls, 1);
    });

    await t.test("expired code fails", async () => {
      const { res, selectedOtp, consumeCalls } = await runVerification({
        role: "homeowner",
        code: "654321",
        expired: true,
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, "Invalid or expired code.");
      assert.equal(selectedOtp.saveCalls, 0);
      assert.equal(consumeCalls, 0);
    });

    await t.test("used code fails", async () => {
      const { res, consumeCalls } = await runVerification({
        role: "worker",
        code: "654321",
        used: true,
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, "Invalid or expired code.");
      assert.equal(consumeCalls, 0);
    });
  } finally {
    restoreModelMethods();
  }
});
