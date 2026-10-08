// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'second-tap-'));
delete process.env.TABLE_NAME;
delete process.env.REPORTS_BUCKET;
delete process.env.REPORT_READER_MODELS;

const { evaluate } = await import('../src/quality.js');
const { distanceKm, estimateCost, findMatches, buildPlan } = await import('../src/matching.js');
const { validateSupply, validateRequest, validateDemand, ValidationError } = await import('../src/validate.js');
const { parseReading } = await import('../src/reader.js');
const { newToken, hashToken, tokenMatches } = await import('../src/tokens.js');
const { handler } = await import('../src/handler.js');

const TODAY = new Date('2026-10-08T06:00:00Z');
const GOOD = { ph: 7.2, bod: 6, cod: 32, tss: 9, fc: 80 };
const isoToday = () => new Date().toISOString().slice(0, 10);

// ---------------- quality ----------------
test('clean, recent water is fit for dust control', () => {
  assert.equal(evaluate('dust', GOOD, '2026-09-20', TODAY).verdict, 'fit');
});

test('values exactly on the limit still pass', () => {
  const edge = { ph: 9, bod: 10, cod: 50, tss: 20, fc: 230 };
  assert.equal(evaluate('dust', edge, '2026-09-20', TODAY).verdict, 'fit');
});

test('one value over its limit makes the water unfit', () => {
  const r = evaluate('dust', { ...GOOD, bod: 16 }, '2026-09-20', TODAY);
  assert.equal(r.verdict, 'unfit');
  assert.match(r.reasons[0], /BOD is 16/);
});

test('curing needs chloride and sulphate; missing ones mean "check"', () => {
  assert.equal(evaluate('curing', GOOD, '2026-09-20', TODAY).verdict, 'check');
  assert.equal(evaluate('curing', { ...GOOD, chloride: 180, sulphate: 95 }, '2026-09-20', TODAY).verdict, 'fit');
  assert.equal(evaluate('curing', { ...GOOD, chloride: 620, sulphate: 95 }, '2026-09-20', TODAY).verdict, 'unfit');
});

test('concrete uses apply the stricter pH floor of 6', () => {
  const acidic = { ...GOOD, ph: 5.8, chloride: 100, sulphate: 100 };
  assert.equal(evaluate('dust', acidic, '2026-09-20', TODAY).verdict, 'fit');
  assert.equal(evaluate('curing', acidic, '2026-09-20', TODAY).verdict, 'unfit');
});

test('concrete mixing never gets better than "check"', () => {
  assert.equal(evaluate('mixing', { ...GOOD, chloride: 180, sulphate: 95 }, '2026-09-20', TODAY).verdict, 'check');
});

test('an old lab report means "check"', () => {
  assert.equal(evaluate('dust', GOOD, '2026-05-01', TODAY).verdict, 'check');
});

// ---------------- matching ----------------
test('distance: Jakkur to Yelahanka is roughly 2.7 km', () => {
  const km = distanceKm({ lat: 13.0784, lng: 77.6069 }, { lat: 13.1005, lng: 77.5963 });
  assert.ok(km > 2.4 && km < 3.0, `got ${km}`);
});

test('cost: water plus tanker trips, capped at what the seller has', () => {
  const cost = estimateCost({ surplusKld: 45, pricePerKl: 8, delivery: 'pickup' }, { needKld: 60, tankerKl: 12, tripCost: 800 });
  assert.deepEqual(cost, { volumeKl: 45, waterCost: 360, trips: 4, transportCost: 3200, total: 3560, perKl: 79.1 });
});

test('cost: pipeline sellers have no tanker trips', () => {
  const cost = estimateCost({ surplusKld: 120, pricePerKl: 12, delivery: 'pipeline' }, { needKld: 60, tankerKl: 12, tripCost: 800 });
  assert.equal(cost.transportCost, 0);
  assert.equal(cost.total, 720);
});

const REQUEST = { lat: 13.0784, lng: 77.6069, needKld: 60, use: 'dust', radiusKm: 5, tankerKl: 12, tripCost: 800 };
const seller = (id, extra) => ({ id, name: id, lat: 13.08, lng: 77.607, surplusKld: 50, pricePerKl: 10, delivery: 'pickup', quality: GOOD, testDate: '2026-09-20', ...extra });

