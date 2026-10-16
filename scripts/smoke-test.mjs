import { ConvexHttpClient } from "convex/browser";

// End-to-end smoke test against the local Convex deployment:
// node scripts/smoke-test.mjs
const url = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const client = new ConvexHttpClient(url);

function fail(message) {
  console.error("FAIL:", message);
  process.exit(1);
}

// 1. Node action + env read (LLM configuration status)
const status = await client.action("assistant:status", {});
console.log("status        :", JSON.stringify(status));
if (typeof status.llmConfigured !== "boolean") fail("assistant:status returned unexpected shape");

// 2. Password auth (sign in, or sign up on first run)
const params = {
  provider: "password",
  params: { email: "smoke@example.com", password: "password123" },
};
let auth;
try {
  auth = await client.action("auth:signIn", { ...params, params: { ...params.params, flow: "signIn" } });
} catch {
  auth = await client.action("auth:signIn", { ...params, params: { ...params.params, flow: "signUp" } });
}
if (!auth?.tokens?.token) fail("auth:signIn did not return a session token");
client.setAuth(auth.tokens.token);
console.log("auth          : session token issued");

// 3. Assistant chat action (missing-key fallback or real model reply)
const reply = await client.action("assistant:chat", {
  userText: "Hello Jarvis, this is a smoke test. Reply with one short sentence.",
});
if (!reply?.text) fail("assistant:chat returned no text");
console.log("chat reply    :", reply.text.slice(0, 160));

// 4. Data round-trip: the conversation must be persisted
const messages = await client.query("messages:list", {});
if (messages.length < 2) fail(`expected >=2 messages, got ${messages.length}`);
console.log("messages      :", messages.length, `(${messages.map((m) => m.role).join(", ")})`);

// 5. Reminders and notes queries respond for this user
const reminders = await client.query("reminders:listActive", {});
const notes = await client.query("notes:list", {});
console.log("reminders     :", reminders.length, "| notes:", notes.length);

console.log("SMOKE OK");
