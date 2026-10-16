/**
 * Serves the built renderer from disk over http://127.0.0.1:<port>.
 *
 * A real origin (instead of file://) keeps BrowserRouter, fetch, and the
 * browser's secure-context rules happy, and lets the loopback-only CSP apply.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // The renderer talks to Convex over https/wss when the user opts into the cloud path.
  "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:*",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Resolve a request path inside the renderer directory, or null when it escapes. */
export function resolveStaticPath(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0]);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const resolved = path.resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

export function startRendererServer(rendererDir) {
  const root = path.resolve(rendererDir);
  const indexPath = path.join(root, "index.html");

  const server = createServer((request, response) => {
    let target = resolveStaticPath(root, request.url ?? "/");
    if (target === null) {
      response.writeHead(403, { "Content-Type": "text/plain" });
      response.end("forbidden");
      return;
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      target = indexPath; // single-page app: unknown routes fall back to the shell
    }
    const headers = {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
    };
    if (!existsSync(target)) {
      response.writeHead(404, { ...headers, "Content-Type": "text/plain" });
      response.end("the renderer bundle is missing — run `npm run bundle:renderer`");
      return;
    }
    response.writeHead(200, {
      ...headers,
      "Content-Type": MIME_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(target).pipe(response);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
