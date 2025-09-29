// scraper.mjs — /projects (v4.2 stable)
// - Va sur https://www.alphabot.app/projects
// - Lit le tableau (NAME/MINT/CHAIN/SUPPLY/PUBLIC)
// - Récupère le Twitter via hover sur NAME (fallback: clic + fermeture modale)
// - Heures : lit tooltip/attributs de la cellule MINT ; fallback "+H"
// - Filtre sur "aujourd'hui" dans DAY_TZ ; ignore "H ago" et formats non-H (ex: "2D")
// - Ajoute event_unix_utc arrondi à l'heure la plus proche
// - Sorties: out/alphabot_YYYYMMDD.json + .csv

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = process.env.PROJECTS_URL || "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20);
const OUT_DIR = path.join(process.cwd(), "out");
const DAY_TZ = process.env.DAY_TZ || "Europe/Paris";

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

function logDebug(msg) {
  fs.appendFileSync("debug.log", `[${new Date().toISOString()}] ${msg}\n`);
}

function startOfDayUnixInTZ(date, tz = DAY_TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return Math.floor(Date.UTC(
    Number(parts.year), Number(parts.month)-1, Number(parts.day), 0, 0, 0
  ) / 1000);
}

function roundUnixToNearestHour(unix) {
  const d = new Date(unix * 1000);
  const min = d.getUTCMinutes();
  if (min <= 30) d.setUTCMinutes(0,0,0);
  else { d.setUTCMinutes(0,0,0); d.setUTCHours(d.getUTCHours()+1); }
  return Math.floor(d.getTime() / 1000);
}
const hhmmUTC = (unix) => new Date(unix * 1000).toISOString().slice(11,16);

// parse texte tooltip → epoch
function parseDateTextToUnix(text) {
  if (!text) return null;
  const t = text.trim();
  // ISO-like ou "Sep 15 2025 16:30 UTC"
  const iso = Date.parse(t);
  if (!Number.isNaN(iso)) return Math.floor(iso/1000);

  // "HH:MM UTC" (jour courant en UTC)
  let m = t.match(/(\d{1,2}):(\d{2})\s*UTC/i);
  if (m) {
    const now = new Date();
    return Math.floor(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      Number(m[1]), Number(m[2]), 0
    ) / 1000);
  }

  // "DD/MM/YYYY HH:MM" (interprété en UTC)
  m = t.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3].length===2 ? "20"+m[3] : m[3]);
    const HH = Number(m[4]), MM = Number(m[5]);
    return Math.floor(Date.UTC(yyyy, mm-1, dd, HH, MM, 0) / 1000);
  }
  return null;
}

async function readAbsoluteMintUnixFromCell(page, cell) {
  // attributs sur la cellule / enfant
  const attrs = ["title","aria-label","data-title","data-tooltip","data-original-title","data-tippy-content"];
  for (const a of attrs) {
    const v = await cell.getAttribute(a);
    const u = parseDateTextToUnix(v);
    if (u) return u;
  }
  const child = await cell.$("*");
  if (child) {
    for (const a of attrs) {
      const v = await child.getAttribute(a);
      const u = parseDateTextToUnix(v);
      if (u) return u;
    }
  }

  // hover → tooltip
  try {
    await cell.hover({ force: true });
    await page.waitForTimeout(450);
    const tip = page.locator(
      "[role='tooltip'], [data-radix-popper-content-wrapper], [class*='tooltip'], [class*='popover'], [class*='balloon']"
    ).last();
    if (await tip.count()) {
      const txt = (await tip.innerText()).trim();
      const u = parseDateTextToUnix(txt);
      if (u) return u;
    }
  } catch {}
  return null;
}

