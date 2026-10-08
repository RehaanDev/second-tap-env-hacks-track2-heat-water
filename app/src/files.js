// Lab report files (PDF or photo).
//
// On AWS the browser uploads straight to a private S3 bucket using a
// short-lived "presigned" link, so the file never passes through Lambda.
// On your laptop the file is saved to a local folder instead.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPORT_KEY_PATTERN } from './validate.js';

export const FILE_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LINK_SECONDS = 300;

const isAws = () => Boolean(process.env.REPORTS_BUCKET);
const localDir = () => path.join(process.env.LOCAL_DATA_DIR || '.local', 'uploads');
const localPath = (key) => path.join(localDir(), path.basename(key));

async function s3() {
  const sdk = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  // WHEN_REQUIRED stops the SDK adding a checksum of an empty body to the
  // upload link, which would make S3 reject the real file from the browser.
  const client = new sdk.S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  return { client, getSignedUrl, ...sdk };
}

// Step 1 of an upload: the browser asks where to send the file.
export async function createUpload(contentType) {
  const ext = FILE_TYPES[contentType];
  if (!ext) return null;
  const key = `reports/${crypto.randomUUID()}.${ext}`;

  if (!isAws()) {
    return { key, uploadUrl: `/api/local-upload?key=${encodeURIComponent(key)}`, contentType };
  }
  const { client, PutObjectCommand, getSignedUrl } = await s3();
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: process.env.REPORTS_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: LINK_SECONDS }
  );
  return { key, uploadUrl, contentType };
}

// Is the file really there, and small enough? Returns its size, or null.
// A presigned link cannot limit file size by itself, so we check afterwards
// and delete anything too large.
export async function checkUpload(key) {
  if (!REPORT_KEY_PATTERN.test(key)) return null;
  if (!isAws()) {
    try {
      const { size } = await fs.stat(localPath(key));
      return size > 0 && size <= MAX_FILE_BYTES ? size : null;
    } catch {
      return null;
    }
  }
  const { client, HeadObjectCommand, DeleteObjectCommand } = await s3();
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: process.env.REPORTS_BUCKET, Key: key }));
    if (head.ContentLength > 0 && head.ContentLength <= MAX_FILE_BYTES) return head.ContentLength;
    await client.send(new DeleteObjectCommand({ Bucket: process.env.REPORTS_BUCKET, Key: key }));
    return null;
  } catch {
    return null;
  }
}

// The file's contents, for the AI reader. Returns a Buffer, or null.
export async function getReportBytes(key) {
  if (!(await checkUpload(key))) return null;
  if (!isAws()) return fs.readFile(localPath(key));
  const { client, GetObjectCommand } = await s3();
  const out = await client.send(new GetObjectCommand({ Bucket: process.env.REPORTS_BUCKET, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}

export async function deleteReport(key) {
  if (!REPORT_KEY_PATTERN.test(key)) return;
  try {
    if (!isAws()) return await fs.unlink(localPath(key));
    const { client, DeleteObjectCommand } = await s3();
    await client.send(new DeleteObjectCommand({ Bucket: process.env.REPORTS_BUCKET, Key: key }));
  } catch {
    // Already gone: nothing to do.
  }
}

// A temporary link a buyer can open to read the report.
export async function reportLink(key) {
  if (!REPORT_KEY_PATTERN.test(key)) return null;
  if (!isAws()) return `/api/local-file?key=${encodeURIComponent(key)}`;
  const { client, GetObjectCommand, getSignedUrl } = await s3();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.REPORTS_BUCKET, Key: key }), {
    expiresIn: LINK_SECONDS,
  });
}

// ---------- local-only helpers ----------
export async function saveLocalFile(key, buffer) {
  if (isAws() || !REPORT_KEY_PATTERN.test(key) || buffer.length > MAX_FILE_BYTES) return false;
  await fs.mkdir(localDir(), { recursive: true });
  await fs.writeFile(localPath(key), buffer);
  return true;
}

export async function readLocalFile(key) {
  if (isAws() || !REPORT_KEY_PATTERN.test(key)) return null;
  try {
    const body = await fs.readFile(localPath(key));
    const ext = key.split('.').pop();
    const contentType = Object.keys(FILE_TYPES).find((t) => FILE_TYPES[t] === ext);
    return { body, contentType };
  } catch {
    return null;
  }
}
