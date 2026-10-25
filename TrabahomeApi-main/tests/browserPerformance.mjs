import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import HomeOwner from "../models/homeOwner.Model.js";
import Worker from "../models/worker.Model.js";
import Admin from "../models/admin.Model.js";

dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });

const mongoUrl = process.env.MONGO_URL || process.env.MONGO_URI;
if (!mongoUrl) throw new Error("MongoDB connection is not configured.");
await mongoose.connect(mongoUrl, {
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30_000),
});

const [homeowner, worker, admin] = await Promise.all([
  HomeOwner.findOne({ status: { $nin: ["Suspended", "suspended", "Disabled", "disabled"] } })
    .sort({ updatedAt: -1 })
    .select("_id email")
    .lean(),
  Worker.findOne({ $or: [{ status: "Verified" }, { isVerified: true }] })
    .sort({ updatedAt: -1 })
    .select("_id email")
    .lean(),
  Admin.findOne({}).sort({ updatedAt: -1 }).select("_id email").lean(),
]);
await mongoose.disconnect();

if (!homeowner || !worker || !admin) {
  throw new Error("A Homeowner, verified Worker, and Admin are required for performance measurement.");
}

const sign = (person, role) => jwt.sign(
  { id: String(person._id), email: person.email, role },
  process.env.JWT_SECRET || "change-this-secret",
  { expiresIn: "30m" }
);

