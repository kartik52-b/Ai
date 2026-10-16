/**
 * A stand-in for the Python service used by the Electron tests.
 *
 * It speaks the same protocol: prints a JSON ready line on stdout, requires the
 * JARVIS_TOKEN header, and exits on /v1/shutdown.
 *
 *   node fake_service.mjs [--busy] [--exit-after <ms>] [--no-ready]
 */

import { createServer } from "node:http";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : Number(argv[index + 1]);
};

if (flag("--busy")) {
  console.log(JSON.stringify({ event: "error", error: "already_running", detail: "another service is running" }));
  process.exit(3);
}

const token = process.env.JARVIS_TOKEN ?? "";
let stopping = false;

const server = createServer((request, response) => {
  if (request.headers["x-jarvis-token"] !== token) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "bad token" } }));
    return;
  }
  const send = (payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  };
  if (request.url === "/v1/shutdown") {
    send({ ok: true, stopping: true });
    stopping = true;
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (request.url === "/v1/status") {
    send({ ok: true, service: "fake-local", pid: process.pid, port: server.address().port });
    return;
  }
  if (request.url?.startsWith("/v1/events")) {
    send({ ok: true, cursor: 3, events: [{ seq: 3, type: "wake" }] });
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "no route" } }));
});

server.listen(0, "127.0.0.1", () => {
  if (!flag("--no-ready")) {
    console.log(
      JSON.stringify({
        event: "ready",
        protocol: 1,
        service: "jarvis-local",
        host: "127.0.0.1",
        port: server.address().port,
        pid: process.pid,
      }),
    );
  }
});

const exitAfter = value("--exit-after");
if (exitAfter !== null && Number.isFinite(exitAfter)) {
  setTimeout(() => {
    if (!stopping) process.exit(7);
  }, exitAfter).unref?.();
}
