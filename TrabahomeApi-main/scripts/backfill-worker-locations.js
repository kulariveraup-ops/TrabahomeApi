import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Worker from "../models/worker.Model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const MAP_BOUNDS = {
  minLat: 15.65,
  maxLat: 16.3,
  minLng: 119.7821,
  maxLng: 120.9421,
};

const CITY_ANCHORS = {
  "Dagupan City": { top: 45, left: 55 },
  Calasiao: { top: 52, left: 56 },
  Lingayen: { top: 48, left: 42 },
  Binmaley: { top: 46, left: 48 },
  "San Fabian": { top: 35, left: 62 },
  Mangaldan: { top: 43, left: 61 },
};

const CITY_ANCHORS_BY_NAME = Object.fromEntries(
  Object.entries(CITY_ANCHORS).map(([name, coords]) => [name.toLowerCase(), coords])
);

const getLocationLatLng = (locationName) => {
  if (!locationName) return null;
  const anchor = CITY_ANCHORS_BY_NAME[String(locationName).toLowerCase()];
  if (!anchor) return null;
  const lat =
    MAP_BOUNDS.maxLat -
    (anchor.top / 100) * (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
  const lng =
    MAP_BOUNDS.minLng +
    (anchor.left / 100) * (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng);
  return { lat, lng };
};

const hasValidCoords = (location) => {
  const coords = location?.coordinates;
  return (
    Array.isArray(coords) &&
    coords.length === 2 &&
    Number.isFinite(coords[0]) &&
    Number.isFinite(coords[1])
  );
};

const main = async () => {
  const mongoUrl = process.env.MONGO_URL || process.env.MONGO_URI;
  if (!mongoUrl) {
    throw new Error("MONGO_URL is not defined in .env");
  }

  await mongoose.connect(mongoUrl, {});

  const workers = await Worker.find().select("city location locationLabel");
  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const worker of workers) {
    if (hasValidCoords(worker.location)) {
      skipped += 1;
      continue;
    }

    const coords = getLocationLatLng(worker.city);
    if (!coords) {
      missing += 1;
      continue;
    }

    worker.location = { type: "Point", coordinates: [coords.lng, coords.lat] };
    worker.locationLabel = worker.locationLabel || worker.city;
    await worker.save();
    updated += 1;
  }

  console.log(`Updated: ${updated}`);
  console.log(`Skipped (already had coords): ${skipped}`);
  console.log(`Missing city mapping: ${missing}`);

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
