// Input checks. Everything that arrives from the browser passes through here
// before it is stored or used, so bad data never reaches the database.

import { USES } from './quality.js';

export class ValidationError extends Error {
  constructor(errors) {
    super('Invalid input');
    this.errors = errors; // { fieldName: 'what is wrong' }
  }
}

function num(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

function requireRange(errors, field, value, min, max, label) {
  if (value === undefined || Number.isNaN(value)) {
    errors[field] = `Enter ${label}.`;
  } else if (value < min || value > max) {
    errors[field] = `${label[0].toUpperCase()}${label.slice(1)} must be between ${min} and ${max}.`;
  }
}

function optionalRange(errors, field, value, min, max, label) {
  if (value === undefined) return;
  if (Number.isNaN(value) || value < min || value > max) {
    errors[field] = `${label[0].toUpperCase()}${label.slice(1)} must be between ${min} and ${max}, or left empty.`;
  }
}

function checkLocation(errors, lat, lng) {
  // Rough bounding box for India.
  if (lat === undefined || lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
    errors.location = 'Choose a location: pick an area, tap the map, or use your current location.';
  } else if (lat < 6 || lat > 37.5 || lng < 68 || lng > 97.5) {
    errors.location = 'That location is outside India. Choose a point on the map.';
  }
}

const PHONE_PATTERN = /^[6-9]\d{9}$/;
// "+91 98765 43210" and "098765 43210" both become "9876543210".
function cleanPhone(value) {
  return text(value, 20).replace(/[^\d]/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
}

export const REPORT_KEY_PATTERN = /^reports\/[0-9a-f-]{36}\.(pdf|jpg|png)$/;
const DELIVERY = ['pickup', 'pipeline'];

export function validateSupply(input = {}, today = new Date()) {
  const errors = {};
  const q = input.quality || {};

  const supply = {
    name: text(input.name, 80),
    area: text(input.area, 60),
    lat: num(input.lat),
    lng: num(input.lng),
    surplusKld: num(input.surplusKld),
    pricePerKl: num(input.pricePerKl),
    delivery: DELIVERY.includes(input.delivery) ? input.delivery : 'pickup',
    quality: {
      ph: num(q.ph),
      bod: num(q.bod),
      cod: num(q.cod),
      tss: num(q.tss),
      fc: num(q.fc),
      chloride: num(q.chloride),
      sulphate: num(q.sulphate),
    },
    testDate: text(input.testDate, 10),
    reportKey: text(input.reportKey, 80),
    contactName: text(input.contactName, 60),
    phone: cleanPhone(input.phone),
    paused: input.paused === true,
  };

  if (supply.name.length < 3) errors.name = 'Enter the apartment or community name.';
  if (supply.area.length < 2) errors.area = 'Enter the area or locality.';
  checkLocation(errors, supply.lat, supply.lng);
  requireRange(errors, 'surplusKld', supply.surplusKld, 1, 5000, 'spare water per day (KL)');
  requireRange(errors, 'pricePerKl', supply.pricePerKl, 0, 500, 'price per KL (₹)');

  requireRange(errors, 'ph', supply.quality.ph, 0, 14, 'pH');
  requireRange(errors, 'bod', supply.quality.bod, 0, 1000, 'BOD');
  requireRange(errors, 'cod', supply.quality.cod, 0, 5000, 'COD');
  requireRange(errors, 'tss', supply.quality.tss, 0, 5000, 'suspended solids');
  requireRange(errors, 'fc', supply.quality.fc, 0, 100000000, 'faecal coliform');
  optionalRange(errors, 'chloride', supply.quality.chloride, 0, 50000, 'chlorides');
  optionalRange(errors, 'sulphate', supply.quality.sulphate, 0, 50000, 'sulphates');

  // Drop empty optional values so they are stored as "not reported".
  for (const key of ['chloride', 'sulphate']) {
    if (supply.quality[key] === undefined) delete supply.quality[key];
  }

  const todayIso = today.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(supply.testDate) || Number.isNaN(Date.parse(supply.testDate))) {
    errors.testDate = 'Enter the date on the lab report.';
  } else if (supply.testDate > todayIso) {
    errors.testDate = 'The test date cannot be in the future.';
  }

  if (supply.reportKey && !REPORT_KEY_PATTERN.test(supply.reportKey)) {
    errors.report = 'The lab report did not upload correctly. Choose the file again.';
  }
  if (!supply.reportKey) delete supply.reportKey;

  if (supply.contactName.length < 2) errors.contactName = 'Enter a contact name.';
  if (!PHONE_PATTERN.test(supply.phone)) errors.phone = 'Enter a 10-digit Indian mobile number.';

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return supply;
}

export function validateRequest(input = {}) {
  const errors = {};
  const request = {
    lat: num(input.lat),
    lng: num(input.lng),
    needKld: num(input.needKld),
    use: text(input.use, 20),
    radiusKm: num(input.radiusKm) ?? 5,
    tankerKl: num(input.tankerKl) ?? 12,
    tripCost: num(input.tripCost) ?? 0,
  };

  checkLocation(errors, request.lat, request.lng);
  requireRange(errors, 'needKld', request.needKld, 1, 5000, 'water needed per day (KL)');
  if (!USES.some((u) => u.id === request.use)) errors.use = 'Choose what the water is for.';
  requireRange(errors, 'radiusKm', request.radiusKm, 1, 25, 'search distance (km)');
  requireRange(errors, 'tankerKl', request.tankerKl, 1, 40, 'tanker size (KL)');
  requireRange(errors, 'tripCost', request.tripCost, 0, 20000, 'tanker cost per trip (₹)');

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return request;
}

// A construction site posting its need publicly, so apartments can find it.
export function validateDemand(input = {}) {
  const errors = {};
  const demand = {
    siteName: text(input.siteName, 80),
    area: text(input.area, 60),
    lat: num(input.lat),
    lng: num(input.lng),
    needKld: num(input.needKld),
    use: text(input.use, 20),
    contactName: text(input.contactName, 60),
    phone: cleanPhone(input.phone),
  };

  if (demand.siteName.length < 3) errors.siteName = 'Enter the site or project name.';
  if (demand.area.length < 2) errors.area = 'Enter the area or locality.';
  checkLocation(errors, demand.lat, demand.lng);
  requireRange(errors, 'needKld', demand.needKld, 1, 5000, 'water needed per day (KL)');
  if (!USES.some((u) => u.id === demand.use)) errors.use = 'Choose what the water is for.';
  if (demand.contactName.length < 2) errors.contactName = 'Enter a contact name.';
  if (!PHONE_PATTERN.test(demand.phone)) errors.phone = 'Enter a 10-digit Indian mobile number.';

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return demand;
}
