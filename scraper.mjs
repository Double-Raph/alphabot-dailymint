// scraper.mjs — v2 robust + debug
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20); // traite seulement les 20 premières lignes
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
  // create out dir
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 2000 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US",
  });

  const page = await context.newPage();
  // masquer navigator.webdriver
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // ---- capture API réponses pour debug/extraction
  const apiDumps = [];
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (url.includes("api.alphabot.app") && /projects/i.test(url) && res.ok()) {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("application/json")) {
          const json = await res.json();
          apiDumps.push({ url, json });
        }
      }
    } catch {}
  });

  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });

  // cookies / consent si présent
  try {
    const consent = page.locator("button:has-text('Accept'), button:has-text('Agree'), button:has-text('OK')");
    if (await consent.count()) {
      await consent.first().click({ timeout: 3000 }).catch(() => {});
    }
  } catch {}

  // laisse le temps au JS
  await page.waitForTimeout(2500);

  // scroll léger pour forcer le rendu
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(400);
  }

  // --- DEBUG: screenshot + html
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `projects_${stamp}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, `projects_${stamp}.html`), html, "utf-8");
  } catch {}

  // --- si API capturée, tente d'utiliser directement
  if (apiDumps.length) {
    const items = [];
    for (const dump of apiDumps) {
      const arr = Array.isArray(dump.json?.data) ? dump.json.data : (Array.isArray(dump.json) ? dump.json : []);
      for (const it of arr) {
        const name = norm(it.name || it.projectName || it.title);
        const chain = norm((it.chain || it.network || it.blockchain || "")).toLowerCase();
        const twitterUrl = norm(it.twitter || it.x || it.twitterUrl || it?.socials?.twitter || "");
        const supply = it.supply || it.publicSupply || it.maxSupply || null;
        const priceRaw = it.publicPrice ?? it.price ?? it.mintPrice ?? null;
        items.push({
          project: name,
          mint_raw: norm(it.mintNote || it.phase || ""),   // champ éventuel, sinon vide
          chain,
          supply: supply != null ? Number(String(supply).replace(/[^\d]/g, "")) : null,
          public_price_raw: priceRaw != null ? String(priceRaw) : "",
          twitter_handle: handleFromUrl(twitterUrl),
          twitter_url: twitterUrl || "",
        });
        if (items.length >= MAX_ROWS) break;
      }
      if (items.length >= MAX_ROWS) break;
    }
    if (items.length) {
      const jsonPath = path.join(OUT_DIR, `alphabot_${stamp}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), "utf-8");
      const header = ["project","mint_raw","chain","supply","public_price_raw","twitter_handle","twitter_url"];
      const csv = [
        header.join(","),
        ...items.map(x => header.map(k => {
          const v = x[k] == null ? "" : String(x[k]).replace(/"/g, '""');
          return /[,"\n]/.test(v) ? `"${v}"` : v;
        }).join(","))
      ].join("\n");
      const csvPath = path.join(OUT_DIR, `alphabot_${stamp}.csv`);
      fs.writeFileSync(csvPath, csv, "utf-8");

      // dump les payloads API pour inspection
      apiDumps.forEach((d, i) => {
        fs.writeFileSync(path.join(OUT_DIR, `api_projects_${i+1}.json`), JSON.stringify(d.json, null, 2), "utf-8");
      });

      console.log(`(API) Saved: ${jsonPath}`);
      console.log(`(API) Saved: ${csvPath}`);
      await browser.close();
      return;
    }
  }

  // --- DOM fallback: détection table/grid
  const headerTh = await page.$$("table thead tr th");
  let headerTexts = [];
  if (headerTh.length) {
    headerTexts = (await Promise.all(headerTh.map(th => th.innerText()))).map(t => t.trim().toUpperCase());
  } else {
    const headers = await page.$$("[role='columnheader']");
    if (headers.length) {
      headerTexts = (await Promise.all(headers.map(h => h.innerText()))).map(t => t.trim().toUpperCase());
    }
  }

  const want = ["NAME", "MINT", "CHAIN", "SUPPLY", "PUBLIC"];
  const idx = {};
  for (const k of want) idx[k] = headerTexts.findIndex(x => x.startsWith(k));

  let rowLocs = await page.$$("table tbody tr");
  if (rowLocs.length === 0) {
    rowLocs = await page.$$("[role='rowgroup'] [role='row']");
  }
  console.log("Rows detected:", rowLocs.length, "→ processing first", MAX_ROWS);

  const items = [];
  for (let i = 0; i < Math.min(rowLocs.length, MAX_ROWS); i++) {
    const row = rowLocs[i];
    let cells = await row.$$("td");
    if (cells.length === 0) cells = await row.$$("[role='cell']");

    const getCellText = async (k) => {
      const j = idx[k];
      if (j < 0 || j >= cells.length) return "";
      return (await cells[j].innerText()).trim();
    };

    const name = await getCellText("NAME");
    const mint = await getCellText("MINT");
    const chain = await getCellText("CHAIN");
    const supply = await getCellText("SUPPLY");
    const pub = await getCellText("PUBLIC");

    // clique la ligne pour tenter de récupérer le lien Twitter
    let twitterUrl = null;
    try {
      await row.click({ delay: 60 });
      await page.waitForTimeout(350);
      const tw = await page.locator("a[href*='x.com'], a[href*='twitter.com']").first();
      if (await tw.count()) {
        twitterUrl = await tw.getAttribute("href");
      }
      // fermer modale/fiche
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.click(10, 10).catch(() => {});
      await page.waitForTimeout(150);
    } catch {}

    items.push({
      project: norm(name),
      mint_raw: norm(mint),
      chain: norm(chain).toLowerCase(),
      supply: supply ? digits(supply) : null,
      public_price_raw: norm(pub),
      twitter_handle: handleFromUrl(twitterUrl),
      twitter_url: twitterUrl || "",
    });
  }

  // sorties + dumps debug
  const jsonPath = path.join(OUT_DIR, `alphabot_${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), "utf-8");

  const header = ["project","mint_raw","chain","supply","public_price_raw","twitter_handle","twitter_url"];
  const csv = [
    header.join(","),
    ...items.map(x => header.map(k => {
      const v = x[k] == null ? "" : String(x[k]).replace(/"/g, '""');
      return /[,"\n]/.test(v) ? `"${v}"` : v;
    }).join(","))
  ].join("\n");
  const csvPath = path.join(OUT_DIR, `alphabot_${stamp}.csv`);
  fs.writeFileSync(csvPath, csv, "utf-8");

  // dump éventuels payloads API pour analyse
  apiDumps.forEach((d, i) => {
    fs.writeFileSync(path.join(OUT_DIR, `api_projects_${i+1}.json`), JSON.stringify(d.json, null, 2), "utf-8");
  });

  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${csvPath}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
