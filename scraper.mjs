// scraper.mjs — calendar scraping with retries + guaranteed artifacts
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = process.env.CALENDAR_URL || "https://www.alphabot.app/calendar";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20);

const OUT_DIR   = path.join(process.cwd(), "out");
const TRACE_DIR = path.join(process.cwd(), "traces");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(TRACE_DIR, { recursive: true });

function logDebug(...args) {
  fs.appendFileSync("debug.log", args.join(" ") + "\n");
}

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

const nowUTC = new Date();
const stamp = `${nowUTC.getUTCFullYear()}${String(nowUTC.getUTCMonth()+1).padStart(2,"0")}${String(nowUTC.getUTCDate()).padStart(2,"0")}`;

async function gotoWithRetry(page, url, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      if (resp && !resp.ok()) throw new Error(`HTTP ${resp.status()} at ${url}`);
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(()=>{});
      // don’t be strict: any big calendar container or FILTER button will do
      await page.waitForSelector('text=/FILTER/i, [role="grid"], [class*="Calendar"], [class*="calendar"]', { timeout: 30_000 });
      return;
    } catch (e) {
      lastErr = e;
      logDebug(`[goto retry ${i}] ${e.message}`);
      try { await page.screenshot({ path: `playwright-goto-${i}.png`, fullPage: true }); } catch {}
      await page.waitForTimeout(2000 * i);
    }
  }
  throw lastErr;
}

async function ensureTodayVisible(page) {
  // gentle scroll to trigger right agenda rendering
  await page.mouse.wheel(0, 1);
  await page.waitForTimeout(300);
}

async function listTodayProjectBadges(page) {
  // very loose selectors for the right agenda column
  const candidates = await page.$$(
    ':right-of(:text("FILTER")) [role="button"], ' +
    ':right-of(:text("FILTER")) a, ' +
    ':right-of(:text("FILTER")) [class*=Badge], ' +
    ':right-of(:text("FILTER")) [class*=badge], ' +
    '[class*=agenda] [role="button"], [class*=agenda] a'
  );

  const uniq = new Set();
  const picked = [];
  for (const el of candidates) {
    try {
      const txt = (await el.innerText()).trim();
      if (!txt) continue;
      // likely agenda entries: contain hh:mm OR are short chips
      if (/\b\d{1,2}:\d{2}\b/.test(txt) || txt.length <= 22) {
        const key = txt.slice(0, 80);
        if (!uniq.has(key)) {
          uniq.add(key);
          picked.push(el);
        }
      }
    } catch {}
    if (picked.length >= MAX_ROWS) break;
  }
  logDebug(`agenda candidates: ${candidates.length}, picked: ${picked.length}`);
  return picked;
}

function parseCardData(text) {
  const t = text.replace(/\u00A0/g, " ");
  const firstLine = t.split("\n").find(Boolean) || "";
  const project = firstLine.trim();

  const mintMatch = t.match(/MINTS\s+(\d+)\s*H/i);
  const mintRaw = mintMatch ? `${mintMatch[1]}H` : "";

  const supplyMatch = t.match(/\b(\d[\d\s]{0,3}\d)\b(?=.*\bSUPPLY\b|\bMINTS\b|^\s*\d)/i) ||
                      t.match(/^\s*\D*(\d[\d\s]{0,3}\d)/m);
  const supply = supplyMatch ? digits(supplyMatch[1]) : null;

  let publicPrice = /FREE/i.test(t) ? "Free" : null;
  if (!publicPrice) {
    const p = t.match(/\b(\d+(\.\d+)?(?:\s*[A-Z]+)?)\b(?!.*MINTS)/i);
    if (p) publicPrice = p[1].replace(/\s+/g, "");
  }
  if (!publicPrice) publicPrice = "Free";

  return { project, mintRaw, supply, publicPrice };
}

