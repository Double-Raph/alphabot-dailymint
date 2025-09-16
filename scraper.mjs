// scraper.mjs — v4.5 (arrondi HH:00 : minutes ≤30 → down, >30 → up)
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20);
const OUT_DIR = path.join(process.cwd(), "out");

// ---------- Helpers ----------
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
function appendDebug(line) {
  fs.appendFileSync(path.join(OUT_DIR, "debug.log"), line + "\n");
}

// Arrondi : minutes ≤30 → down, sinon up (UTC, secondes=0)
function roundHourRule(unix) {
  const mins = Math.floor((unix % 3600) / 60);
  let base = unix - (unix % 3600); // top-of-hour
  if (mins > 30) base += 3600;
  return base;
}

// Parsing heures absolues depuis tooltip si besoin
function parseDateTextToUnix(text) {
  if (!text) return null;
  const t = text.trim();

  const iso = Date.parse(t);
  if (!Number.isNaN(iso)) return Math.floor(iso / 1000);

  let m = t.match(/(\d{1,2}):(\d{2})\s*UTC/i);
  if (m) {
    const now = new Date();
    return Math.floor(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      Number(m[1]), Number(m[2]), 0
    ) / 1000);
  }

  m = t.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const dd = Number(m[1]), mm = Number(m[2]),
          yyyy = Number(m[3].length === 2 ? "20" + m[3] : m[3]),
          HH = Number(m[4]), MM = Number(m[5]);
    return Math.floor(Date.UTC(yyyy, mm - 1, dd, HH, MM, 0) / 1000);
  }

  return null;
}

async function readAbsoluteMintUnixFromCell(page, cell) {
  const attrs = ["title","aria-label","data-title","data-tooltip","data-original-title","data-tippy-content"];
  for (const a of attrs) {
    const v = await cell.getAttribute(a);
    const unix = parseDateTextToUnix(v);
    if (unix) return unix;
  }
  const child = await cell.$("*");
  if (child) {
    for (const a of attrs) {
      const v = await child.getAttribute(a);
      const unix = parseDateTextToUnix(v);
      if (unix) return unix;
    }
  }

  try {
    await cell.hover({ force: true });
    await page.waitForTimeout(450);
    const tip = page
      .locator("[role='tooltip'], [data-radix-popper-content-wrapper], [class*='tooltip'], [class*='popover'], [class*='balloon']")
      .last();
    if (await tip.count()) {
      const txt = (await tip.innerText()).trim();
      const unix = parseDateTextToUnix(txt);
      if (unix) return unix;
    }
  } catch {}
  return null;
}

function startOfDayUnixInTZ(date, tz = "Europe/Paris") {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return Math.floor(Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0
  ) / 1000);
}