test('matching keeps only sellers inside the radius, best fit first', () => {
  const supplies = [seller('far', { lat: 12.85, lng: 77.66 }), seller('bad', { quality: { ...GOOD, cod: 90 } }), seller('good', { lat: 13.09, lng: 77.6 })];
  assert.deepEqual(findMatches(supplies, REQUEST, TODAY).map((m) => m.supply.id), ['good', 'bad']);
});

test('numbers that disagree with the attached report turn "fit" into "check"', () => {
  const [m] = findMatches([seller('x', { reportStatus: 'differs', reportDiffers: ['bod'] })], REQUEST, TODAY);
  assert.equal(m.verdict, 'check');
  assert.match(m.reasons[0], /do not match the attached lab report \(BOD\)/);
});

test('plan: fills the need from the cheapest fit sellers and ignores the rest', () => {
  const supplies = [
    seller('pricey', { surplusKld: 100, pricePerKl: 40 }),
    seller('cheap-small', { surplusKld: 24, pricePerKl: 5 }),
    seller('piped', { surplusKld: 20, pricePerKl: 12, delivery: 'pipeline' }),
    seller('dirty', { pricePerKl: 1, quality: { ...GOOD, tss: 90 } }),
  ];
  const plan = buildPlan(findMatches(supplies, REQUEST, TODAY), REQUEST);
  assert.deepEqual(plan.steps.map((s) => [s.name, s.volumeKl]), [['piped', 20], ['cheap-small', 24], ['pricey', 16]]);
  assert.equal(plan.coveredKl, 60);
  assert.equal(plan.shortKl, 0);
  assert.equal(plan.total, 20 * 12 + (24 * 5 + 2 * 800) + (16 * 40 + 2 * 800));
  assert.equal(plan.freshWaterSavedLitres, 60000);
});

test('plan: says how much is still short when sellers cannot cover the need', () => {
  const plan = buildPlan(findMatches([seller('only', { surplusKld: 25 })], REQUEST, TODAY), REQUEST);
  assert.equal(plan.coveredKl, 25);
  assert.equal(plan.shortKl, 35);
});

// ---------------- validation ----------------
const VALID_SUPPLY = {
  name: 'Test Apartments', area: 'Jakkur', lat: 13.078, lng: 77.607, surplusKld: 40, pricePerKl: 10,
  quality: { ph: 7.1, bod: 5, cod: 30, tss: 8, fc: 60, chloride: '', sulphate: '' },
  testDate: '2026-09-25', contactName: 'Asha', phone: '+91 98765 43210',
};
const VALID_DEMAND = { siteName: 'Test Site', area: 'Jakkur', lat: 13.0784, lng: 77.6069, needKld: 60, use: 'dust', contactName: 'Ravi', phone: '9876501234' };

test('validation: accepts a good listing and cleans the phone number', () => {
  const s = validateSupply(VALID_SUPPLY, TODAY);
  assert.equal(s.phone, '9876543210');
  assert.equal('chloride' in s.quality, false);
});

test('validation: reports every problem by field name', () => {
  try {
    validateSupply({ ...VALID_SUPPLY, name: '', lat: '', phone: '12345', testDate: '2027-01-01', quality: {} }, TODAY);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    for (const key of ['name', 'location', 'phone', 'testDate', 'ph', 'bod']) assert.ok(err.errors[key], key);
  }
});

test('validation: rejects a search with an unknown use, and a request with no contact', () => {
  assert.throws(() => validateRequest({ lat: 13, lng: 77.6, needKld: 10, use: 'drinking' }), ValidationError);
  assert.throws(() => validateDemand({ ...VALID_DEMAND, phone: '' }), ValidationError);
});

// ---------------- private links ----------------
test('tokens: only the right token matches, and tokens are never stored as-is', () => {
  const token = newToken();
  const hash = hashToken(token);
  assert.notEqual(hash, token);
  assert.equal(tokenMatches(token, hash), true);
  assert.equal(tokenMatches(newToken(), hash), false);
  assert.equal(tokenMatches('', hash), false);
  assert.equal(tokenMatches(undefined, hash), false);
});

