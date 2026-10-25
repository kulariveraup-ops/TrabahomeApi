import assert from "node:assert/strict";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Admin from "../models/admin.Model.js";
import AdminNotification from "../models/adminNotification.Model.js";
import HomeOwner from "../models/homeOwner.Model.js";
import ServiceRequest from "../models/serviceRequest.Model.js";
import Worker from "../models/worker.Model.js";
import WorkerNotification from "../models/WorkerNotification.js";

dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const evaluate = async (client, expression) => {
  const response = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Browser evaluation failed.");
  return response.result?.value;
};

const mongoUrl = process.env.MONGO_URL || process.env.MONGO_URI;
assert.ok(mongoUrl, "MongoDB connection is configured");
await mongoose.connect(mongoUrl);
const [homeowner, worker, admin, recentLiveRequest] = await Promise.all([
  HomeOwner.findOne({ status: { $nin: ["Suspended", "suspended", "Disabled", "disabled"] } })
    .sort({ updatedAt: -1 })
    .select("_id email")
    .lean(),
  Worker.findOne({ $or: [{ status: "Verified" }, { isVerified: true }] })
    .sort({ updatedAt: -1 })
    .select("_id email")
    .lean(),
  Admin.findOne({}).sort({ updatedAt: -1 }).select("_id email").lean(),
  ServiceRequest.findOne({ description: /^Request Service modal transfer verification / })
    .sort({ createdAt: -1 })
    .select("_id description homeownerId targetWorkerId createdAt")
    .lean(),
]);
await mongoose.disconnect();
assert.ok(homeowner && worker && admin, "An active Homeowner, verified Worker, and Admin are available");

