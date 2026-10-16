// Browser-level smoke test: landing -> auth sign-up -> assistant chat round-trip.
// Run: node scripts/browser-smoke.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:5173";
const SHOTS = "/tmp/jarvis-shots";
mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
let failed = false;

function assert(cond, label) {
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    failed = true;
    console.log(`  FAIL- ${label}`);
  }
}

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
});
page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));
page.on("requestfailed", (req) => {
  const url = req.url();
  if (!url.includes("favicon")) failedRequests.push(`${req.failure()?.errorText} ${url}`.slice(0, 300));
});

try {
  // ---------- 1. Landing ----------
  console.log("[1] landing page");
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 45_000 });
  const heroVisible = await page.locator("h1").first().isVisible();
  assert(heroVisible, "hero heading visible");
  const jarvisOnPage = (await page.locator("body").innerText()).includes("J.A.R.V.I.S.");
  assert(jarvisOnPage, "brand text present");
  await page.screenshot({ path: `${SHOTS}/1-landing.png`, fullPage: false });

  // ---------- 2. CTA navigates to /auth ----------
  console.log("[2] CTA -> /auth");
  const cta = page.locator('a[href^="/auth"]').first();
  assert((await cta.count()) > 0, "a CTA linking to /auth exists");
  await cta.click();
  await page.waitForURL("**/auth**", { timeout: 15_000 });
  assert(page.url().includes("/auth"), `navigated to ${new URL(page.url()).pathname}`);
  await page.locator("#email").waitFor({ state: "visible", timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/2-auth.png` });

  // ---------- 3. Sign up ----------
  console.log("[3] create account");
  await page.getByRole("button", { name: /create an account/i }).click();
  const email = `smoke-${Date.now()}@example.com`;
  await page.fill("#email", email);
  await page.fill("#password", "SmokeTest-2026!");
  await page.getByRole("button", { name: /^create account$/i }).click();
  await page.waitForURL("**/assistant**", { timeout: 30_000 });
  assert(page.url().includes("/assistant"), `redirected to ${new URL(page.url()).pathname}`);

  // ---------- 4. Dashboard loads ----------
  console.log("[4] assistant dashboard");
  const textarea = page.locator("form textarea").first();
  await textarea.waitFor({ state: "visible", timeout: 20_000 });
  assert(await textarea.isVisible(), "chat input visible");
  await page.screenshot({ path: `${SHOTS}/3-assistant.png` });

  // ---------- 5. Chat round-trip through the Convex action ----------
  console.log("[5] chat round-trip");
  await textarea.fill("Hello Jarvis, status report.");
  await textarea.press("Enter");
  // Either a real reply or the designed "LLM offline" fallback should render.
  const reply = page
    .locator("text=/offline|LLM_API_KEY|Core intelligence|Good to hear|status report/i")
    .first();
  await reply.waitFor({ timeout: 45_000 });
  const replyText = (await reply.innerText()).slice(0, 160);
  assert(replyText.length > 0, `assistant responded: "${replyText.replace(/\s+/g, " ")}"`);
  await page.screenshot({ path: `${SHOTS}/4-chat.png` });

  // ---------- 6. Reload keeps session (protected route) ----------
  console.log("[6] session persists across reload");
  await page.reload({ waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForURL("**/assistant**", { timeout: 15_000 });
  assert(page.url().includes("/assistant"), "still on /assistant after reload (not bounced to /auth)");
} catch (err) {
  failed = true;
  console.log(`  FAIL- ${err.message.split("\n")[0]}`);
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
}

console.log("\n--- diagnostics ---");
console.log(`console errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 8).forEach((e) => console.log(`  ce: ${e}`));
console.log(`page errors: ${pageErrors.length}`);
pageErrors.slice(0, 8).forEach((e) => console.log(`  pe: ${e}`));
console.log(`failed requests: ${failedRequests.length}`);
failedRequests.slice(0, 8).forEach((e) => console.log(`  rf: ${e}`));

await browser.close();
if (pageErrors.length > 0) failed = true;
console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
