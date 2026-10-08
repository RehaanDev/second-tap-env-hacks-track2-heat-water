// The API: every /api/... request ends up here.
// Each route returns { status, json } or { status, redirect }.

import crypto from 'node:crypto';
import { getStore } from './store.js';
import { findMatches, buildPlan } from './matching.js';
import { validateSupply, validateRequest, validateDemand, ValidationError, REPORT_KEY_PATTERN } from './validate.js';
import { USES, BASELINE, CONCRETE, REPORT_MAX_AGE_DAYS, evaluateAllUses } from './quality.js';
import { createUpload, checkUpload, deleteReport, reportLink, FILE_TYPES, MAX_FILE_BYTES } from './files.js';
import { readReport, compareWithReport } from './reader.js';
import { newToken, hashToken, tokenMatches } from './tokens.js';
import { sampleSupplies, sampleRequests } from './seed-data.js';

const ok = (json, status = 200) => ({ status, json });
const fail = (status, message, errors) => ({ status, json: { message, errors } });

const REQUEST_DAYS = 30; // a site's request stays up this long
const MAX_RECORDS = 3000; // a ceiling, so nobody can flood the database
const nowSeconds = () => Math.floor(Date.now() / 1000);

// What the public is allowed to see about a listing. Private fields
// (the link fingerprint, the file's storage key) never leave the server.
function publicSupply(s) {
  return {
    id: s.id, name: s.name, area: s.area, lat: s.lat, lng: s.lng,
    surplusKld: s.surplusKld, pricePerKl: s.pricePerKl, delivery: s.delivery,
    quality: s.quality, testDate: s.testDate,
    hasReport: Boolean(s.reportKey), reportStatus: s.reportStatus ?? 'none', reportDiffers: s.reportDiffers ?? [],
    contactName: s.contactName, phone: s.phone, sample: Boolean(s.sample),
    paused: Boolean(s.paused), updatedAt: s.updatedAt ?? s.createdAt,
  };
}

function publicRequest(r) {
  return {
    id: r.id, siteName: r.siteName, area: r.area, lat: r.lat, lng: r.lng,
    needKld: r.needKld, use: r.use, contactName: r.contactName, phone: r.phone,
    sample: Boolean(r.sample), createdAt: r.createdAt,
  };
}

async function liveSupplies(store) {
  return (await store.list('SUPPLY')).filter((s) => !s.paused);
}

async function openRequests(store) {
  // DynamoDB removes expired requests by itself, but that can lag by a day
  // or two, so we also filter here.
  return (await store.list('REQUEST')).filter((r) => r.expiresAt > nowSeconds());
}

// Finds a record and checks the private link's token. Returns null if either fails.
async function ownedRecord(store, kind, body) {
  const record = typeof body?.id === 'string' ? await store.get(kind, body.id) : null;
  return record && tokenMatches(body.token, record.manageHash) ? record : null;
}

// Checks the attached report file and works out whether it agrees with the typed numbers.
async function attachReportStatus(supply) {
  if (supply.reportKey && !(await checkUpload(supply.reportKey))) {
    throw new ValidationError({ report: 'The lab report did not upload correctly. Choose the file again.' });
  }
  const { status, fields } = await compareWithReport(supply);
  supply.reportStatus = status;
  supply.reportDiffers = fields;
}

const BAD_LINK = 'This private link is not valid. Check that you copied the whole link.';

