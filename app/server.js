// Runs the whole app on your laptop: http://localhost:3000
//
//   cd app
//   npm start
//
// It wraps each browser request in the same shape API Gateway uses and
// calls the real Lambda handler, so what you test here is what runs on AWS.
// No AWS account is needed: data is saved in a ".local" folder.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from './src/handler.js';
import { handleApi } from './src/api.js';

const PORT = Number(process.env.PORT) || 3000;

// Keep local data in the project root (outside "app"), so it is never
// packaged and sent to AWS.
process.env.LOCAL_DATA_DIR ??= path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.local');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const event = {
    rawPath: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: { http: { method: req.method } },
    body: body.length ? body.toString('base64') : undefined,
    isBase64Encoded: true,
  };

  try {
    const out = await handler(event);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
  } catch (err) {
    console.error(err);
    res.writeHead(500).end('Server error');
  }
});

server.listen(PORT, async () => {
  // Load the sample listings so there is something to see straight away.
  await handleApi({ method: 'POST', path: '/api/seed' });
  console.log(`Second Tap is running at http://localhost:${PORT}`);
});