// ---------------- AI report reading ----------------
test('reader: takes clean values from the model reply and drops nonsense', () => {
  const reply = 'Here you go:\n{"isWaterReport": true, "ph": 7.1, "bod": 5, "cod": "thirty", "tss": -4, "fc": 60, "chloride": null, "sulphate": 80, "testDate": "2026-09-25"}';
  assert.deepEqual(parseReading(reply), { isWaterReport: true, values: { ph: 7.1, bod: 5, fc: 60, sulphate: 80 }, testDate: '2026-09-25' });
});

test('reader: rejects files that are not water reports, future dates and broken replies', () => {
  assert.deepEqual(parseReading('{"isWaterReport": false, "ph": 7}'), { isWaterReport: false, values: {}, testDate: null });
  assert.equal(parseReading('{"isWaterReport": true, "ph": 7, "testDate": "2999-01-01"}').testDate, null);
  assert.equal(parseReading('I cannot read this file.'), null);
});

// ---------------- the whole thing, through the Lambda handler ----------------
const call = async (method, rawPath, body, query) => {
  const out = await handler({
    rawPath, queryStringParameters: query, requestContext: { http: { method } },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ...out, json: out.headers['content-type']?.includes('json') ? JSON.parse(out.body) : null };
};
const upload = async (contentType = 'application/pdf') => {
  const ticket = (await call('POST', '/api/upload-url', { contentType })).json;
  const put = await handler({ rawPath: '/api/local-upload', queryStringParameters: { key: ticket.key }, requestContext: { http: { method: 'PUT' } }, body: Buffer.from('%PDF-1.4 test').toString('base64'), isBase64Encoded: true });
  assert.equal(put.statusCode, 200);
  return ticket.key;
};
const names = async () => (await call('GET', '/api/supplies')).json.supplies.map((s) => s.name);

test('end to end: seed, publish, match with a plan', async () => {
  assert.deepEqual((await call('POST', '/api/seed')).json, { added: 10, requests: 3 });

  const created = await call('POST', '/api/supplies', { ...VALID_SUPPLY, testDate: isoToday() });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json.fitByUse.find((f) => f.use === 'dust').verdict, 'fit');
  assert.ok(created.json.manageToken.length >= 30);
  assert.equal(created.json.supply.reportStatus, 'none');

  const all = await call('GET', '/api/supplies');
  assert.equal(all.json.supplies.length, 11);
  for (const s of all.json.supplies) for (const secret of ['reportKey', 'manageHash']) assert.equal(secret in s, false);

  const found = await call('POST', '/api/match', REQUEST);
  assert.equal(found.statusCode, 200);
  assert.ok(found.json.matches.some((m) => m.supply.name === 'Test Apartments'));
  assert.ok(found.json.matches.every((m) => m.distanceKm <= 5));
  assert.equal(found.json.plan.coveredKl, 60);
});

test('end to end: only the private link can edit, pause or delete a listing', async () => {
  const created = (await call('POST', '/api/supplies', { ...VALID_SUPPLY, name: 'Managed Homes', testDate: isoToday() })).json;
  const key = { id: created.supply.id, token: created.manageToken };
  const wrong = { id: created.supply.id, token: newToken() };

  for (const route of ['manage', 'update', 'pause', 'delete']) {
    assert.equal((await call('POST', `/api/supplies/${route}`, { ...VALID_SUPPLY, ...wrong })).statusCode, 403, route);
    assert.equal((await call('POST', `/api/supplies/${route}`, { ...VALID_SUPPLY, id: created.supply.id })).statusCode, 403, route);
  }

  const updated = await call('POST', '/api/supplies/update', { ...VALID_SUPPLY, name: 'Managed Homes', testDate: isoToday(), surplusKld: 75, ...key });
  assert.equal(updated.json.supply.surplusKld, 75);
  assert.equal(updated.json.supply.id, created.supply.id);

  assert.equal((await call('POST', '/api/supplies/pause', { ...key, paused: true })).json.supply.paused, true);
  assert.equal((await names()).includes('Managed Homes'), false, 'paused listings are hidden');
  assert.equal((await call('POST', '/api/supplies/manage', key)).json.supply.paused, true, 'owner still sees it');
  await call('POST', '/api/supplies/pause', { ...key, paused: false });
  assert.equal((await names()).includes('Managed Homes'), true);

  assert.equal((await call('POST', '/api/supplies/delete', key)).json.deleted, true);
  assert.equal((await names()).includes('Managed Homes'), false);
  assert.equal((await call('POST', '/api/supplies/manage', key)).statusCode, 403);
});

