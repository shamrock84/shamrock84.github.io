// Shared CORS preamble for every api/*.js endpoint. Both deployment origins
// are needed here because myffl.html is served from GitHub Pages but calls
// these functions on Vercel by absolute URL — every request is cross-origin.

const ALLOWED_ORIGINS = new Set([
  'https://melbostads.com',
  'https://shamrock84.github.io',
]);

// Sets the CORS + cache headers common to every endpoint, then answers an
// OPTIONS preflight itself. Returns true when it already responded (the
// caller should return immediately), false when the real request should
// proceed to method/body handling.
export function applyCors(req, res, { methods, headers } = {}) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (methods) res.setHeader('Access-Control-Allow-Methods', methods);
  if (headers) res.setHeader('Access-Control-Allow-Headers', headers);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