const routes = {
  // Dropdown options and the limits shown on the "How water is checked" page.
  'GET /api/config': async () =>
    ok({
      uses: USES.map(({ id, label }) => ({ id, label })),
      limits: { baseline: BASELINE, concrete: CONCRETE, reportMaxAgeDays: REPORT_MAX_AGE_DAYS },
      upload: { types: Object.keys(FILE_TYPES), maxBytes: MAX_FILE_BYTES },
      requestDays: REQUEST_DAYS,
    }),

  // ---------------- listings (apartments) ----------------
  'GET /api/supplies': async () => {
    const store = await getStore();
    return ok({ supplies: (await liveSupplies(store)).map(publicSupply) });
  },

  // An apartment publishes its spare treated water.
  'POST /api/supplies': async ({ body }) => {
    const supply = validateSupply(body);
    const store = await getStore();
    if ((await store.list('SUPPLY')).length >= MAX_RECORDS) return fail(503, 'Second Tap is full right now. Try again later.');
    await attachReportStatus(supply);

    const token = newToken();
    supply.id = crypto.randomUUID();
    supply.manageHash = hashToken(token);
    supply.createdAt = supply.updatedAt = new Date().toISOString();
    await store.put('SUPPLY', supply);
    return ok(
      { supply: publicSupply(supply), manageToken: token, fitByUse: evaluateAllUses(supply.quality, supply.testDate) },
      201
    );
  },

  // Opens a listing for editing. Needs the private link's token.
  'POST /api/supplies/manage': async ({ body }) => {
    const store = await getStore();
    const supply = await ownedRecord(store, 'SUPPLY', body);
    if (!supply) return fail(403, BAD_LINK);
    return ok({ supply: publicSupply(supply), fitByUse: evaluateAllUses(supply.quality, supply.testDate) });
  },

  'POST /api/supplies/update': async ({ body }) => {
    const store = await getStore();
    const existing = await ownedRecord(store, 'SUPPLY', body);
    if (!existing) return fail(403, BAD_LINK);

    const changes = validateSupply(body);
    // Keep the old report unless a new one was uploaded.
    if (!changes.reportKey && existing.reportKey) changes.reportKey = existing.reportKey;
    await attachReportStatus(changes);
    if (existing.reportKey && existing.reportKey !== changes.reportKey) await deleteReport(existing.reportKey);

    const supply = {
      ...changes,
      id: existing.id,
      manageHash: existing.manageHash,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await store.put('SUPPLY', supply);
    return ok({ supply: publicSupply(supply), fitByUse: evaluateAllUses(supply.quality, supply.testDate) });
  },

  // Hide a listing for a while (for example when the plant is under repair), or show it again.
  'POST /api/supplies/pause': async ({ body }) => {
    const store = await getStore();
    const supply = await ownedRecord(store, 'SUPPLY', body);
    if (!supply) return fail(403, BAD_LINK);
    supply.paused = body.paused === true;
    supply.updatedAt = new Date().toISOString();
    await store.put('SUPPLY', supply);
    return ok({ supply: publicSupply(supply) });
  },

  'POST /api/supplies/delete': async ({ body }) => {
    const store = await getStore();
    const supply = await ownedRecord(store, 'SUPPLY', body);
    if (!supply) return fail(403, BAD_LINK);
    if (supply.reportKey) await deleteReport(supply.reportKey);
    await store.remove('SUPPLY', supply.id);
    return ok({ deleted: true });
  },

  // ---------------- matching ----------------
  // A construction site looks for water nearby.
  'POST /api/match': async ({ body }) => {
    const request = validateRequest(body);
    const store = await getStore();
    const found = findMatches(await liveSupplies(store), request);
    const plan = buildPlan(found, request);
    const matches = found.map((m) => ({ ...m, supply: publicSupply(m.supply) }));
    return ok({ request, matches, plan });
  },

  // ---------------- lab reports ----------------
  // Step 1 of uploading a lab report.
  'POST /api/upload-url': async ({ body }) => {
    const upload = await createUpload(body?.contentType);
    if (!upload) return fail(400, 'Upload a PDF, JPG or PNG file.');
    return ok(upload);
  },

  // Step 2: ask the AI to read the values from the uploaded report.
  'POST /api/read-report': async ({ body }) => {
    const key = typeof body?.key === 'string' ? body.key : '';
    if (!REPORT_KEY_PATTERN.test(key) || !(await checkUpload(key))) {
      return fail(400, 'The lab report did not upload correctly. Choose the file again.');
    }
    return ok(await readReport(key));
  },

  // Open a listing's lab report (sends the browser to a temporary link).
  'GET /api/report': async ({ query }) => {
    const store = await getStore();
    const supply = typeof query.id === 'string' ? await store.get('SUPPLY', query.id) : null;
    const link = supply?.reportKey && !supply.paused ? await reportLink(supply.reportKey) : null;
    if (!link) return fail(404, 'This listing has no lab report.');
    return { status: 302, redirect: link };
  },

  // ---------------- requests (construction sites) ----------------
  'GET /api/requests': async () => {
    const store = await getStore();
    const requests = (await openRequests(store)).map(publicRequest);
    requests.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
    return ok({ requests });
  },

  // A site posts what it needs, so apartments can find and call it.
  'POST /api/requests': async ({ body }) => {
    const demand = validateDemand(body);
    const store = await getStore();
    if ((await store.list('REQUEST')).length >= MAX_RECORDS) return fail(503, 'Second Tap is full right now. Try again later.');

    const token = newToken();
    demand.id = crypto.randomUUID();
    demand.manageHash = hashToken(token);
    demand.createdAt = new Date().toISOString();
    demand.expiresAt = nowSeconds() + REQUEST_DAYS * 86400;
    await store.put('REQUEST', demand);
    return ok({ request: publicRequest(demand), manageToken: token, days: REQUEST_DAYS }, 201);
  },

  'POST /api/requests/manage': async ({ body }) => {
    const store = await getStore();
    const request = await ownedRecord(store, 'REQUEST', body);
    if (!request) return fail(403, BAD_LINK);
    return ok({ request: publicRequest(request) });
  },

  'POST /api/requests/close': async ({ body }) => {
    const store = await getStore();
    const request = await ownedRecord(store, 'REQUEST', body);
    if (!request) return fail(403, BAD_LINK);
    await store.remove('REQUEST', request.id);
    return ok({ closed: true });
  },

  // ---------------- samples ----------------
  // Load the sample listings and requests. Safe to call more than once.
  'POST /api/seed': async () => {
    const store = await getStore();
    const supplies = sampleSupplies();
    const requests = sampleRequests();
    for (const s of supplies) await store.put('SUPPLY', s);
    for (const r of requests) await store.put('REQUEST', r);
    return ok({ added: supplies.length, requests: requests.length });
  },
};

export async function handleApi({ method, path, query = {}, body }) {
  const route = routes[`${method} ${path}`];
  if (!route) return fail(404, 'Not found.');
  try {
    return await route({ query, body });
  } catch (err) {
    if (err instanceof ValidationError) return fail(400, 'Some details need fixing.', err.errors);
    console.error('API error', method, path, err);
    return fail(500, 'Something went wrong on the server. Try again.');
  }
}