test('end to end: a site posts a request, apartments see it, the site closes it', async () => {
  const before = (await call('GET', '/api/requests')).json.requests.length;
  const posted = await call('POST', '/api/requests', VALID_DEMAND);
  assert.equal(posted.statusCode, 201);
  const list = (await call('GET', '/api/requests')).json.requests;
  assert.equal(list.length, before + 1);
  assert.equal(list[0].siteName, 'Test Site', 'newest first');
  assert.equal('manageHash' in list[0], false);

  const key = { id: posted.json.request.id, token: posted.json.manageToken };
  assert.equal((await call('POST', '/api/requests/close', { ...key, token: 'nope' })).statusCode, 403);
  assert.equal((await call('POST', '/api/requests/manage', key)).json.request.siteName, 'Test Site');
  assert.equal((await call('POST', '/api/requests/close', key)).json.closed, true);
  assert.equal((await call('GET', '/api/requests')).json.requests.length, before);
});

test('end to end: report reading fills values, and typed numbers are compared with it', async () => {
  // Without a reader, the app says so and the seller types the numbers.
  const first = await upload();
  assert.deepEqual((await call('POST', '/api/read-report', { key: first })).json, { available: false });
  const plain = await call('POST', '/api/supplies', { ...VALID_SUPPLY, testDate: isoToday(), reportKey: first });
  assert.equal(plain.json.supply.reportStatus, 'unchecked');

  // With a reader (faked here, so the test never calls the real AI).
  const date = isoToday();
  process.env.FAKE_REPORT_READING = JSON.stringify({ isWaterReport: true, ph: 7.1, bod: 5, cod: 30, tss: 8, fc: 60, chloride: null, sulphate: null, testDate: date });
  const second = await upload();
  const read = (await call('POST', '/api/read-report', { key: second })).json;
  assert.deepEqual(read, { available: true, isWaterReport: true, values: { ph: 7.1, bod: 5, cod: 30, tss: 8, fc: 60 }, testDate: date });

  const honest = await call('POST', '/api/supplies', { ...VALID_SUPPLY, name: 'Honest Homes', testDate: date, reportKey: second });
  assert.equal(honest.json.supply.reportStatus, 'matches');

  const third = await upload();
  await call('POST', '/api/read-report', { key: third });
  const fudged = await call('POST', '/api/supplies', { ...VALID_SUPPLY, name: 'Fudged Homes', testDate: date, reportKey: third, quality: { ...VALID_SUPPLY.quality, bod: 2 } });
  assert.equal(fudged.json.supply.reportStatus, 'differs');
  assert.deepEqual(fudged.json.supply.reportDiffers, ['bod']);
  delete process.env.FAKE_REPORT_READING;

  const found = (await call('POST', '/api/match', REQUEST)).json.matches;
  assert.equal(found.find((m) => m.supply.name === 'Honest Homes').verdict, 'fit');
  assert.equal(found.find((m) => m.supply.name === 'Fudged Homes').verdict, 'check');

  // A report key that was never uploaded is refused.
  const ghost = 'reports/00000000-0000-4000-8000-000000000000.pdf';
  assert.equal((await call('POST', '/api/supplies', { ...VALID_SUPPLY, testDate: date, reportKey: ghost })).json.errors.report.length > 0, true);
  assert.equal((await call('POST', '/api/read-report', { key: ghost })).statusCode, 400);
  assert.equal((await call('POST', '/api/read-report', { key: '../../etc/passwd' })).statusCode, 400);
});

test('end to end: bad input gets a 400 with field messages', async () => {
  const res = await call('POST', '/api/match', { needKld: 60, use: 'dust' });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json.errors.location);
  assert.equal((await call('POST', '/api/upload-url', { contentType: 'text/html' })).statusCode, 400);
});

test('website files are served, and nothing outside the public folder', async () => {
  const page = await call('GET', '/');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Second Tap/);
  assert.equal((await call('GET', '/vendor/fonts/barlow-latin-400-normal.woff2')).isBase64Encoded, true);
  assert.equal((await call('GET', '/../src/handler.js')).statusCode, 404);
  assert.equal((await call('GET', '/../package.json')).statusCode, 404);
});
