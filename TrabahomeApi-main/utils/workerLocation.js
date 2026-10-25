import Worker from "../models/worker.Model.js";

const locationCache = new Map();
const GEOCODE_TIMEOUT_MS = 3_000;
const GEOCODE_SUCCESS_CACHE_MS = 24 * 60 * 60 * 1000;
const GEOCODE_FAILURE_CACHE_MS = 15 * 60 * 1000;

const cleanText = (value) => String(value || "").trim().replace(/\s+/g, " ");

const normalizePlaceName = (value) =>
  cleanText(value)
    .toLowerCase()
    .replace(/^(barangay|brgy\.?)\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const isValidLatLng = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180 &&
  !(lat === 0 && lng === 0);

const EARTH_METERS_PER_DEGREE = 111_320;
const STABLE_OFFSET_METERS = 520;
const STABLE_OFFSET_SLOT_COUNT = 12;
const STABLE_OFFSET_SLOT_STEP = 5;
const STABLE_OFFSET_PHASE_DEGREES = 90;

const hashText = (value) => {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const canonicalSavedLocationLabel = (worker) =>
  [worker?.barangay, worker?.city || worker?.municipality, worker?.province]
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join(", ");

const hasDirectExactCoordinates = (worker) =>
  isValidLatLng(Number(worker?.location?.lat), Number(worker?.location?.lng));

const isSystemResolvedLocation = (worker, source) => {
  if (source === "geocoded") return true;
  if (hasDirectExactCoordinates(worker)) return false;

  const savedLabel = cleanText(worker?.locationLabel).toLowerCase();
  const canonicalLabel = canonicalSavedLocationLabel(worker).toLowerCase();
  return Boolean(savedLabel && canonicalLabel && savedLabel === canonicalLabel);
};

export const getStableWorkerMapCoordinates = (worker, coords, { source = "stored" } = {}) => {
  const lat = Number(coords?.lat);
  const lng = Number(coords?.lng);
  const workerId = String(worker?._id || worker?.id || "").trim();

  if (!workerId || !isValidLatLng(lat, lng) || !isSystemResolvedLocation(worker, source)) {
    return isValidLatLng(lat, lng) ? { lat, lng } : null;
  }

  const angleHash = hashText(`angle:${workerId}`);
  const angleSlot = ((angleHash % STABLE_OFFSET_SLOT_COUNT) * STABLE_OFFSET_SLOT_STEP) % STABLE_OFFSET_SLOT_COUNT;
  const angleDegrees =
    STABLE_OFFSET_PHASE_DEGREES +
    angleSlot * (360 / STABLE_OFFSET_SLOT_COUNT);
  const angleRadians = angleDegrees * (Math.PI / 180);
  const latitudeOffset =
    (Math.cos(angleRadians) * STABLE_OFFSET_METERS) / EARTH_METERS_PER_DEGREE;
  const longitudeScale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const longitudeOffset =
    (Math.sin(angleRadians) * STABLE_OFFSET_METERS) /
    (EARTH_METERS_PER_DEGREE * longitudeScale);

  return {
    lat: lat + latitudeOffset,
    lng: lng + longitudeOffset,
  };
};

const extractCoordinates = (worker) => {
  if (!worker || typeof worker !== "object") return null;

  const directLat = Number(worker?.location?.lat);
  const directLng = Number(worker?.location?.lng);
  if (isValidLatLng(directLat, directLng)) {
    return { lat: directLat, lng: directLng };
  }

  const coordinates = worker?.location?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    const [lng, lat] = coordinates;
    const resolvedLat = Number(lat);
    const resolvedLng = Number(lng);
    if (isValidLatLng(resolvedLat, resolvedLng)) {
      return { lat: resolvedLat, lng: resolvedLng };
    }
  }

  return null;
};

const buildLocationLabel = (worker) => {
  if (!worker || typeof worker !== "object") return "";

  const savedFieldsLabel = [worker?.barangay, worker?.city, worker?.province]
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join(", ");
  if (savedFieldsLabel) return savedFieldsLabel;

  const explicitLabel = cleanText(
    worker?.locationLabel ||
      worker?.location?.label ||
      worker?.location?.address ||
      worker?.location?.location ||
      worker?.location?.name
  );
  if (explicitLabel) return explicitLabel;

  const explicitString = cleanText(worker?.location);
  if (explicitString && !/^\[object object\]$/i.test(explicitString)) {
    return explicitString;
  }

  return "";
};

const barangayAddressPart = (value) => {
  const barangay = cleanText(value);
  if (!barangay) return "";
  return /^(barangay|brgy\.?)(\s|$)/i.test(barangay) ? barangay : `Barangay ${barangay}`;
};

const buildGeocodingQueries = (worker) => {
  const rawBarangay = cleanText(worker?.barangay);
  const barangay = barangayAddressPart(rawBarangay);
  const city = cleanText(worker?.city || worker?.municipality);
  const cityWithoutSuffix = city.replace(/\s+(city|municipality)$/i, "").trim();
  const province = cleanText(worker?.province);
  const explicitAddress = cleanText(
    worker?.location?.address ||
      worker?.location?.location ||
      (typeof worker?.location === "string" ? worker.location : "")
  );

  const candidates = [
    { parts: [explicitAddress, rawBarangay, city, province, "Philippines"], requireBarangay: Boolean(rawBarangay) },
    { parts: [rawBarangay, city, province, "Philippines"], requireBarangay: Boolean(rawBarangay) },
    { parts: [rawBarangay, cityWithoutSuffix, province, "Philippines"], requireBarangay: Boolean(rawBarangay) },
    { parts: [barangay, city, province, "Philippines"], requireBarangay: Boolean(rawBarangay) },
    { parts: [rawBarangay, city, "Philippines"], requireBarangay: Boolean(rawBarangay) },
    { parts: [rawBarangay, cityWithoutSuffix, "Philippines"], requireBarangay: Boolean(rawBarangay) },
    { parts: [barangay, city, "Philippines"], requireBarangay: Boolean(rawBarangay) },
    { parts: [city, province, "Philippines"], requireBarangay: false },
    { parts: [cityWithoutSuffix, province, "Philippines"], requireBarangay: false },
    { parts: [province, "Philippines"], requireBarangay: false },
  ]
    .map(({ parts, requireBarangay }) => ({
      query: parts.map(cleanText).filter(Boolean).join(", "),
      requireBarangay,
    }))
    .filter(({ query }) => Boolean(query));

  return [...new Set(candidates.map(({ query }) => query.toLowerCase()))].map(
    (normalized) => candidates.find(({ query }) => query.toLowerCase() === normalized)
  );
};

const resultMatchesBarangay = (result, barangay) => {
  const expected = normalizePlaceName(barangay);
  if (!expected) return true;

  const address = result?.address && typeof result.address === "object" ? result.address : {};
  const placeNames = [
    result?.display_name,
    result?.name,
    address?.barangay,
    address?.village,
    address?.suburb,
    address?.quarter,
    address?.neighbourhood,
    address?.hamlet,
  ]
    .map(normalizePlaceName)
    .filter(Boolean);

  return placeNames.some(
    (placeName) => placeName === expected || placeName.split(" ").includes(expected) || placeName.includes(expected)
  );
};

const geocodeLocation = async (label, { requiredBarangay = "" } = {}) => {
  const query = cleanText(label);
  if (!query) return null;

  const cacheKey = `${query.toLowerCase()}::barangay:${normalizePlaceName(requiredBarangay)}`;
  const cached = locationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const request = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ph&addressdetails=1&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Accept-Language": "en",
          "User-Agent": "TrabaHome/1.0",
        },
      });

      if (!response.ok) return null;

      const results = await response.json();
      const first = Array.isArray(results)
        ? results.find((result) => resultMatchesBarangay(result, requiredBarangay))
        : null;
      const lat = Number(first?.lat);
      const lng = Number(first?.lon);

      if (!isValidLatLng(lat, lng)) return null;

      return { lat, lng };
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  const cacheEntry = {
    promise: request,
    expiresAt: Date.now() + GEOCODE_FAILURE_CACHE_MS,
  };
  locationCache.set(cacheKey, cacheEntry);
  const resolved = await request;
  if (resolved) {
    cacheEntry.expiresAt = Date.now() + GEOCODE_SUCCESS_CACHE_MS;
  }
  return resolved;
};