const authScript = `(() => {
  if (location.origin !== "http://localhost:5173") return;
  localStorage.clear();
  const signedInAt = new Date().toISOString();
  localStorage.setItem("trabahome_homeowner_auth", ${JSON.stringify(JSON.stringify({
    token: sign(homeowner, "homeowner"),
    email: homeowner.email,
    homeowner: { _id: String(homeowner._id), email: homeowner.email },
    signedInAt: new Date().toISOString(),
  }))});
  localStorage.setItem("trabahome_worker_auth", ${JSON.stringify(JSON.stringify({
    token: sign(worker, "worker"),
    email: worker.email,
    worker: { _id: String(worker._id), email: worker.email },
    signedInAt: new Date().toISOString(),
  }))});
  localStorage.setItem("trabahome_admin_auth", ${JSON.stringify(JSON.stringify({
    token: sign(admin, "admin"),
    email: admin.email,
    admin: { _id: String(admin._id), email: admin.email },
    signedInAt: new Date().toISOString(),
  }))});
})();`;

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result || {});
        return;
      }
      const handlers = this.listeners.get(message.method) || [];
      handlers.forEach((handler) => handler(message.params || {}));
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  close() {
    this.ws.close();
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const measurePage = async (path) => {
  const targetResponse = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  if (!targetResponse.ok) throw new Error(`Unable to create browser target: ${targetResponse.status}`);
  const target = await targetResponse.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await Promise.all([
    client.send("Page.enable"),
    client.send("Network.enable"),
    client.send("Runtime.enable"),
    client.send("Performance.enable"),
  ]);
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: authScript });

  const requests = new Map();
  let loadEventAt = 0;
  let lastApiActivityAt = Date.now();
  let navigationStartedAt = Date.now();

  client.on("Page.loadEventFired", () => {
    loadEventAt = Date.now();
  });
  client.on("Network.requestWillBeSent", (event) => {
    const url = String(event.request?.url || "");
    const startedAt = Date.now();
    requests.set(event.requestId, {
      id: event.requestId,
      url,
      method: event.request?.method || "GET",
      type: event.type || "Other",
      startedAt,
      status: null,
      finishedAt: null,
      bytes: 0,
      failed: false,
      error: "",
    });
    if (url.includes("/api/")) lastApiActivityAt = startedAt;
  });
  client.on("Network.responseReceived", (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.status = event.response?.status || null;
    request.mimeType = event.response?.mimeType || "";
    if (request.url.includes("/api/")) lastApiActivityAt = Date.now();
  });
  client.on("Network.loadingFinished", (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.finishedAt = Date.now();
    request.bytes = Number(event.encodedDataLength || 0);
    if (request.url.includes("/api/")) lastApiActivityAt = request.finishedAt;
  });
  client.on("Network.loadingFailed", (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.finishedAt = Date.now();
    request.failed = true;
    request.error = event.errorText || "Request failed";
    if (request.url.includes("/api/")) lastApiActivityAt = request.finishedAt;
  });

  navigationStartedAt = Date.now();
  await client.send("Page.navigate", { url: `http://localhost:5173${path}` });
  const deadline = navigationStartedAt + 15_000;
  while (Date.now() < deadline) {
    const apiRequests = [...requests.values()].filter((request) => request.url.includes("/api/"));
    const pendingApi = apiRequests.filter((request) => !request.finishedAt);
    const minimumObservationComplete = Date.now() - navigationStartedAt >= 2_000;
    const apiQuiet = Date.now() - lastApiActivityAt >= 800;
    if (loadEventAt && minimumObservationComplete && pendingApi.length === 0 && apiQuiet) break;
    await delay(100);
  }

  const apiRequests = [...requests.values()].filter((request) => request.url.includes("/api/"));
  const resourceRequests = [...requests.values()].filter((request) => /^https?:/.test(request.url));
  const simplify = (request) => ({
    url: request.url.replace("http://localhost:8000", ""),
    method: request.method,
    status: request.status,
    durationMs: request.finishedAt ? request.finishedAt - request.startedAt : null,
    completedAtMs: request.finishedAt ? request.finishedAt - navigationStartedAt : null,
    bytes: request.bytes,
    failed: request.failed,
    error: request.error,
  });
  const duplicateUrls = Object.entries(
    apiRequests.reduce((counts, request) => {
      const key = `${request.method} ${request.url}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {})
  ).filter(([, count]) => count > 1);
  const paintResult = await client.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime || 0,
      domContentLoaded: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd || 0,
      load: performance.getEntriesByType("navigation")[0]?.loadEventEnd || 0,
      bodyText: document.body?.innerText?.slice(0, 120) || ""
    })`,
    returnByValue: true,
  });
  const paint = JSON.parse(paintResult.result?.value || "{}");
  const completedApi = apiRequests.filter((request) => request.finishedAt);
  const slowestApi = [...completedApi].sort(
    (left, right) => (right.finishedAt - right.startedAt) - (left.finishedAt - left.startedAt)
  )[0];
  const slowestResource = [...resourceRequests]
    .filter((request) => request.finishedAt)
    .sort((left, right) => (right.finishedAt - right.startedAt) - (left.finishedAt - left.startedAt))[0];

  const result = {
    page: path,
    observedMs: Date.now() - navigationStartedAt,
    fcpMs: Math.round(paint.fcp || 0),
    domContentLoadedMs: Math.round(paint.domContentLoaded || 0),
    loadEventMs: Math.round(paint.load || 0),
    apiCallCount: apiRequests.length,
    pendingApiCount: apiRequests.filter((request) => !request.finishedAt).length,
    duplicateApiCalls: duplicateUrls.map(([key, count]) => ({ request: key.replace("http://localhost:8000", ""), count })),
    slowestApi: slowestApi ? simplify(slowestApi) : null,
    slowestResource: slowestResource ? simplify(slowestResource) : null,
    apiRequests: apiRequests.map(simplify),
    bodyStartedWith: paint.bodyText,
  };

  client.close();
  await fetch(`http://127.0.0.1:9222/json/close/${target.id}`);
  return result;
};

const defaultPages = [
  "/home",
  "/search",
  "/map",
  "/homeowner-profile",
  "/homeowner-bookings",
  "/home-worker",
  "/worker-jobs",
  "/worker-own-profile",
  "/admin-dashboard",
  "/admin-homeowners",
  "/admin-workers",
  "/admin-requests",
];
const requestedPages = process.argv.slice(2).filter((value) => value.startsWith("/"));
const pages = requestedPages.length > 0 ? requestedPages : defaultPages;

const results = [];
for (const page of pages) {
  results.push(await measurePage(page));
}

console.log(JSON.stringify(results, null, 2));
