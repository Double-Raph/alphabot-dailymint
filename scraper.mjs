// scraper.mjs — v3 (robuste + debug, 20 premières lignes)
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20); // limite
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

  // Bloque images/medias/fonts (plus rapide)
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) return route.abort();
    route.continue();
  });

  const page = await context.newPage();

  // Anti-bot simple
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Timeouts confort
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  // Interception des réponses API (si la page appelle /projects)
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

  // Scroll léger
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(300);
  }

  // DEBUG: snapshot
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `projects_${stamp}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, `projects_${stamp}.html`), html, "utf-8");
  } catch {}

  // ---- 1) Tentative via API interceptée
  if (apiDumps.length) {
    const items = [];
    for (const dump of apiDumps) {
      const data = Array.isArray(dump.json?.data)
        ? dump.json.data
        : Array.isArray(dump.json)
        ? dump.json
        : [];
      for (const it of data) {
        const name = norm(it.name ?? it.projectName ?? it.title ?? "");
        const chain = norm(it.chain ?? it.network ?? it.blockchain ?? "").toLowerCase();
        const twitterUrl = norm(
          it.twitter ?? it.x ?? it.twitterUrl ?? (it.socials ? it.socials.twitter : "") ?? ""
        );
        const supplyRaw = it.supply ?? it.publicSupply ?? it.maxSupply ?? null;
        const priceRaw = it.publicPrice ?? it.price ?? it.mintPrice ?? "";

        items.push({
          project: name,
          mint_raw: norm(it.mintNote ?? it.phase ?? ""), // peut être vide
          chain,
          supply: supplyRaw != null ? Number(String(supplyRaw).replace(/[^\d]/g, "")) : null,
          public_price_raw: String(priceRaw || ""),
          twitter_handle: handleFromUrl(twitterUrl),
          twitter_url: twitterUrl || "",
        });

        if (items.length >= MAX_ROWS) break;
      }
      if (items.length >= MAX_ROWS) break;
    }

    if (items.length) {
      dumpOutputs(items, apiDumps);
      await browser.close();
      return;
    }
  }

  // ---- 2) Fallback DOM: lecture des colonnes + clic pour Twitter
  let headerTexts = [];
  const headerTh = await page.$$("table thead tr th");
  if (headerTh.length) {
    headerTexts = (await Promise.all(headerTh.map((th) => th.innerText()))).map((t) =>
      t.trim().toUpperCase()
    );
  } else {
    const headers = await page.$$("[role='columnheader']");
    if (headers.length) {
      headerTexts = (await Promise.all(headers.map((h) => h.innerText()))).map((t) =>
        t.trim().toUpperCase()
      );
    }
  }

  const want = ["NAME", "MINT", "CHAIN", "SUPPLY", "PUBLIC"];
  const idx = {};
  for (const k of want) idx[k] = headerTexts.findIndex((x) => x.startsWith(k));

  let rowLocs = await page.$$("table tbody tr");
  if (rowLocs.length === 0) rowLocs = await page.$$("[role='rowgroup'] [role='row']");
  console.log("Rows detected:", rowLocs.length, "→ processing first", MAX_ROWS);

  const items = [];
  for (let i = 0; i < Math.min(rowLocs.length, MAX_ROWS); i++) {
    const row = rowLocs[i];

    let cells = await row.$$("td");
    if (cells.length === 0) cells = await row.$$("[role='cell']");

    const getCellText = asyn
