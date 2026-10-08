// Water quality screening.
//
// This file answers one question: "Is this apartment's treated water
// suitable for what the buyer wants to do with it?"
//
// It is a SCREENING GUIDE built from published limits. It is not a lab
// certificate. The site engineer makes the final call.

// Limits every listing is checked against, whatever the use.
// Source: National Green Tribunal order of 30 April 2019 on STP effluent
// (pH 5.5-9.0, BOD 10, COD 50, TSS 20, faecal coliform 230 MPN/100 ml).
export const BASELINE = [
  { key: 'ph', label: 'pH', unit: '', min: 5.5, max: 9.0, source: 'NGT 2019' },
  { key: 'bod', label: 'BOD', unit: 'mg/L', max: 10, source: 'NGT 2019' },
  { key: 'cod', label: 'COD', unit: 'mg/L', max: 50, source: 'NGT 2019' },
  { key: 'tss', label: 'Suspended solids', unit: 'mg/L', max: 20, source: 'NGT 2019' },
  { key: 'fc', label: 'Faecal coliform', unit: 'MPN/100 ml', max: 230, source: 'NGT 2019' },
];

// Extra limits for water that touches concrete.
// Source: IS 456:2000 (water for mixing and curing concrete).
export const CONCRETE = [
  { key: 'ph', label: 'pH', unit: '', min: 6.0, source: 'IS 456:2000' },
  { key: 'chloride', label: 'Chlorides', unit: 'mg/L', max: 500, source: 'IS 456:2000 (reinforced concrete)' },
  { key: 'sulphate', label: 'Sulphates', unit: 'mg/L', max: 400, source: 'IS 456:2000' },
];

// The uses a buyer can pick from.
export const USES = [
  { id: 'dust', label: 'Dust control and road wetting', extra: [] },
  { id: 'washing', label: 'Site and vehicle washing', extra: [] },
  { id: 'landscaping', label: 'Landscaping', extra: [] },
  { id: 'curing', label: 'Concrete curing', extra: CONCRETE },
  {
    id: 'mixing',
    label: 'Concrete mixing',
    extra: CONCRETE,
    // Numbers alone are never enough for mixing water, so the best
    // result this use can get is "check".
    alwaysCheck:
      'IS 456 also asks for setting-time and strength tests against a control mix. Your site engineer must approve.',
  },
];

// A lab report older than this is treated as out of date.
// This number is our own rule, not a regulation.
export const REPORT_MAX_AGE_DAYS = 90;

export function findUse(id) {
  return USES.find((u) => u.id === id);
}

function checkOne(limit, quality) {
  const value = quality?.[limit.key];
  const base = { key: limit.key, label: limit.label, unit: limit.unit, source: limit.source, value: value ?? null };
  const parts = [];
  if (limit.min !== undefined) parts.push(`at least ${limit.min}`);
  if (limit.max !== undefined) parts.push(`at most ${limit.max}`);
  base.limit = parts.join(', ');

  if (value === undefined || value === null) return { ...base, status: 'missing' };
  if (limit.min !== undefined && value < limit.min) return { ...base, status: 'fail' };
  if (limit.max !== undefined && value > limit.max) return { ...base, status: 'fail' };
  return { ...base, status: 'pass' };
}

export function ageInDays(testDate, today = new Date()) {
  const t = new Date(`${testDate}T00:00:00Z`).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((today.getTime() - t) / 86400000);
}

// Returns { verdict: 'fit' | 'check' | 'unfit', reasons: [...], checks: [...] }
export function evaluate(useId, quality, testDate, today = new Date()) {
  const use = findUse(useId);
  if (!use) throw new Error(`Unknown use: ${useId}`);

  const checks = [...BASELINE, ...use.extra].map((limit) => checkOne(limit, quality));
  const reasons = [];

  const failed = checks.filter((c) => c.status === 'fail');
  const missing = checks.filter((c) => c.status === 'missing');

  for (const c of failed) {
    reasons.push(`${c.label} is ${c.value}${c.unit ? ' ' + c.unit : ''}; the limit is ${c.limit} (${c.source}).`);
  }
  if (failed.length > 0) return { verdict: 'unfit', reasons, checks };

  for (const c of missing) {
    reasons.push(`${c.label} is not in the lab report. Ask the seller to test it (${c.source}).`);
  }

  const age = ageInDays(testDate, today);
  if (age === null) {
    reasons.push('No test date given.');
  } else if (age > REPORT_MAX_AGE_DAYS) {
    reasons.push(`The lab report is ${age} days old. Ask for a test from the last ${REPORT_MAX_AGE_DAYS} days.`);
  }

  if (use.alwaysCheck) reasons.push(use.alwaysCheck);

  if (reasons.length > 0) return { verdict: 'check', reasons, checks };
  return { verdict: 'fit', reasons: ['All reported values are within the limits for this use.'], checks };
}

// Used after a seller publishes: shows what their water screens as, per use.
export function evaluateAllUses(quality, testDate, today = new Date()) {
  return USES.map((u) => ({ use: u.id, label: u.label, ...evaluate(u.id, quality, testDate, today) }));
}
