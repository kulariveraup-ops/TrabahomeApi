import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const [
  { default: Admin },
  { default: Worker },
  { default: HomeOwner },
  { loginAdmin },
  { signInWorker },
  { loginHomeOwner },
  { requireAdminAuth },
  { requireWorkerAuth },
  { requireHomeownerAuth },
] = await Promise.all([
    import("../models/admin.Model.js"),
    import("../models/worker.Model.js"),
    import("../models/homeOwner.Model.js"),
    import("../controllers/admin-auth/admin.controller.js"),
    import("../controllers/worker-auth/worker.controller.js"),
    import("../controllers/homeOwner-auth/homeOwner.controller.js"),
    import("../middleware/authAdmin.js"),
    import("../middleware/authWorker.js"),
    import("../middleware/authHomeowner.js"),
  ]);

const originalMethods = {
  adminFindOne: Admin.findOne,
  workerFindOne: Worker.findOne,
  homeownerFindOne: HomeOwner.findOne,
};

const createResponse = () => {
  const response = { statusCode: 200, body: null };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
};

const createUser = (role, password, overrides = {}) => ({
  _id: `${role}-user-id`,
  firstName: "Test",
  lastName: "User",
  email: `${role}@example.com`,
  password,
  status: "Verified",
  isVerified: true,
  role,
  toObject() {
    return { ...this };
  },
  ...overrides,
});

const verifyLoginToken = (token, role) => {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(payload.role, role);
  assert.equal(payload.id, `${role}-user-id`);
};

const assertProtectedRouteAccepts = (guard, token, role) => {
  const request = { headers: { authorization: `Bearer ${token}` } };
  const response = createResponse();
  let nextCalled = false;

  guard(request, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(request.user.role, role);
};

test("credential login bypasses login OTP while retaining validation and account restrictions", async (t) => {
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "direct-login-test-secret";
  const password = "CorrectPassword123!";
  const passwordHash = await bcrypt.hash(password, 4);

  t.after(() => {
    Admin.findOne = originalMethods.adminFindOne;
    Worker.findOne = originalMethods.workerFindOne;
    HomeOwner.findOne = originalMethods.homeownerFindOne;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  });

  await t.test("Admin credentials return a JWT without OTP metadata", async () => {
    const admin = createUser("admin", passwordHash);
    Admin.findOne = async () => admin;

    const response = createResponse();
    await loginAdmin({ body: { email: admin.email, password } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.ok(response.body.token);
    assert.equal(response.body.otpRequired, undefined);
    assert.equal(response.body.otpId, undefined);
    verifyLoginToken(response.body.token, "admin");
    assertProtectedRouteAccepts(requireAdminAuth, response.body.token, "admin");
  });

  await t.test("Worker credentials return a JWT without OTP metadata", async () => {
    const worker = createUser("worker", passwordHash, { profession: "Plumber" });
    Worker.findOne = () => ({ select: async () => worker });

    const response = createResponse();
    await signInWorker({ body: { email: worker.email, password } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.ok(response.body.token);
    assert.equal(response.body.otpRequired, undefined);
    assert.equal(response.body.otpId, undefined);
    verifyLoginToken(response.body.token, "worker");
    assertProtectedRouteAccepts(requireWorkerAuth, response.body.token, "worker");
  });

  await t.test("Homeowner credentials return a JWT without OTP metadata", async () => {
    const homeowner = createUser("homeowner", passwordHash);
    HomeOwner.findOne = async () => homeowner;

    const response = createResponse();
    await loginHomeOwner({ body: { email: homeowner.email, password } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.ok(response.body.token);
    assert.equal(response.body.otpRequired, undefined);
    assert.equal(response.body.otpId, undefined);
    verifyLoginToken(response.body.token, "homeowner");
    assertProtectedRouteAccepts(requireHomeownerAuth, response.body.token, "homeowner");
  });

  await t.test("invalid credentials remain rejected", async () => {
    const admin = createUser("admin", passwordHash);
    Admin.findOne = async () => admin;

    const response = createResponse();
    await loginAdmin({ body: { email: admin.email, password: "WrongPassword123!" } }, response);

    assert.equal(response.statusCode, 401);
    assert.equal(response.body.success, false);
    assert.equal(response.body.token, undefined);
  });

  await t.test("pending and suspended accounts remain restricted", async () => {
    const pendingHomeowner = createUser("homeowner", passwordHash, {
      status: "Pending",
      isVerified: false,
    });
    HomeOwner.findOne = async () => pendingHomeowner;

    const homeownerResponse = createResponse();
    await loginHomeOwner(
      { body: { email: pendingHomeowner.email, password } },
      homeownerResponse
    );

    assert.equal(homeownerResponse.statusCode, 403);
    assert.equal(homeownerResponse.body.token, undefined);

    const suspendedWorker = createUser("worker", passwordHash, {
      status: "Suspended",
      isVerified: true,
    });
    Worker.findOne = () => ({ select: async () => suspendedWorker });

    const workerResponse = createResponse();
    await signInWorker({ body: { email: suspendedWorker.email, password } }, workerResponse);

    assert.equal(workerResponse.statusCode, 403);
    assert.equal(workerResponse.body.token, undefined);
  });
});