const sign = (account, role) => jwt.sign(
  { id: String(account._id), email: account.email, role },
  process.env.JWT_SECRET || "change-this-secret",
  { expiresIn: "15m" }
);
const token = sign(homeowner, "homeowner");
const workerToken = sign(worker, "worker");
const adminToken = sign(admin, "admin");
const verifyRecentOnly = process.env.VERIFY_RECENT_REQUEST === "1";
if (verifyRecentOnly) {
  assert.ok(recentLiveRequest, "A recent live Request Service test record exists");
  assert.equal(String(recentLiveRequest.homeownerId), String(homeowner._id));
  assert.equal(String(recentLiveRequest.targetWorkerId), String(worker._id));
  await mongoose.connect(mongoUrl);
  const [created, workerNotification, adminNotification] = await Promise.all([
    ServiceRequest.findById(recentLiveRequest._id).lean(),
    WorkerNotification.findOne({ "meta.requestId": String(recentLiveRequest._id) }).lean(),
    AdminNotification.findOne({ "meta.requestId": String(recentLiveRequest._id) }).lean(),
  ]);
  await mongoose.disconnect();
  assert.ok(created, "The submitted request exists in MongoDB");
  assert.equal(created.contactNumber, "09123456789");
  assert.equal(created.province, "Pangasinan");
  assert.equal(created.city, "Mangaldan");
  assert.equal(created.barangay, "Osiem");
  assert.equal(created.address, "");
  assert.equal(created.location, "Osiem, Mangaldan, Pangasinan");
  assert.equal(created.preferredTime, "10:30");
  assert.ok(workerNotification, "The existing Worker notification was created");
  assert.ok(adminNotification, "The existing Admin notification was created");

  const getRequests = async (url, authToken) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    assert.equal(response.status, 200, `${url} returns 200`);
    const payload = await response.json();
    return Array.isArray(payload.items) ? payload.items : Array.isArray(payload.data) ? payload.data : [];
  };
  const [homeownerItems, workerItems, adminItems] = await Promise.all([
    getRequests("http://localhost:8000/api/homeowners/service-requests", token),
    getRequests("http://localhost:8000/api/workers/service-requests", workerToken),
    getRequests("http://localhost:8000/api/admins/service-requests", adminToken),
  ]);
  const requestId = String(created._id);
  const findCreated = (items) => items.find((item) =>
    String(item.id || item._id) === requestId || item.requestNumber === created.requestNumber
  );
  for (const [view, items] of [["Homeowner", homeownerItems], ["Worker", workerItems], ["Admin", adminItems]]) {
    const item = findCreated(items);
    assert.ok(item, `${view} API includes the saved request`);
    assert.equal(item.contactNumber, created.contactNumber);
    assert.equal(item.location, created.location);
    assert.equal(item.address, created.address);
    assert.equal(item.description, created.description);
    assert.equal(item.preferredTime, created.preferredTime);
  }
  const invalidDescription = `Rejected Request Service validation verification ${Date.now()}`;
  const invalidResponse = await fetch("http://localhost:8000/api/homeowners/service-requests", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      targetWorkerId: String(worker._id),
      serviceType: "General Repair",
      description: invalidDescription,
      preferredDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      preferredTime: "10:30",
      contactNumber: "08123456789",
      province: "Pangasinan",
      city: "Mangaldan",
      barangay: "Osiem",
      address: "",
    }),
  });
  assert.equal(invalidResponse.status, 400, "Invalid contact is rejected by the live API");
  await mongoose.connect(mongoUrl);
  const rejectedDocumentCount = await ServiceRequest.countDocuments({ description: invalidDescription });
  await mongoose.disconnect();
  assert.equal(rejectedDocumentCount, 0, "Invalid input creates no MongoDB request");
  console.log(JSON.stringify({
    requestId,
    mongoDocuments: 1,
    requestViewsMatched: ["Homeowner", "Worker", "Admin"],
    workerNotification: true,
    adminNotification: true,
    invalidRequestStatus: 400,
    invalidMongoDocuments: rejectedDocumentCount,
  }, null, 2));
}
if (!verifyRecentOnly) {
const authScript = `(() => {
  if (location.origin !== "http://localhost:5173") return;
  localStorage.setItem("trabahome_homeowner_auth", ${JSON.stringify(JSON.stringify({
    token,
    email: homeowner.email,
    homeowner: { _id: String(homeowner._id), email: homeowner.email },
    signedInAt: new Date().toISOString(),
  }))});
})();`;

const targetResponse = await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" });
assert.equal(targetResponse.status, 200, "Chrome test target opens");
const target = await targetResponse.json();
const client = new CdpClient(target.webSocketDebuggerUrl);

try {
  await client.open();
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    }),
  ]);
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: authScript });
  await client.send("Page.navigate", { url: `http://localhost:5173/profile/${worker._id}` });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = await evaluate(client, `Array.from(document.querySelectorAll("button")).some((item) => item.textContent?.trim() === "Request Service")`);
    if (found) break;
    await delay(200);
  }
  const opened = await evaluate(client, `(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Request Service");
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(opened, true, "Request Service button is available");
  await delay(1200);

  const desktop = JSON.parse(await evaluate(client, `(() => {
    const heading = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service");
    const modal = heading?.parentElement;
    const rectFor = (name) => {
      const label = Array.from(modal?.querySelectorAll("label") || []).find((item) => item.textContent?.trim().startsWith(name));
      const control = label?.querySelector("input, select, textarea");
      if (!control) return null;
      const rect = control.getBoundingClientRect();
      return { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return JSON.stringify({
      text: modal?.innerText || "",
      contact: rectFor("Contact Number"),
      province: rectFor("Province"),
      city: rectFor("Municipality / City"),
      barangay: rectFor("Barangay"),
      address: rectFor("Specific Address / Landmark"),
      description: rectFor("Project Description"),
      date: rectFor("Preferred Date"),
      time: rectFor("Preferred Time"),
    });
  })()`));

  assert.ok(desktop.contact && desktop.province && desktop.city && desktop.barangay, "Location controls render");
  assert.equal(desktop.contact.top, desktop.province.top, "Contact and province share row 1");
  assert.equal(desktop.city.top, desktop.barangay.top, "Municipality and barangay share row 2");
  assert.equal(desktop.date.top, desktop.time.top, "Date and time share row 5");
  assert.ok(Math.abs(desktop.contact.width - desktop.province.width) <= 2, "Row 1 controls have equal widths");
  assert.ok(Math.abs(desktop.city.width - desktop.barangay.width) <= 2, "Row 2 controls have equal widths");
  assert.ok(desktop.address.width > desktop.city.width * 1.8, "Address uses the full row width");
  assert.ok(desktop.description.width > desktop.city.width * 1.8, "Description uses the full row width");
  assert.ok(!/Service location/i.test(desktop.text), "Duplicate Service location panel is absent");
  assert.ok(!/request number/i.test(desktop.text), "Request number copy is absent");
  assert.match(desktop.text, /Specific Address \/ Landmark\s+\(optional\)/i);

  await evaluate(client, `(() => {
    const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
    const city = Array.from(modal?.querySelectorAll("select") || [])[0];
    city.value = "Mangaldan";
    city.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await delay(150);
  const mangaldanOptions = await evaluate(client, `(() => {
    const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
    return Array.from(Array.from(modal?.querySelectorAll("select") || [])[1]?.options || []).map((item) => item.value);
  })()`);
  assert.ok(mangaldanOptions.includes("Osiem"), "Mangaldan shows Osiem barangay");

  await evaluate(client, `(() => {
    const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
    const send = Array.from(modal?.querySelectorAll("button") || []).find((item) => item.textContent?.trim() === "Send Request");
    send?.click();
  })()`);
  await delay(150);
  const validationText = await evaluate(client, `document.body.innerText`);
  assert.match(validationText, /Contact number is required/i);
  assert.match(validationText, /Select a barangay/i);
  assert.match(validationText, /Project description is required/i);
  assert.match(validationText, /Preferred date is required/i);
  assert.match(validationText, /Preferred time is required/i);

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await delay(150);
  const mobile = JSON.parse(await evaluate(client, `(() => {
    const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
    const rectFor = (name) => {
      const label = Array.from(modal?.querySelectorAll("label") || []).find((item) => item.textContent?.trim().startsWith(name));
      const control = label?.querySelector("input, select, textarea");
      const rect = control?.getBoundingClientRect();
      return rect ? { top: Math.round(rect.top), width: Math.round(rect.width) } : null;
    };
    return JSON.stringify({ contact: rectFor("Contact Number"), province: rectFor("Province"), city: rectFor("Municipality / City"), barangay: rectFor("Barangay") });
  })()`));
  assert.ok(mobile.contact.top < mobile.province.top && mobile.province.top < mobile.city.top && mobile.city.top < mobile.barangay.top, "Paired fields stack on mobile");

  let liveRequest = null;
  if (process.env.RUN_LIVE_REQUEST === "1") {
    const description = `Request Service modal transfer verification ${Date.now()}`;
    const preferredDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Network.enable");
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 500,
      downloadThroughput: 5_000_000,
      uploadThroughput: 5_000_000,
      connectionType: "wifi",
    });
    await evaluate(client, `(() => {
      const alertHeading = Array.from(document.querySelectorAll("h3")).find((item) => item.textContent?.trim() === "Wait a moment");
      const alertModal = alertHeading?.parentElement;
      const closeAlert = Array.from(alertModal?.querySelectorAll("button") || [])[0];
      closeAlert?.click();
    })()`);
    await delay(100);
    const submitState = JSON.parse(await evaluate(client, `(() => {
      const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
      const labels = Array.from(modal?.querySelectorAll("label") || []);
      const controlFor = (name) => labels.find((item) => item.textContent?.trim().startsWith(name))?.querySelector("input, select, textarea");
      const setValue = (control, value) => {
        const prototype = control instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : control instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
        control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      };
      setValue(controlFor("Contact Number"), "09123456789");
      setValue(controlFor("Municipality / City"), "Mangaldan");
      setValue(controlFor("Project Description"), ${JSON.stringify(description)});
      setValue(controlFor("Preferred Date"), ${JSON.stringify(preferredDate)});
      setValue(controlFor("Preferred Time"), "10:30");
      return JSON.stringify({ ready: true });
    })()`));
    assert.equal(submitState.ready, true);
    await delay(150);
    await evaluate(client, `(() => {
      const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
      const barangay = Array.from(modal?.querySelectorAll("label") || []).find((item) => item.textContent?.trim().startsWith("Barangay"))?.querySelector("select");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(barangay, "Osiem");
      barangay.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await delay(100);
    await evaluate(client, `(() => {
      const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
      const send = Array.from(modal?.querySelectorAll("button") || []).find((item) => item.textContent?.trim() === "Send Request");
      send.click();
      send.click();
      return true;
    })()`);
    await delay(50);
    const sendingState = JSON.parse(await evaluate(client, `(() => {
      const modal = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Service")?.parentElement;
      const send = Array.from(modal?.querySelectorAll("button") || []).find((item) => /Sending Request|Send Request/.test(item.textContent || ""));
      return JSON.stringify({ disabled: send?.disabled || false, label: send?.textContent?.trim() || "" });
    })()`));
    assert.equal(sendingState.disabled, true, "Submit button disables while the request is pending");
    assert.match(sendingState.label, /Sending Request/i);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const success = await evaluate(client, `Array.from(document.querySelectorAll("h2")).some((item) => item.textContent?.trim() === "Request Sent!")`);
      if (success) break;
      await delay(100);
    }
    const successText = await evaluate(client, `(() => {
      const heading = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent?.trim() === "Request Sent!");
      return heading?.parentElement?.innerText || "";
    })()`);
    assert.match(successText, /Osiem, Mangaldan, Pangasinan/);
    assert.match(successText, /09123456789/);
    assert.ok(!/Not specified|Request Number/i.test(successText));

    await mongoose.connect(mongoUrl);
    const createdItems = await ServiceRequest.find({
      homeownerId: homeowner._id,
      targetWorkerId: worker._id,
      description,
    }).lean();
    await mongoose.disconnect();
    assert.equal(createdItems.length, 1, "Rapid double click saves exactly one MongoDB request");
    const created = createdItems[0];
    assert.equal(created.contactNumber, "09123456789");
    assert.equal(created.province, "Pangasinan");
    assert.equal(created.city, "Mangaldan");
    assert.equal(created.barangay, "Osiem");
    assert.equal(created.address, "");
    assert.equal(created.location, "Osiem, Mangaldan, Pangasinan");
    assert.equal(created.preferredTime, "10:30");

    const getRequests = async (url, authToken) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
      assert.equal(response.status, 200, `${url} returns 200`);
      const payload = await response.json();
      return Array.isArray(payload.items) ? payload.items : Array.isArray(payload.data) ? payload.data : [];
    };
    const [homeownerItems, workerItems, adminItems] = await Promise.all([
      getRequests("http://localhost:8000/api/homeowners/service-requests", token),
      getRequests("http://localhost:8000/api/workers/service-requests", workerToken),
      getRequests("http://localhost:8000/api/admins/service-requests", adminToken),
    ]);
    const requestId = String(created._id);
    const findCreated = (items) => items.find((item) =>
      String(item.id || item._id) === requestId || item.requestNumber === created.requestNumber
    );
    for (const [view, items] of [["Homeowner", homeownerItems], ["Worker", workerItems], ["Admin", adminItems]]) {
      const item = findCreated(items);
      assert.ok(item, `${view} API includes the saved request`);
      assert.equal(item.contactNumber, "09123456789");
      assert.equal(item.location, "Osiem, Mangaldan, Pangasinan");
      assert.equal(item.address, "");
      assert.equal(item.description, description);
      assert.equal(item.preferredTime, "10:30");
    }
    liveRequest = { requestId, savedCount: createdItems.length, viewsMatched: 3 };
  }

  console.log(JSON.stringify({
    desktopRows: {
      row1: [desktop.contact, desktop.province],
      row2: [desktop.city, desktop.barangay],
      row5: [desktop.date, desktop.time],
    },
    mobileStacked: true,
    dependentBarangay: "Osiem",
    inlineValidation: true,
    liveRequest,
  }, null, 2));
} finally {
  client.close();
  await fetch(`http://127.0.0.1:9222/json/close/${target.id}`).catch(() => null);
}
}
