import {
  PANGASINAN_PROVINCE,
  normalizePangasinanBarangay,
  normalizePangasinanMunicipality,
} from "./pangasinanLocations.js";

const text = (value) => String(value ?? "").trim();

export const validateServiceRequestContactAndLocation = (payload = {}) => {
  const contactNumber = text(payload.contactNumber);
  if (!/^09\d{9}$/.test(contactNumber)) {
    return { error: "Contact number must be exactly 11 digits and start with 09." };
  }

  const province = text(payload.province);
  if (province.toLocaleLowerCase() !== PANGASINAN_PROVINCE.toLocaleLowerCase()) {
    return { error: "Province must be Pangasinan." };
  }

  const city = normalizePangasinanMunicipality(payload.city ?? payload.municipality);
  if (!city) {
    return { error: "Select a valid Pangasinan municipality or city." };
  }

  const barangay = normalizePangasinanBarangay(city, payload.barangay);
  if (!barangay) {
    return { error: "Select a barangay that belongs to the chosen municipality or city." };
  }

  const address = text(payload.address);

  return {
    value: {
      contactNumber,
      province: PANGASINAN_PROVINCE,
      city,
      barangay,
      address,
      location: `${barangay}, ${city}, ${PANGASINAN_PROVINCE}`,
    },
  };
};
