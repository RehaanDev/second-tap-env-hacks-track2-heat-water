// Matching: given a construction site's request, find apartments nearby
// that can supply it, and work out distance, quality fit and daily cost.

import { evaluate } from './quality.js';

// Straight-line distance between two points on Earth, in km (haversine formula).
export function distanceKm(a, b) {
  const R = 6371;
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// What the buyer would pay per day for a given volume from one seller.
// If no volume is given, it is as much of the need as the seller can cover.
export function estimateCost(supply, request, volume) {
  const volumeKl = volume ?? Math.min(request.needKld, supply.surplusKld);
  const waterCost = volumeKl * supply.pricePerKl;
  const piped = supply.delivery === 'pipeline';
  const trips = piped ? 0 : Math.ceil(volumeKl / request.tankerKl);
  const transportCost = trips * request.tripCost;
  const total = waterCost + transportCost;
  return {
    volumeKl,
    waterCost: Math.round(waterCost),
    trips,
    transportCost: Math.round(transportCost),
    total: Math.round(total),
    perKl: volumeKl > 0 ? Math.round((total / volumeKl) * 10) / 10 : 0,
  };
}

const VERDICT_ORDER = { fit: 0, check: 1, unfit: 2 };
const FIELD_NAMES = {
  ph: 'pH', bod: 'BOD', cod: 'COD', tss: 'suspended solids', fc: 'faecal coliform',
  chloride: 'chlorides', sulphate: 'sulphates', testDate: 'test date',
};

// request: { lat, lng, needKld, use, radiusKm, tripCost, tankerKl }
export function findMatches(supplies, request, today = new Date()) {
  const matches = [];
  for (const supply of supplies) {
    const km = distanceKm(request, supply);
    if (km > request.radiusKm) continue;

    const fit = evaluate(request.use, supply.quality, supply.testDate, today);

    // If the typed numbers disagree with the attached lab report, the buyer
    // should not rely on a "Fit" result without asking.
    if (supply.reportStatus === 'differs' && fit.verdict !== 'unfit') {
      const names = (supply.reportDiffers ?? []).map((f) => FIELD_NAMES[f] ?? f).join(', ');
      const reason = `The numbers entered do not match the attached lab report${names ? ` (${names})` : ''}. Open the report and ask the seller.`;
      fit.reasons = fit.verdict === 'fit' ? [reason] : [reason, ...fit.reasons];
      fit.verdict = 'check';
    }

    matches.push({
      supply,
      distanceKm: Math.round(km * 10) / 10,
      coverage: Math.min(1, supply.surplusKld / request.needKld),
      verdict: fit.verdict,
      reasons: fit.reasons,
      checks: fit.checks,
      cost: estimateCost(supply, request),
    });
  }

  // Best quality fit first, then the nearest.
  matches.sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.distanceKm - b.distanceKm
  );
  return matches;
}

// A suggested order: which "Fit" apartments to buy from, and how much from
// each, to cover the whole need at low cost.
//
// It takes the cheapest water per KL first and moves on when that seller
// runs out. This is a simple, explainable rule; it is a good suggestion,
// not a guaranteed cheapest answer.
export function buildPlan(matches, request) {
  const sellers = matches
    .filter((m) => m.verdict === 'fit')
    .sort((a, b) => a.cost.perKl - b.cost.perKl || a.distanceKm - b.distanceKm);

  let remaining = request.needKld;
  const steps = [];
  for (const m of sellers) {
    if (remaining <= 0) break;
    const volumeKl = Math.min(remaining, m.supply.surplusKld);
    const cost = estimateCost(m.supply, request, volumeKl);
    steps.push({ supplyId: m.supply.id, name: m.supply.name, distanceKm: m.distanceKm, ...cost });
    remaining -= volumeKl;
  }

  const coveredKl = request.needKld - Math.max(0, remaining);
  const total = steps.reduce((sum, s) => sum + s.total, 0);
  return {
    steps,
    coveredKl,
    shortKl: Math.max(0, remaining),
    total,
    perKl: coveredKl > 0 ? Math.round((total / coveredKl) * 10) / 10 : 0,
    // Every KL of treated water used is a KL of fresh water not pumped.
    freshWaterSavedLitres: coveredKl * 1000,
  };
}