async function openCardFromAgenda(page, trigger) {
  await trigger.scrollIntoViewIfNeeded().catch(()=>{});
  await trigger.hover({ force: true }).catch(()=>{});
  await trigger.click({ delay: 50 }).catch(()=>{});
  await page.waitForTimeout(450);

  const card = page.locator(
    "[role='dialog'], [class*=Card]:has-text('MINTS'), [class*=card]:has([class*=MINTS])"
  ).last();

  if (await card.count()) return card;

  const alt = page.locator("[class*=popover], [class*=tooltip], [class*=Card]").last();
  if (await alt.count()) return alt;

  return card; // empty locator
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1800 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(90_000);

  page.on("console", (msg) => logDebug(`[console] ${msg.type()} ${msg.text()}`));
  page.on("pageerror", (err) => logDebug(`[pageerror] ${err.message}`));

  const items = [];
  try {
    await gotoWithRetry(page, URL);
    await ensureTodayVisible(page);

    const triggers = await listTodayProjectBadges(page);

    for (const trigger of triggers) {
      try {
        const card = await openCardFromAgenda(page, trigger);
        if (!(await card.count())) continue;

        const text = (await card.innerText()).trim();
        const { project, mintRaw, supply, publicPrice } = parseCardData(text);

        const chainGuess = /ETH/i.test(text) ? "eth" :
                           /SOL/i.test(text) ? "sol" :
                           /BASE/i.test(text) ? "base" :
                           /APE\b|APECoin/i.test(text) ? "ape" :
                           /ABS/i.test(text) ? "abs" :
                           /HYPE/i.test(text) ? "hype" :
                           /BTC/i.test(text) ? "btc" :
                           /SEI/i.test(text) ? "sei" :
                           /SUI/i.test(text) ? "sui" : "";

        let twitterUrl = null;
        const tw = await card.locator("a[href*='x.com'],a[href*='twitter.com']").first();
        if (await tw.count().catch(()=>0)) {
          twitterUrl = await tw.getAttribute("href");
        }

        const scraped_at_unix = Math.floor(Date.now() / 1000);
        let event_unix_utc = null;

        const m = mintRaw.match(/(\d+)\s*H/i);
        if (m) {
          event_unix_utc = scraped_at_unix + Number(m[1]) * 3600;
        } else {
          const badgeText = (await trigger.innerText().catch(()=>"" )) || "";
          const t = badgeText.match(/\b(\d{1,2}):(\d{2})\b/);
          if (t) {
            const now = new Date();
            event_unix_utc = Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate(),
              Number(t[1]), Number(t[2]), 0
            ) / 1000;
          }
        }
        if (!event_unix_utc) continue;

        const event_utc_hhmm = new Date(event_unix_utc * 1000).toISOString().slice(11, 16);

        items.push({
          project: norm(project),
          mint_raw: norm(mintRaw),
          chain: norm(chainGuess).toLowerCase(),
          supply: supply ?? null,
          public_price_raw: norm(publicPrice),
          twitter_handle: handleFromUrl(twitterUrl),
          twitter_url: twitterUrl || "",
          scraped_at_unix,
          event_unix_utc,
          event_utc_hhmm
        });

        await page.keyboard.press("Escape").catch(()=>{});
        await page.mouse.click(10, 10).catch(()=>{});
      } catch (e) {
        logDebug(`[item error] ${e.message}`);
        try { await page.screenshot({ path: `playwright-item-${Date.now()}.png`, fullPage: true }); } catch {}
      }
    }

    // write outputs (even if 0 items)
    const jsonPath = path.join(OUT_DIR, `alphabot_${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), "utf-8");

    const header = [
      "project","mint_raw","chain","supply","public_price_raw",
      "twitter_handle","twitter_url","scraped_at_unix","event_unix_utc","event_utc_hhmm"
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

    logDebug(`Saved ${items.length} items`);
    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${csvPath}`);
  } catch (e) {
    logDebug(`[fatal] ${e.stack || e.message}`);
    try { await page.screenshot({ path: `playwright-fatal-${Date.now()}.png`, fullPage: true }); } catch {}
    // guarantee at least one file in /out:
    fs.writeFileSync(path.join(OUT_DIR, "EMPTY.txt"), "scrape failed\n");
    throw e; // keep non-zero exit to see “Failure”
  } finally {
    try { await context.tracing.stop({ path: path.join(TRACE_DIR, `trace-${stamp}.zip`) }); } catch {}
    await browser.close();
  }
})();
