// scraper.mjs — v4.1 (heures = tooltip MINT, fallback +H, 20 premières lignes)
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

// ---- Helpers pour extraire l'heure absolue depuis la cellule MINT ----
function parseDateTextToUnix(text) {
  if (!text) return null;
  const t = text.trim();

  // cas 1: parsable natif (ISO, "Sep 13 2025 14:17 UTC", etc.)
  const iso = Date.parse(t);
  if (!Number.isNaN(iso)) return Math.floor(iso / 1000);

  // cas 2: "HH:MM UTC" (jour = aujourd'hui en UTC)
  let m = t.match(/(\d{1,2}):(\d{2})\s*UTC/i);
  if (m) {
    const now = new Date();
    return Math.floor(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        Number(m[1]),
        Number(m[2]),
        0
      ) / 1000
    );
  }

  // cas 3: "DD/MM/YYYY HH:MM" (interprété en UTC)
  m = t.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const dd = Number(m[1]),
      mm = Number(m[2]),
      yyyy = Number(m[3].length === 2 ? "20" + m[3] : m[3]),
      HH = Number(m[4]),
      MM = Number(m[5]);
    return Math.floor(Date.UTC(yyyy, mm - 1, dd, HH, MM, 0) / 1000);
  }

  return null;
}

async function readAbsoluteMintUnixFromCell(page, cell) {
  // 1) Attributs sur la cellule ou son enfant
  const attrs = ["title", "aria-label", "data-title", "data-tooltip", "data-original-title", "data-tippy-content"];
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

  // 2) Hover → tooltip/popover
  try {
    await cell.hover({ force: true });
    await page.waitForTimeout(450);
    const tip = page.locator(
      "[role='tooltip'], [data-radix-popper-content-wrapper], [class*='tooltip'], [class*='popover'], [class*='balloon']"
    ).last();
    if (await tip.count()) {
      const txt = (await tip.innerText()).trim();
      const unix = parseDateTextToUnix(txt);
      if (unix) return unix;
    }
  } catch {}

  return null; // pas trouvé
}

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

        const anchor = await nameCell.$("a, [role='link'], span");
        if (anchor) {
          await anchor.scrollIntoViewIfNeeded?.().catch(()=>{});
          const box = await anchor.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width/2, box.y + Math.min(10, box.height/2));
          }
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
            if (href && !/alphabotapp/i.test(href) && !/intent|share/i.test(href)) {
              twitterUrl = href;
              break;
            }
          }
        }
      }

      // Fallback : clic si le hover n'a rien donné
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
        await page.keyboard.press("Escape").catch(()=>{});
        await page.mouse.click(10, 10).catch(()=>{});
        await page.waitForTimeout(150);
      }
    } catch {
      // ignore si pas de popover
    }

    // ----- Heures : d'abord tooltip MINT, sinon fallback +H ; filtre "aujourd'hui" -----
    const now = new Date();
    const scraped_at_unix = Math.floor(now.getTime() / 1000);

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
        continue; // ex: "2D" → ignore
      }
    }

    // garde uniquement les mints du jour (UTC)
    const startUTC = Math.floor(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0
    ) / 1000);
    const endUTC = startUTC + 86400;
    if (!(event_unix_utc >= startUTC && event_unix_utc < endUTC)) {
      continue;
    }

    // HH:MM en UTC (pour Twitter)
    const event_utc_hhmm = new Date(event_unix_utc * 1000).toISOString().slice(11, 16);

    // ---- push final
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
