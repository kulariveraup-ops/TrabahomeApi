import assert from "node:assert/strict";
import test from "node:test";
import { validateServiceRequestContactAndLocation } from "../utils/serviceRequestValidation.js";

const validInput = {
  contactNumber: "09123456789",
  province: "Pangasinan",
  city: "Mangaldan",
  barangay: "Osiem",
  address: "Near Barangay Hall",
};

test("canonicalizes a valid request-specific Pangasinan location", () => {
  const result = validateServiceRequestContactAndLocation(validInput);
  assert.deepEqual(result, {
    value: {
      ...validInput,
      location: "Osiem, Mangaldan, Pangasinan",
    },
  });
});

test("accepts a request without an optional specific address", () => {
  const result = validateServiceRequestContactAndLocation({ ...validInput, address: "" });
  assert.deepEqual(result, {
    value: {
      ...validInput,
      address: "",
      location: "Osiem, Mangaldan, Pangasinan",
    },
  });
});

test("rejects an invalid contact number", () => {
  const result = validateServiceRequestContactAndLocation({ ...validInput, contactNumber: "9123456789" });
  assert.match(result.error, /11 digits.*09/i);
});

test("rejects a barangay from another municipality", () => {
  const result = validateServiceRequestContactAndLocation({ ...validInput, city: "Alaminos City" });
  assert.match(result.error, /barangay.*chosen municipality/i);
});

test("rejects a province outside Pangasinan", () => {
  const result = validateServiceRequestContactAndLocation({ ...validInput, province: "La Union" });
  assert.match(result.error, /province must be Pangasinan/i);
});