const geocodeWorkerLocation = async (worker) => {
  const queries = buildGeocodingQueries(worker);
  for (const { query, requireBarangay } of queries) {
    const coords = await geocodeLocation(query, {
      requiredBarangay: requireBarangay ? worker?.barangay : "",
    });
    if (coords) return { coords, query };
  }
  return { coords: null, query: "" };
};

const persistWorkerLocation = async (workerId, label, coords) => {
  if (!workerId || !coords) return;

  await Worker.updateOne(
    { _id: workerId },
    {
      $set: {
        location: {
          type: "Point",
          coordinates: [coords.lng, coords.lat],
        },
        locationLabel: cleanText(label),
      },
    }
  );
};

export const resolveWorkerLocation = async (worker, { persist = false, geocode = true } = {}) => {
  const locationLabel = buildLocationLabel(worker);
  const existingCoords = extractCoordinates(worker);
  const savedLocationLabel = cleanText(worker?.locationLabel);
  const coordinatesAreStale = Boolean(
    existingCoords &&
      savedLocationLabel &&
      locationLabel &&
      savedLocationLabel.toLowerCase() !== locationLabel.toLowerCase()
  );

  if (existingCoords && (!coordinatesAreStale || !geocode)) {
    if (persist && worker?._id && locationLabel) {
      const currentLabel = cleanText(worker?.locationLabel);
      if (currentLabel !== locationLabel) {
        await persistWorkerLocation(worker._id, locationLabel, existingCoords);
      }
    }

    return {
      locationLabel,
      coords: existingCoords,
      source: "stored",
    };
  }

  if (!locationLabel) {
    return {
      locationLabel: "",
      coords: null,
      source: "missing",
    };
  }

  if (!geocode) {
    return {
      locationLabel,
      coords: null,
      source: "missing",
    };
  }

  const { coords: geocodedCoords } = await geocodeWorkerLocation(worker);
  if (geocodedCoords && persist && worker?._id) {
    await persistWorkerLocation(worker._id, locationLabel, geocodedCoords);
  }

  return {
    locationLabel,
    coords: geocodedCoords || existingCoords,
    source: geocodedCoords ? "geocoded" : existingCoords ? "stored" : "missing",
  };
};
