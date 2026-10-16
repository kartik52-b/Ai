// Visual/style audit: verifies Tailwind tokens actually apply, layout doesn't
// overflow horizontally, and key landing sections exist. Run: node scripts/style-audit.mjs
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:5173";
let failed = false;
const assert = (cond, label) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}- ${label}`);
  if (!cond) failed = true;
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });

// ---------- Desktop landing ----------
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await desktop.newPage();
await page.goto(BASE, { waitUntil: "networkidle", timeout: 45_000 });

const styles = await page.evaluate(() => {
  const body = getComputedStyle(document.body);
  const h1 = document.querySelector("h1");
  return {
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    bodyFont: body.fontFamily,
    h1Font: h1 ? getComputedStyle(h1).fontFamily : "",
    h1Size: h1 ? getComputedStyle(h1).fontSize : "",
    sectionCount: document.querySelectorAll("section").length,
    linkCount: document.querySelectorAll("a").length,
    styledSheets: [...document.styleSheets].length,
    overflowing: document.documentElement.scrollWidth > window.innerWidth + 1,
    title: document.title,
  };
});

const [r, g, b] = styles.bodyBg.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
assert(r < 60 && g < 60 && b < 80, `dark background applied (${styles.bodyBg})`);
assert(styles.bodyColor !== "rgb(0, 0, 0)", `non-default text color (${styles.bodyColor})`);
assert(styles.styledSheets > 0, `stylesheets loaded (${styles.styledSheets})`);
assert(!styles.overflowing, "no horizontal overflow at 1440px");
assert(styles.sectionCount >= 3, `landing has >=3 sections (${styles.sectionCount})`);
assert(/J\.A\.R\.V\.I\.S/.test(styles.title), `title branded (${styles.title})`);
assert(parseFloat(styles.h1Size) >= 30, `hero h1 is display-sized (${styles.h1Size})`);

// Buttons/interactive hover sanity: primary CTA exists and is styled
const cta = await page.locator('a[href^="/auth"]').first().evaluate((el) => {
  const s = getComputedStyle(el);
  return { display: s.display, borderRadius: s.borderRadius, cursor: s.cursor };
});
assert(cta.display !== "inline", `CTA is laid out (${cta.display})`);
assert(cta.cursor === "pointer", `CTA is clickable-looking (cursor: ${cta.cursor})`);

// ---------- Mobile landing (iPhone-ish) ----------
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: "networkidle", timeout: 45_000 });
const mobileAudit = await mp.evaluate(() => {
  const overflowing = [...document.querySelectorAll("*")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.right <= window.innerWidth + 2) return false;
      // Ignore elements contained by any clipping/scroll ancestor (decorative
      // glows are intentionally larger than the viewport and are clipped).
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (/(hidden|clip|auto|scroll)/.test(o.overflow + o.overflowX + o.overflowY)) {
          return false;
        }
      }
      return true;
    })
    .slice(0, 5)
    .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`);
  const h1 = document.querySelector("h1");
  return {
    docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    offenders: overflowing,
    h1Visible: !!h1 && h1.getBoundingClientRect().height > 0,
    navToggleOrStacked: !!document.querySelector("button, [aria-label]"),
  };
});
assert(!mobileAudit.docOverflow, "no page-level horizontal scroll at 390px");
assert(mobileAudit.offenders.length === 0, `no elements spill past viewport (${mobileAudit.offenders.join(" | ") || "none"})`);
assert(mobileAudit.h1Visible, "hero visible on mobile");
await mp.screenshot({ path: "/tmp/jarvis-shots/5-mobile-landing.png", fullPage: false });

// ---------- Assistant page on mobile (after we know auth works from browser-smoke) ----------
await browser.close();
console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