const nowUTC = new Date();
const stamp = `${nowUTC.getUTCFullYear()}${String(nowUTC.getUTCMonth()+1).padStart(2,"0")}${String(nowUTC.getUTCDate()).padStart(2,"0")}`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 1700 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  page.on("console", m => logDebug(`[console] ${m.type()} ${m.text()}`));
  page.on("pageerror", e => logDebug(`[pageerror] ${e.message}`));

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{});
    await page.waitForSelector("table, [role='rowgroup']", { timeout: 45000 });

    // headers
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

    // rows
    let rows = await page.$$("table tbody tr");
    if (rows.length === 0) rows = await page.$$("[role='rowgroup'] [role='row']");
    const take = Math.min(rows.length, MAX_ROWS);
    logDebug(`Rows detected: ${rows.length} → processing first ${take}`);

    const items = [];
    const now = new Date();
    const scraped_at_unix = Math.floor(now.getTime() / 1000);
    const dayStart = startOfDayUnixInTZ(now, DAY_TZ);
    const dayEnd = dayStart + 86400;

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

      // Twitter via hover (fallback click)
      let twitterUrl = null;
      try {
        const jName = idx["NAME"];
        if (jName >= 0 && jName < cells.length) {
          const nameCell = cells[jName];
          const anchor = await nameCell.$("a, [role='link'], span");
          if (anchor) {
            await anchor.scrollIntoViewIfNeeded?.().catch(()=>{});
            const box = await anchor.boundingBox();
            if (box) await page.mouse.move(box.x + box.width/2, box.y + Math.min(10, box.height/2));
            await anchor.hover({ force: true });
            await page.waitForTimeout(600);

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
              if (href && !/alphabotapp/i.test(href) && !/intent|share/i.test(href)) { twitterUrl = href; break; }
            }
          }
        }
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
            if (href && !/alphabotapp/i.test(href) && !/intent|share/i.test(href)) { twitterUrl = href; break; }
          }
          await page.keyboard.press("Escape").catch(()=>{});
          await page.mouse.click(10, 10).catch(()=>{});
          await page.waitForTimeout(150);
        }
      } catch {}

      // Heures: tooltip MINT → unix, sinon "+H", ignorer "H ago" / "2D"
      let event_unix_utc = null;
      try {
        const jMint = idx["MINT"];
        if (jMint >= 0 && jMint < cells.length) {
          const mintCell = cells[jMint];
          event_unix_utc = await readAbsoluteMintUnixFromCell(page, mintCell);
        }
      } catch {}

      if (!event_unix_utc) {
        const ahead = (mint || "").match(/^\s*(\d+)\s*H(?!\s*ago)\b/i);
        const ago   = (mint || "").match(/^\s*(\d+)\s*H\s*ago\b/i);
        if (ahead) {
          event_unix_utc = scraped_at_unix + Number(ahead[1]) * 3600;
        } else if (ago) {
          continue; // déjà passé
        } else {
          continue; // formats non gérés (ex: "2D")
        }
      }

      // Garde uniquement les mints d'aujourd'hui (DAY_TZ)
      if (!(event_unix_utc >= dayStart && event_unix_utc < dayEnd)) continue;

      const event_unix_utc_rounded = roundUnixToNearestHour(event_unix_utc);
      const event_utc_hhmm = hhmmUTC(event_unix_utc);
      const event_utc_hhmm_rounded = hhmmUTC(event_unix_utc_rounded);

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

    // save
    const jsonPath = path.join(OUT_DIR, `alphabot_${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), "utf-8");

    const header = [
      "project","mint_raw","chain","supply","public_price_raw","twitter_handle","twitter_url",
      "scraped_at_unix","event_unix_utc","event_unix_utc_rounded","event_utc_hhmm","event_utc_hhmm_rounded"
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
  } catch (e) {
    logDebug(`[fatal] ${e.stack || e.message}`);
    try { await page.screenshot({ path: `playwright-fatal-${Date.now()}.png`, fullPage: true }); } catch {}
    throw e;
  } finally {
    await browser.close().catch(()=>{});
  }
})();
