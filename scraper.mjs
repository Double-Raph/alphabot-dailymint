// scraper.mjs — v3 (simple, robuste, limité aux 20 premières lignes avec debug)
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20); // traite seulement les N premières lignes
const OUT_DIR = path.join(process.cwd(), "out");

const todayUTC = new Date();
const Y = todayUTC.getUTCFullYear();
const M = String(todayUTC.getUTCMonth() + 1).padStart(2, "0");
const D = String(todayUTC.getUTCDate()).padStart(2, "0");
const stamp = `${Y}${M}${D}`;

const norm = (s) => (s ?? "").toString().trim();
const digits = (s) => {
  const x = norm(s).replace(/[^\d]/g, "");
  return x ? Number(x) : null;
};
const handleFromUrl = (u) => {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (!/x\.com|twitter\.com/i.test(url.hostname)) return null;
    const h = url.pathname.replace(/\//g, "").trim();
    return h ? `@${h}` : null;
  } catch {
    return null;
  }
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 2000 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US",
  });

  // Bloque les ressources lourdes (garde CSS/JS)
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) return route.abort();
    route.continue();
  });

  const page = await context.newPage();

  // Anti-bot basique
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Timeouts confort
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  // Intercepte l'API (si la page charge /projects en JSON)
  const apiDumps = [];
  page.on("response", async (res) => {
    try {
      const u = res.url();
      if (u.includes("api.alphabot.app") && /projects/i.test(u) && res.ok()) {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("application/json")) {
          apiDumps.push({ url: u, json: await res.json() });
        }
      }
    } catch {}
  });

  // Navigation robuste
  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  } catch (e) {
    console.warn("goto domcontentloaded warning:", e.message);
  }
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForSelector("table, [role='rowgroup']", { timeout: 45000 });

  // Petit scroll pour forcer le rendu
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(300);
  }

  // DEBUG: snapshot page
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `projects_${stamp}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, `projects_${stamp}.html`), html, "utf-8");
  } catch {}

  // --- Si API capturée, tente extraction directe (limite MAX_ROWS)
  if (apiDumps.length) {
    const items = [];
    for (const dump of apiDumps) {
      const arr = Array.isArray(dump.json?.data)
        ? dump.json.data
        : Array.isArray(dump.json)
        ? dump.json
        : [];
      for (const it of arr) {
        const name = norm(it.name || it.proj
