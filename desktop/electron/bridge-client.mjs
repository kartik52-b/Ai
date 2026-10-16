/**
 * The only place that talks to the local service.
 *
 * Requests go to http://127.0.0.1:<port> with the per-session token header.
 * Error objects carry a stable `code` so the UI can react (offline, timeout,
 * unauthorised, malformed) without ever seeing a stack trace.
 */

export class ServiceError extends Error {
  constructor(code, message, { status = 0 } = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
  }
}

export function serviceUrl(port, requestPath) {
  const clean = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  return `http://127.0.0.1:${port}${clean}`;
}

export async function serviceRequest({
  port,
  token,
  path: requestPath,
  method = "GET",
  body,
  timeoutMs = 15_000,
}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ServiceError("service_unavailable", "the local service is not running");
  }
  const headers = { Accept: "application/json" };
  if (token) headers["X-Jarvis-Token"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(serviceUrl(port, requestPath), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ServiceError("service_timeout", "the local service did not answer in time");
    }
    throw new ServiceError("service_unavailable", "the local service is not reachable");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : `the local service rejected the request (HTTP ${response.status})`;
    const code =
      payload && payload.error && typeof payload.error.code === "string"
        ? payload.error.code
        : "service_error";
    throw new ServiceError(code, message, { status: response.status });
  }
  return payload ?? {};
}
