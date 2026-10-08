// AWS Lambda entry point.
//
// API Gateway sends every web request here. Requests that start with /api/
// go to the API; everything else is a file from the "public" folder
// (the website itself). One function serves both, so there is one URL
// and nothing extra to configure.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.js';
import { saveLocalFile, readLocalFile } from './files.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};
const BINARY = new Set(['.woff2', '.png']);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

// The site's own address, for example https://abc123.execute-api.ap-south-1.amazonaws.com.
// Link previews (WhatsApp, LinkedIn) need full addresses, so the home page
// has this filled in as it is served.
function siteOrigin(event) {
  const safe = (host) => (typeof host === 'string' && /^[a-z0-9.:-]{1,200}$/i.test(host) ? host : null);
  const awsHost = safe(event.requestContext?.domainName);
  if (awsHost) return `https://${awsHost}`;
  return `http://${safe(event.headers?.host) ?? 'localhost:3000'}`;
}

async function serveFile(urlPath, event) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, relative));
  const ext = path.extname(file);
  // Never serve anything outside the public folder.
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !TYPES[ext]) return notFound();
  try {
    let data = await fs.readFile(file);
    const isBinary = BINARY.has(ext);
    if (relative === 'index.html') data = Buffer.from(data.toString('utf8').replaceAll('__ORIGIN__', siteOrigin(event)));
    return {
      statusCode: 200,
      headers: {
        ...SECURITY_HEADERS,
        'content-type': TYPES[ext],
        'cache-control': relative.startsWith('vendor/') ? 'public, max-age=604800' : 'no-cache',
      },
      body: isBinary ? data.toString('base64') : data.toString('utf8'),
      isBase64Encoded: isBinary,
    };
  } catch {
    return notFound();
  }
}

function notFound() {
  return json(404, { message: 'Not found.' });
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(data),
  };
}

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const urlPath = event.rawPath ?? '/';
  const query = event.queryStringParameters ?? {};

  if (!urlPath.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') return json(405, { message: 'Method not allowed.' });
    return serveFile(urlPath, event);
  }

  const raw = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : null;

  // These two routes only exist when running on your laptop (no S3).
  if (urlPath === '/api/local-upload' && method === 'PUT') {
    const saved = raw && (await saveLocalFile(query.key ?? '', raw));
    return saved ? json(200, { saved: true }) : json(400, { message: 'Upload failed.' });
  }
  if (urlPath === '/api/local-file' && method === 'GET') {
    const found = await readLocalFile(query.key ?? '');
    if (!found) return notFound();
    return {
      statusCode: 200,
      headers: { ...SECURITY_HEADERS, 'content-type': found.contentType },
      body: found.body.toString('base64'),
      isBase64Encoded: true,
    };
  }

  let body;
  if (raw && raw.length > 0) {
    if (raw.length > 20000) return json(413, { message: 'Request is too large.' });
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(400, { message: 'The request was not valid JSON.' });
    }
  }

  const result = await handleApi({ method, path: urlPath, query, body });
  if (result.redirect) {
    return { statusCode: result.status, headers: { ...SECURITY_HEADERS, location: result.redirect, 'cache-control': 'no-store' }, body: '' };
  }
  return json(result.status, result.json);
}
