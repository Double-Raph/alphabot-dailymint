// scraper.mjs — version simple
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20);

const todayUTC = new Date();
const Y = todayUTC.getUTCFullYear();
const M = String(todayUTC.getUTCMonth() + 1).padStart(2, "0");
const D = String(todayUTC.getUTCDate()).padStart(2, "0");
const stamp = `${Y}${M}${D}`;
const OUT_DIR = path.join(process.cwd(), "out");

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
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });

  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2000);

  // --- 1) Essaie "table" classique
  let headerTexts = [];
  let rows = await page.$$("table thead tr th");
  if (rows.length) {
    headerTexts = (await Promise.all(rows.map((th) => th.innerText()))).map((t) =>
      t.trim().toUpperCase()
    );
  } else {
    // --- 2) Sinon fallback role=grid
    rows = await page.$$("[role='columnheader']");
    if (rows.length) {
      headerTexts = (await Promise.all(rows.map((h) => h.innerText()))).map((t) =>
        t.trim().toUpperCase()
      );
    }
  }

  // indices des colonnes que l’on veut
  const want = ["NAME", "MINT", "CHAIN", "SUPPLY", "PUBLIC"];
  const idx = {};
  for (const k of want) idx[k] = headerTexts.findIndex((x) => x.startsWith(k));

  // Récupère les lignes (table d'abord, sinon grid)
  let rowLocs = await page.$$("table tbody tr");
  if (rowLocs.length === 0) {
    rowLocs = await page.$$("[role='rowgroup'] [role='row']");
  }
console.log("Rows detected:", rowLocs.length, "→ processing first", MAX_ROWS);

  const items = [];
  for (let i = 0; i < Math.min(rowLocs.length, MAX_ROWS); i++) {
    const row = rowLocs[i];

    // cellules (td, sinon role=cell)
    let cells = await row.$$("td");
    if (cells.length === 0) cells = await row.$$("[role='cell']");

    // lit les champs de la ligne
    const getCellText = async (k) => {
      const j = idx[k];
      if (j < 0 || j >= cells.length) return "";
      return (await cells[j].innerText()).trim();
    };

    const name = await getCellText("NAME");
    const mint = await getCellText("MINT");       // ex: 4H, 1D…
    const chain = await getCellText("CHAIN");     // ex: ETH, SOL…
    const supply = await getCellText("SUPPLY");   // ex: 1 111
    const pub = await getCellText("PUBLIC");      // ex: Free, 0.011, 0.03…

    // --- ouvre la fiche pour Twitter (click ligne)
    let twitterUrl = null;
    try {
      await row.click({ delay: 50 });
      await page.waitForTimeout(300);
      const tw = await page.locator("a[href*='x.com'], a[href*='twitter.com']").first();
      if (await tw.count()) {
        twitterUrl = await tw.getAttribute("href");
      }
      // ferme (Esc) ou clic vide
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.click(10, 10).catch(() => {});
      await page.waitForTimeout(150);
    } catch {}

    items.push({
      project: norm(name),
      mint_raw: norm(mint),
      chain: norm(chain).toLowerCase(),
      supply: supply ? digits(supply) : null,
      public_price_raw: norm(pub),     // on garde tel quel (Free, 0.011…)
      twitter_url: twitterUrl || null,
      twitter_handle: handleFromUrl(twitterUrl),
    });
  }

  // sortie JSON + CSV
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `alphabot_${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), "utf-8");

  const header = [
    "project",
    "mint_raw",
    "chain",
    "supply",
    "public_price_raw",
    "twitter_handle",
    "twitter_url",
  ];
  const csv = [
    header.join(","),
    ...items.map((x) =>
      header
        .map((k) => {
          const v = x[k] == null ? "" : String(x[k]).replace(/"/g, '""');
          return /[,"\n]/.test(v) ? `"${v}"` : v;
        })
        .join(",")
    ),
  ].join("\n");
  const csvPath = path.join(OUT_DIR, `alphabot_${stamp}.csv`);
  fs.writeFileSync(csvPath, csv, "utf-8");

  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${csvPath}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
