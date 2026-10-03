// Screenshots of every /dev/states state at every size, light and dark, plus
// automatic checks for layout problems. Needs the dev server running (npm run dev).
//
//   node scripts/screenshots.mjs                    all states, all sizes
//   node scripts/screenshots.mjs --states solving,penalty --sizes 360x740
//
// Output: client/screenshots/<state>/<size>-<theme>.png, a contact sheet per
// state in client/screenshots/_sheets/, and client/screenshots/report.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const OUT = path.resolve(import.meta.dirname, "../screenshots");
const ALL_SIZES = ["360x740", "390x844", "844x390", "768x1024", "1024x768", "1366x768", "1920x1080"];
const THEMES = ["light", "dark"];

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1].split(",") : null;
};

const browser = await chromium.launch();

// The list of states comes from the /dev/states index page.
const indexPage = await browser.newPage();
await indexPage.goto(`${BASE}/dev/states`);
await indexPage.waitForSelector("a[href*='state=']");
const allStates = await indexPage.$$eval("a[href*='state=']:not([href*='theme'])", (links) =>
  links.map((a) => new URL(a.href).searchParams.get("state")),
);
await indexPage.close();

const states = arg("states") ?? allStates;
const sizes = arg("sizes") ?? ALL_SIZES;
const report = {};