// ---------- Main ----------
const todayUTC = new Date();
const stamp = `${todayUTC.getUTCFullYear()}${String(todayUTC.getUTCMonth()+1).padStart(2,"0")}${String(todayUTC.getUTCDate()).padStart(2,"0")}`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "debug.log"), "", "utf-8");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1700 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  try { await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 }); }
  catch (e) { appendDebug("goto warning: " + e.message); }
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(()=>{});
  await page.waitForSelector("table, [role='rowgroup']", { timeout: 45000 });

  // Mapping colonnes (+ fallback)
  const headerTexts = await page.evaluate(() => {
    const texts = [];
    document.querySelectorAll("table thead tr th").forEach(th => texts.push((th.textContent||"").trim().toUpperCase()));
    if (texts.length === 0) {
      document.querySelectorAll("[role='columnheader']").forEach(h => texts.push((h.textContent||"").trim().toUpperCase()));
    }
    return texts;
  });
  appendDebug("HeaderTexts: " + JSON.stringify(headerTexts));

  const WANT = ["NAME","MINT","CHAIN","SUPPLY","PUBLIC"];
  const idx = {};
  for (const k of WANT) idx[k] = headerTexts.findIndex(t => t.startsWith(k));
  const fallbackIdx = { NAME:0, MINT:1, CHAIN:2, SUPPLY:3, PUBLIC:5 };
  for (const k of WANT) if (idx[k] === -1) { idx[k] = fallbackIdx[k]; appendDebug(`Fallback idx[${k}] -> ${idx[k]}`); }
  appendDebug("Final idx: " + JSON.stringify(idx));

  let rows = await page.$$(":is(table tbody tr, [role='rowgroup'] [role='row'])");
  appendDebug(`Rows detected: ${rows.length}`);
  if (rows.length === 0) {
    await page.screenshot({ path: path.join(OUT_DIR, "empty.png"), fullPage: true });
    fs.writeFileSync(path.join(OUT_DIR, "page.html"), await page.content(), "utf-8");
    throw new Error("No rows detected");
  }

  const take = Math.min(rows.length, MAX_ROWS);
  const items = [];

  for (let i = 0; i < take; i++) {
    const row = rows[i];
    const cells = await row.$$("td, [role='cell']");
    if (!cells || cells.length === 0) { appendDebug(`[row ${i}] no cells`); continue; }

    const readCell = async (j) => {
      if (j < 0 || j >= cells.length) return "";
      try { const t = await cells[j].innerText(); if (t && t.trim()) return t.trim(); } catch {}
      try { return (await cells[j].evaluate(n => n.textContent || "")).trim(); } catch { return ""; }
    };

    const name   = await readCell(idx.NAME);
    const mint   = await readCell(idx.MINT);
    const chain  = await readCell(idx.CHAIN);
    const supply = await readCell(idx.SUPPLY);
    const pub    = await readCell(idx.PUBLIC);

    appendDebug(`[row ${i}] name="${name}" mint="${mint}" chain="${chain}" supply="${supply}" public="${pub}"`);

    // Twitter (hover popover, fallback clic)
    let twitterUrl = null;
    try {
      const nameCell = cells[idx.NAME];
      if (nameCell) {
        const anchor = await nameCell.$("a, [role='link'], span");
        if (anchor) {
          try { await anchor.scrollIntoViewIfNeeded?.(); } catch {}
          const box = await anchor.boundingBox();
          if (box) await page.mouse.move(box.x + box.width/2, box.y + Math.min(10, box.height/2));
          await anchor.hover({ force: true });
          await page.waitForTimeout(600);

          const sel = [
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
          ].join(",");
          const links = await page.$$(sel);
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
          "[class*='modal'] a[href*='x.com'], [class*='modal'] a[href*='twitter.com'], a[href*='x.com'], a[href*='twitter.com']"
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

    // Heures : priorité au texte relatif M/H/D ; tooltip en dernier recours
    const now = new Date();
    const scraped_at_unix = Math.floor(now.getTime() / 1000);
    const tMint = (mint || "").trim();

    const mAhead = tMint.match(/^\s*(\d+)\s*(?:M|MIN)\b(?!\s*ago)/i);
    const hAhead = tMint.match(/^\s*(\d+)\s*H\b(?!\s*ago)/i);
    const dAhead = tMint.match(/^\s*(\d+)\s*D\b(?!\s*ago)/i);

    const relAgo =
      tMint.match(/^\s*(\d+)\s*(?:M|MIN)\s*ago\b/i) ||
      tMint.match(/^\s*(\d+)\s*H\s*ago\b/i) ||
      tMint.match(/^\s*(\d+)\s*D\s*ago\b/i);

    let event_unix_utc = null;

    if (relAgo) {
      appendDebug(`[skip-ago] ${name} mint="${tMint}"`);
      // déjà passé
    } else if (mAhead) {
      event_unix_utc = scraped_at_unix + Number(mAhead[1]) * 60;
    } else if (hAhead) {
      event_unix_utc = scraped_at_unix + Number(hAhead[1]) * 3600;
    } else if (dAhead) {
      event_unix_utc = scraped_at_unix + Number(dAhead[1]) * 86400;
    } else {
      try {
        const mintCell = cells[idx.MINT];
        if (mintCell) {
          event_unix_utc = await readAbsoluteMintUnixFromCell(page, mintCell);
          if (!event_unix_utc) appendDebug(`[no-abs-time] ${name} mint="${tMint}"`);
        }
      } catch {}
      if (!event_unix_utc) { appendDebug(`[skip-format] ${name} mint="${tMint}"`); continue; }
    }

    // Filtre (fenêtre glissante ou "jour TZ")
    let keep = true;
    const DAY_TZ = process.env.DAY_TZ;
    if (DAY_TZ) {
      const dayStart = startOfDayUnixInTZ(now, DAY_TZ);
      const dayEnd = dayStart + 86400;
      keep = event_unix_utc >= dayStart && event_unix_utc < dayEnd;
      if (!keep) appendDebug(`[skip-dayTZ] ${name} ${event_unix_utc} not in ${DAY_TZ} today`);
    } else {
      const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 24);
      const windowStart = scraped_at_unix;
      const windowEnd = scraped_at_unix + WINDOW_HOURS * 3600;
      keep = event_unix_utc >= windowStart && event_unix_utc < windowEnd;
      if (!keep) appendDebug(`[skip-window] ${name} event=${event_unix_utc} not in +${WINDOW_HOURS}h`);
    }
    if (!keep) continue;

    // Arrondis + formats
    const event_unix_utc_rounded = roundHourRule(event_unix_utc);
    const event_utc_hhmm = new Date(event_unix_utc * 1000).toISOString().slice(11, 16);
    const event_utc_hhmm_rounded = new Date(event_unix_utc_rounded * 1000).toISOString().slice(11, 16);

    // Push
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

  // Sauvegarde JSON + CSV
  fs.mkdirSync(OUT_DIR, { recursive: true });
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

  if (items.length === 0) {
    await page.screenshot({ path: path.join(OUT_DIR, "empty.png"), fullPage: true });
    fs.writeFileSync(path.join(OUT_DIR, "page.html"), await page.content(), "utf-8");
    appendDebug("No items kept. Wrote out/empty.png and out/page.html");
  }

  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${csvPath}`);
  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
