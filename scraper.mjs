// scraper.mjs — v4 (hover popover + fallback click, 20 premières lignes)
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20);
const OUT_DIR = path.join(process.cwd(), "out");

// Helpers
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
  } catch { return null; }
};
const todayUTC = new Date();
const stamp = `${todayUTC.getUTCFullYear()}${String(todayUTC.getUTCMonth()+1).padStart(2,"0")}${String(todayUTC.getUTCDate()).padStart(2,"0")}`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 1700 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  // 1) Navigation tolérante
  try { await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 }); }
  catch (e) { console.warn("goto warning:", e.message); }
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{});
  await page.waitForSelector("table, [role='rowgroup']", { timeout: 45000 });

  // 2) Lire l’en-tête pour trouver les colonnes
  const headerTexts = await page.evaluate(() => {
    const texts = [];
    document.querySelectorAll("table thead tr th").forEach(th => texts.push((th.textContent||"").trim().toUpperCase()));
    if (texts.length === 0) {
      document.querySelectorAll("[role='columnheader']").forEach(h => texts.push((h.textContent||"").trim().toUpperCase()));
    }
    return texts;
  });
  const WANT = ["NAME","MINT","CHAIN","SUPPLY","PUBLIC"];
  const idx = {};
  for (const k of WANT) idx[k] = headerTexts.findIndex(t => t.startsWith(k));

  // 3) Lignes
  let rows = await page.$$("table tbody tr");
  if (rows.length === 0) rows = await page.$$("[role='rowgroup'] [role='row']");
  const take = Math.min(rows.length, MAX_ROWS);
  console.log("Rows detected:", rows.length, "→ processing first", take);

  const items = [];

  for (let i = 0; i < take; i++) {
    const row = rows[i];

    let cells = await row.$$("td");
    if (cells.length === 0) cells = await row.$$("[role='cell']");

    const cellText = async (k) => {
      const j = idx[k];
      if (j < 0 || j >= cells.length) return "";
      return (await cells[j].innerText()).trim();
    };

    const name   = await cellText("NAME");
    const mint   = await cellText("MINT");
    const chain  = await cellText("CHAIN");
    const supply = await cellText("SUPPLY");
    const pub    = await cellText("PUBLIC");

    // 4) HOVER sur la cellule "NAME" pour ouvrir la popover, puis récupérer le lien X/Twitter
    let twitterUrl = null;
    try {
      const jName = idx["NAME"];
      if (jName >= 0 && jName < cells.length) {
        const nameCell = cells[jName];

        // ancre/élément cliquable dans la cellule
        const anchor = await nameCell.$("a, [role='link'], span");
        if (anchor) {
          // s'assure que c'est à l'écran
          await anchor.scrollIntoViewIfNeeded?.().catch(()=>{});
          const box = await anchor.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width/2, box.y + Math.min(10, box.height/2));
          }
          await anchor.hover({ force: true });
          await page.waitForTimeout(600); // laisse la popover apparaître

          // liens X/Twitter **dans** la popover/modale
          const candidateSelectors = [
            "[role='dialog'] a[href*='x.com']",
            "[role='dialog'] a[href*='twitter.com']",
            "[role='tooltip'] a[href*='x.com']",
            "[role='tooltip'] a[href*='twitter.com']",
            "[data-radix-popper-content-wrapper] a[href*='x.com']",
            "[data-radix-popper-content-wrapper] a[href*='twitter.com']",
            "[class*='popover'] a[href*='x.com']",
            "[class*='popover'] a[href*='twitter.com']",
            "[class*='tooltip'] a[href*='x.com']",
            "[class*='tooltip'] a[href*='twitter.com']",
            "[class*='card'] a[href*='x.com']",
            "[class*='card'] a[href*='twitter.com']"
          ];
          const links = await page.$$(candidateSelectors.join(","));
          for (const a of links) {
            const href = await a.getAttribute("href");
            if (href && !/alphabotapp/i.test(href) && !/intent|share/i.test(href)) {
              twitterUrl = href;
              break;
            }
          }
        }
      }

      // Fallback : clic sur la ligne si le hover n'a rien donné
      if (!twitterUrl) {
        await row.click({ delay: 60 });
        await page.waitForTimeout(600);
        const links = await page.$$(
          "[role='dialog'] a[href*='x.com'], [role='dialog'] a[href*='twitter.com'], " +
          "[class*='modal'] a[href*='x.com'], [class*='modal'] a[href*='twitter.com'], " +
          "a[href*='x.com'], a[href*='twitter.com']"
        );
        for (const a of links) {
          const href = await a.getAttribute("href");
          if (href && !/alphabotapp/i.test(href) && !/intent|share/i.test(href)) {
            twitterUrl = href;
            break;
          }
        }
        // ferme la modale/popover
        await page.keyboard.press("Escape").catch(()=>{});
        await page.mouse.click(10, 10).catch(()=>{});
        await page.waitForTimeout(150);
      }
    } catch {
      // ignore si pas de popover
    }

// --- timestamps & filtre "jour même" (UTC)
const now = new Date();
const scraped_at_unix = Math.floor(now.getTime() / 1000);

// "5H" à venir (PAS "H ago")
const ahead = (mint || "").match(/^\s*(\d+)\s*H(?!\s*ago)\b/i);
const ago   = (mint || "").match(/^\s*(\d+)\s*H\s*ago\b/i);

let event_unix_utc = null;
if (ahead) {
  event_unix_utc = scraped_at_unix + Number(ahead[1]) * 3600;
} else if (ago) {
  // déjà passé → on ignore cette ligne
  continue;
} else {
  // formats non “H” (ex: "2D", "-", etc.) → on ignore
  continue;
}

// garde uniquement les mints du jour (UTC)
const startUTC = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate(),
  0, 0, 0
) / 1000;
const endUTC = startUTC + 86400;
if (!(event_unix_utc >= startUTC && event_unix_utc < endUTC)) {
  continue;
}

// HH:MM en UTC (pour Twitter)
const event_utc_hhmm = new Date(event_unix_utc * 1000).toISOString().slice(11, 16);

// ---- push final
items.push({
  project: norm(name),
  mint_raw: norm(mint),              // "4H", "9H", etc.
  chain: norm(chain).toLowerCase(),  // eth, sol, base...
  supply: supply ? digits(supply) : null,
  public_price_raw: norm(pub),       // "Free", "0.011", etc.
  twitter_handle: handleFromUrl(twitterUrl),
  twitter_url: twitterUrl || "",
  scraped_at_unix,
  event_unix_utc,
  event_utc_hhmm
});
  }

  // 5) Sauvegarde JSON + CSV
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
  "scraped_at_unix",
  "event_unix_utc",
  "event_utc_hhmm"
];
  const csv = [
    header.join(","),
    ...items.map(x => header.map(k => {
      const v = x[k] == null ? "" : String(x[k]).replace(/"/g,'""');
      return /[,"\n]/.test(v) ? `"${v}"` : v;
    }).join(","))
  ].join("\n");
  const csvPath = path.join(OUT_DIR, `alphabot_${stamp}.csv`);
  fs.writeFileSync(csvPath, csv, "utf-8");

  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${csvPath}`);
  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
// --- EOF ---
