import assert from "node:assert/strict";
import test from "node:test";
import dotenv from "dotenv";

dotenv.config({ path: new URL("../.env", import.meta.url) });

const [
  { default: connectDB },
  { default: Admin },
  { default: Otp },
  { loginAdmin },
  { verifyAdminLoginOtp, resendAdminLoginOtp },
] = await Promise.all([
  import("../dbconnection/dbcon.js"),
  import("../models/admin.Model.js"),
  import("../models/otp.Model.js"),
  import("../controllers/admin-auth/admin.controller.js"),
  import("../controllers/auth/otp.controller.js"),
]);

const createResponse = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.body = data;
    return res;
  };
  return res;
};

test("Admin login credentials and reusable OTP verifier", async (t) => {
  await connectDB();

  const testEmail = process.env.ADMIN_EMAIL || "trabahome.up.phinmaed@gmail.com";
  const testPassword = process.env.ADMIN_PASSWORD || "UPang@MCMXXV*";

  await t.test("1. Admin credentials check in DB", async () => {
    const admin = await Admin.findOne({ email: testEmail });
    assert.ok(admin, `Admin with email ${testEmail} exists in database`);
    assert.equal(admin.role, "admin");
  });

  await t.test("2. Admin login with correct password issues a JWT without OTP", async () => {
    const req = {
      body: {
        email: testEmail,
        password: testPassword,
      },
    };
    const res = createResponse();

    await loginAdmin(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.token, "JWT token is issued after credential validation");
    assert.equal(res.body.otpRequired, undefined);
    assert.equal(res.body.otpId, undefined);
  });

  let otpRecord;

  await t.test("3. Admin verify OTP with wrong code fails", async () => {
    const admin = await Admin.findOne({ email: testEmail });
    const { hashOtp } = await import("../services/otp.service.js");
    otpRecord = await Otp.create({
      userType: "admin",
      userId: admin._id,
      email: testEmail,
      purpose: "login",
      channel: "email",
      codeHash: hashOtp("123456"),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 0,
      maxAttempts: 3,
      sentCount: 1,
      lastSentAt: new Date(),
    });

    const req = {
      baseUrl: "/api/admins",
      route: { path: "/verify-login-otp" },
      body: {
        email: testEmail,
        code: "000000",
        otpId: String(otpRecord._id),
      },
    };
    const res = createResponse();

    await verifyAdminLoginOtp(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, "Invalid or expired code.");
  });

  await t.test("4. Admin verify OTP with correct code remains available", async () => {
    const testCode = "123456";
    const req = {
      baseUrl: "/api/admins",
      route: { path: "/verify-login-otp" },
      body: {
        email: testEmail,
        code: testCode,
        otpId: String(otpRecord._id),
      },
    };
    const res = createResponse();

    await verifyAdminLoginOtp(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.token, "JWT token is successfully issued upon OTP verification");
    assert.ok(res.body.admin, "Admin profile data returned");
    assert.equal(res.body.email, testEmail);

    const updatedOtp = await Otp.findById(otpRecord._id);
    assert.ok(updatedOtp.usedAt !== null, "OTP is marked as used");

    await Otp.deleteOne({ _id: otpRecord._id });
  });

  // Clean up any remaining test otps
  await Otp.deleteMany({ email: testEmail });
  process.exit(0);
});