/** Runs inside the page: returns a list of problems. */
function checkPage() {
  const issues = [];
  const vw = innerWidth;
  const vh = innerHeight;
  const describe = (el) => {
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} "${text}"`;
  };
  // Scrolled out of a scrolling panel (e.g. host tools below the standings): not drawn.
  const scrolledAway = (el, r) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if (o !== "auto" && o !== "scroll") continue;
      const b = p.getBoundingClientRect();
      if (r.top >= b.bottom - 1 || r.bottom <= b.top + 1) return true;
    }
    return false;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" &&
      r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && !el.closest("[inert]") &&
      !(el.closest("details:not([open])") && !el.closest("summary")) && !scrolledAway(el, r)
    );
  };

  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1) issues.push(`horizontal page scroll (${doc.scrollWidth} > ${vw})`);

  // Tap targets: at least 44 x 44. Controls in the dense race layout (header,
  // standings rows, chat input, tabs) are marked data-dense and need 28 px height.
  for (const el of document.querySelectorAll("button, a[href], input, select, summary")) {
    if (!visible(el)) continue;
    // Partly scrolled out of a sideways strip (the event picker): its real size is still 44 px.
    const strip = el.closest(".event-strip");
    if (strip) {
      const [t, b] = [el.getBoundingClientRect(), strip.getBoundingClientRect()];
      if (t.right > b.right || t.left < b.left) continue;
    }
    const r = el.getBoundingClientRect();
    if (el.hasAttribute("data-dense")) {
      if (r.height < 27.5 || r.width < 27.5) issues.push(`small dense target ${Math.round(r.width)}x${Math.round(r.height)}: ${describe(el)}`);
      continue;
    }
    if (r.width < 43.5 || r.height < 43.5) issues.push(`small tap target ${Math.round(r.width)}x${Math.round(r.height)}: ${describe(el)}`);
  }

  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    // Content cut off without an ellipsis.
    if (
      el.scrollWidth > el.clientWidth + 1 &&
      (cs.overflowX === "hidden" || cs.overflowX === "clip") &&
      cs.textOverflow !== "ellipsis" &&
      !el.closest(".preview") && !el.classList.contains("sr-only")
    ) {
      issues.push(`clipped horizontally: ${describe(el)}`);
    }
    const r = el.getBoundingClientRect();
    // Items inside a sideways-scrolling strip (tables, the warm-up puzzle row) may go past the edge.
    let inScroller = false;
    for (let p = el.parentElement; p && !inScroller; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      inScroller = o === "auto" || o === "scroll";
    }
    if (r.right > vw + 1 && !inScroller && !el.closest(".sheet")) issues.push(`past the right edge: ${describe(el)}`);
  }

  // The stage (scramble + timer) must fit its box: nothing cut off at the bottom.
  for (const el of document.querySelectorAll(".stage, .timer-zone")) {
    if (el.scrollHeight > el.clientHeight + 1) issues.push(`content cut off vertically in ${describe(el)} (${el.scrollHeight} > ${el.clientHeight})`);
  }

  // Timer digits, megaminx lines and the big code must fit inside their container.
  for (const el of document.querySelectorAll(".timer-digits, .scramble-text .line, .big-code, .scramble-text")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const p = el.parentElement.getBoundingClientRect();
    if (r.left < p.left - 1 || r.right > p.right + 1 || el.scrollWidth > el.clientWidth + 1) issues.push(`does not fit: ${describe(el)}`);
  }

  // On desktop the whole standings table fits (ao5 from 1024 px, ao12 from 1280 px wide).
  const table = document.querySelector(".side .table-scroll");
  const ao12 = document.querySelector(".room.format-ao12");
  if (table && innerHeight > 500 && innerWidth >= (ao12 ? 1280 : 1024) && table.scrollWidth > table.clientWidth + 1) {
    issues.push(`standings table scrolls on desktop (${table.scrollWidth} > ${table.clientWidth})`);
  }

  // Overlapping controls / key elements (overlays like an open sheet or the menu are expected).
  const overlay = document.querySelector(".sheet[data-open='true'], .menu");
  // Tiles scrolled out of the sideways event strip aren't drawn, so they can't overlap anything.
  const outOfStrip = (el) => {
    const strip = el.closest(".event-strip");
    if (!strip) return false;
    const r = el.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    return r.left < s.left - 1 || r.right > s.right + 1;
  };
  const keys = [...document.querySelectorAll("button, input, .timer-digits, .scramble-text, .preview, h1, h2, .big-code, .waiting-line, .status-line")].filter(
    (el) => visible(el) && !el.closest(".start-bar") && !outOfStrip(el),
  );
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i];
      const b = keys[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (overlay && (overlay.contains(a) !== overlay.contains(b))) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (overlapX > 1 && overlapY > 1) issues.push(`overlap: ${describe(a)} / ${describe(b)}`);
    }
  }
  return issues;
}

/** Scrolled to the bottom: the fixed Start / Create bar must not hide the last content. */
function checkBottomBar() {
  const bar = document.querySelector(".start-bar");
  if (!bar) return [];
  window.scrollTo(0, document.documentElement.scrollHeight);
  const top = bar.getBoundingClientRect().top;
  const issues = [];
  for (const el of document.querySelectorAll("main button, main input, main li, main h2")) {
    if (bar.contains(el)) continue;
    // Inside a collapsed section: not drawn, so it can't be hidden by the bar.
    if (el.closest("details:not([open])") && !el.closest("summary")) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > top + 1 && r.top < innerHeight) issues.push(`hidden behind the bottom bar: ${el.tagName} "${el.textContent.trim().slice(0, 30)}"`);
  }
  window.scrollTo(0, 0);
  return issues;
}

let total = 0;
for (const size of sizes) {
  const [width, height] = size.split("x").map(Number);
  const touch = width < 768 || height <= 500;
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      hasTouch: touch,
      isMobile: touch,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    for (const state of states) {
      await page.goto(`${BASE}/dev/states?state=${state}&theme=${theme}`, { waitUntil: "load" });
      // Wait until the app has really rendered (a blank page must never pass the checks).
      const rendered = await page
        .waitForSelector("#root main, #root .room", { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      if (await page.$(".preview")) {
        await page.waitForSelector(".preview twisty-player", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(700);
      }
      const issues = rendered
        ? [...(await page.evaluate(checkPage)), ...(await page.evaluate(checkBottomBar))]
        : ["NOTHING RENDERED"];
      const dir = path.join(OUT, state);
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `${size}-${theme}.png`) });
      report[state] ??= {};
      report[state][`${size}-${theme}`] = issues;
      total += issues.length;
      if (issues.length) console.log(`${state} ${size} ${theme}:\n  - ${[...new Set(issues)].join("\n  - ")}`);
    }
    await context.close();
  }
}

// Contact sheets: all sizes of one state on a single image.
mkdirSync(path.join(OUT, "_sheets"), { recursive: true });
const sheetPage = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
for (const state of states) {
  const cells = THEMES.flatMap((theme) =>
    sizes.map((size) => {
      const [w, h] = size.split("x").map(Number);
      const scale = h > w ? 520 / h : 440 / w;
      const data = readFileSync(path.join(OUT, state, `${size}-${theme}.png`)).toString("base64");
      return `<figure><img src="data:image/png;base64,${data}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"><figcaption>${size} ${theme}</figcaption></figure>`;
    }),
  );
  await sheetPage.setContent(
    `<style>body{margin:8px;font:12px sans-serif;background:#888;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}figure{margin:0}img{display:block;outline:1px solid #000}</style><h3 style="width:100%;margin:0">${state}</h3>${cells.join("")}`,
  );
  await sheetPage.waitForTimeout(100);
  await sheetPage.screenshot({ path: path.join(OUT, "_sheets", `${state}.png`), fullPage: true });
}

writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
console.log(`\n${states.length} states x ${sizes.length} sizes x ${THEMES.length} themes: ${total} issue(s).`);
