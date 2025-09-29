// scraper.mjs — simple & robuste: /projects, sortie au niveau racine, pas de filtre par défaut
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20);
const ONLY_TODAY = String(process.env.ONLY_TODAY || "false").toLowerCase() === "true";
const DAY_TZ = process.env.DAY_TZ || "Europe/Paris";

// === Helpers
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
const startOfDayUnixInTZ = (date, tz) => {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(date).reduce((a,p)=> (p.type!=="literal" && (a[p.type]=p.value), a), {});
  return Math.floor(Date.UTC(+parts.year, +parts.month-1, +parts.day, 0, 0, 0)/1000);
};
const roundToNearestHalfHourUnix = (unix) => {
  const ms = unix * 1000;
  const d = new Date(ms);
  const m = d.getUTCMinutes();
  if (m <= 15) d.setUTCMinutes(0,0,0);
  else if (m <= 45) d.setUTCMinutes(30,0,0);
  else { d.setUTCHours(d.getUTCHours()+1,0,0,0); }
  return Math.floor(d.getTime()/1000);
};

const nowUTC = new Date();
const stamp = `${nowUTC.getUTCFullYear()}${String(nowUTC.getUTCMonth()+1).padStart(2,"0")}${String(nowUTC.getUTCDate()).padStart(2,"0")}`;
const OUT_DIR = process.cwd(); // === racine du repo

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 1600 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(60000);

  // Aller sur /projects
  await page.goto(URL, { waitUntil: "domcontentloaded" }).catch(()=>{});
  await page.waitForLoadState("networkidle").catch(()=>{});
  await page.waitForSelector("table, [role='rowgroup']", { timeout: 45000 });

  // Lire l’en-tête pour repérer les colonnes
  const headerTexts = await page.evaluate(() => {
    const t = [];
    document.querySelectorAll("table thead tr th").forEach(th => t.push((th.textContent||"").trim().toUpperCase()));
    if (!t.length) document.querySelectorAll("[role='columnheader']").forEach(h => t.push((h.textContent||"").trim().toUpperCase()));
    return t;
  });
  const WANT = ["NAME","MINT","CHAIN","SUPPLY","PUBLIC"];
  const idx = {};
  for (const k of WANT) idx[k] = headerTexts.findIndex(x => x.startsWith(k));

  // Lignes
  let rows = await page.$$("table tbody tr");
  if (!rows.length) rows = await page.$$("[role='rowgroup'] [role='row']");
  const take = Math.min(rows.length, MAX_ROWS);
  console.log(`[scraper] Rows found: ${rows.length} / processing: ${take}`);

  const items = [];
  const scraped_at_unix = Math.floor(Date.now()/1000);

  for (let i=0; i<take; i++) {
    const row = rows[i];
    let cells = await row.$$("td");
    if (!cells.length) cells = await row.$$("[role='cell']");

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

    // Twitter (hover rapide + fallback click dans la ligne)
    let twitterUrl = null;
    try {
      const jName = idx["NAME"];
      if (jName >= 0 && jName < cells.length) {
        const nameCell = cells[jName];
        const anchor = await nameCell.$("a, [role='link'], span");
        if (anchor) {
          await anchor.hover({ force:true }).catch(()=>{});
          await page.waitForTimeout(300);
          const links = await page.$$(
            "[role='dialog'] a[href*='x.com'], [role='dialog'] a[href*='twitter.com'], " +
            "[role='tooltip'] a[href*='x.com'], [role='tooltip'] a[href*='twitter.com'], " +
            "a[href*='x.com'], a[href*='twitter.com']"
          );
          for (const a of links) {
            const href = await a.getAttribute("href");
            if (href && !/alphabotapp/i.test(href) && !/intent|share/i.test(href)) { twitterUrl = href; break; }
          }
        }
      }
      if (!twitterUrl) {
        await row.click({ delay: 50 }).catch(()=>{});
        await page.waitForTimeout(300);
        const links = await page.$$(
          "[role='dialog'] a[href*='x.com'], [role='dialog'] a[href*='twitter.com'], " +
          "[class*='modal'] a[href*='x.com'], [class*='modal'] a[href*='twitter.com'], " +
          "a[href*='x.com'], a[href*='twitter.com']"
        );
        for (const a of links) {
          const href = await a.getAttribute("href");
          if (href && !/alphabotapp/i.test(href) && !/intent|share/i.test(href)) { twitterUrl = href; break; }
        }
        await page.keyboard.press("Escape").catch(()=>{});
        await page.mouse.click(10,10).catch(()=>{});
      }
    } catch {}

    // Temps: on traite les formats “nH” (futurs), on ignore “H ago” & “D”
    let event_unix_utc = null;
    const ahead = (mint || "").match(/^\s*(\d+)\s*H(?!\s*ago)\b/i);
    const ago   = (mint || "").match(/^\s*(\d+)\s*H\s*ago\b/i);
    if (ahead) event_unix_utc = scraped_at_unix + Number(ahead[1]) * 3600;
    else if (ago) continue;
    else continue;

    // Filtre optionnel “aujourd’hui” (désactivé par défaut)
    if (ONLY_TODAY) {
      const dayStart = startOfDayUnixInTZ(new Date(), DAY_TZ);
      const dayEnd = dayStart + 86400;
      if (!(event_unix_utc >= dayStart && event_unix_utc < dayEnd)) continue;
    }

    const event_unix_utc_rounded = roundToNearestHalfHourUnix(event_unix_utc);
    const event_utc_hhmm = new Date(event_unix_utc * 1000).toISOString().slice(11, 16);
    const event_utc_hhmm_rounded = new Date(event_unix_utc_rounded * 1000).toISOString().slice(11, 16);

    items.push({
      project: norm(name),
      mint_raw: norm(mint),
      chain: norm(chain).toLowerCase(),
      supply: supply ? digits(supply) : null,
      public_price_raw: norm(pub),
      twitter_handle: handleFromUrl(twitterUrl),
      twitter_url: twitterUrl || "",
      scraped_at_unix,
      event_unix_utc,
      event_unix_utc_rounded,
      event_utc_hhmm,
      event_utc_hhmm_rounded
    });
  }

  console.log(`[scraper] Collected items: ${items.length}`);

  // Sauvegarde (toujours) en racine
  const jsonPath = path.join(OUT_DIR, `alphabot_${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), "utf-8");

  const header = [
    "project","mint_raw","chain","supply","public_price_raw",
    "twitter_handle","twitter_url","scraped_at_unix",
    "event_unix_utc","event_unix_utc_rounded","event_utc_hhmm","event_utc_hhmm_rounded"
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

  console.log(`[scraper] Saved: ${path.basename(jsonPath)}, ${path.basename(csvPath)}`);
  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
