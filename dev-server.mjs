import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import princessHandler from './api/princess.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

try {
  process.loadEnvFile(path.join(projectRoot, '.env.development.local'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

async function handlePrincessRequest(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { reply: 'Method not allowed.' });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128_000) {
      return sendJson(res, 413, { reply: 'Please shorten the conversation and try again.' });
    }
    chunks.push(chunk);
  }

  req.body = Buffer.concat(chunks).toString('utf8');
  const response = {
    setHeader(name, value) {
      res.setHeader(name, value);
      return this;
    },
    status(statusCode) {
      res.statusCode = statusCode;
      return this;
    },
    json(payload) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return this;
    },
  };

  await princessHandler(req, response);
}

async function handleStaticRequest(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }

  let requestPath;
  try {
    requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const segments = relativePath.split(path.sep);
  if (segments.some(segment =>
    segment.startsWith('.') || ['api', 'node_modules', 'user_read_only_context'].includes(segment)
  )) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const filePath = path.resolve(projectRoot, relativePath);
  if (!filePath.startsWith(`${projectRoot}${path.sep}`)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error('Not a file');
    const contentType = contentTypes[path.extname(filePath).toLowerCase()];
    if (!contentType) throw new Error('Unsupported file type');

    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Length': fileInfo.size,
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(filePath));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  try {
    if (requestPath === '/api/princess') {
      await handlePrincessRequest(req, res);
    } else {
      await handleStaticRequest(req, res);
    }
  } catch (error) {
    console.error('Development request failed:', error);
    if (!res.headersSent) sendJson(res, 500, { reply: 'The request could not be completed.' });
    else res.end();
  }
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, '0.0.0.0', () => {
  console.log(`DevMzansi development server listening on port ${port}`);
});
