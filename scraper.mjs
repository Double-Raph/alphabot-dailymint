// scraper.mjs — calendar mode with robust navigation, tracing & debug artifacts
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = process.env.CALENDAR_URL || "https://www.alphabot.app/calendar";
const MAX_ROWS = Number(process.env.MAX_ROWS || 20);
const OUT_DIR = path.join(process.cwd(), "out");
const TRACE_DIR = path.join(process.cwd(), "traces");

// -------- helpers
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

function logDebug(...args) {
  fs.appendFileSync("debug.log", args.join(" ") + "\n");
}

async function gotoWithRetry(page, url, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      if (resp && !resp.ok()) throw new Error(`HTTP ${resp.status()} at ${url}`);
      // basic page sanity: title or key UI
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(()=>{});
      await page.waitForSelector('text=/Mint Calendar|FILTER/i', { timeout: 30_000 });
      return;
    } catch (e) {
      lastErr = e;
      logDebug(`[goto retry ${i}] ${e.message}`);
      await page.waitForTimeout(2_000 * i);
    }
  }
  throw lastErr;
}

async function ensureTodayVisible(page) {
  // The right side date column lists “aujourd’hui” / “today”.
  // We ensure the month grid is present, then scroll to the day column.
  await page.waitForSelector('text=/Mint Calendar|FILTER/i', { timeout: 30_000 });

  // Some UIs need a tiny scroll to render the right side rail
  await page.mouse.wheel(0, 1);
  await page.waitForTimeout(200);
}

// Extract projects from the right agenda rail for “today”
async function listTodayProjectBadges(page) {
  // Very generic locator: on the right, there are badges with time like “17:00” + project
  // We'll collect the agenda items for the visible day (right column under the current header).
  const rows = await page.$$(':right-of(:text("FILTER")) >> [role="button"], :right-of(:text("FILTER")) >> a, :right-of(:text("FILTER")) >> div[role="listitem"]');
  // Fallback to any badge with a time pattern
  const extra = await page.$$('[class*=Badge],[class*=badge]');

  const uniq = new Set();
  const all = [...rows, ...extra];
  const picked = [];

  for (const el of all) {
    try {
      const txt = (await el.innerText()).trim();
      if (!txt) continue;
      // Rough filter: looks like an agenda entry if it has a time "17:00" or is short-tagged
      if (/\b\d{1,2}:\d{2}\b/.test(txt) || txt.length <= 20) {
        const key = txt.slice(0, 80);
        if (!uniq.has(key)) {
          uniq.add(key);
          picked.push(el);
        }
      }
    } catch {}
    if (picked.length >= MAX_ROWS) break;
  }
  return picked;
}

async function openPopoverAndRead(page, trigger) {
  // hover + click to open the project card on the left column
  await trigger.scrollIntoViewIfNeeded().catch(()=>{});
  await trigger.hover({ force: true }).catch(()=>{});
  await trigger.click({ delay: 50 }).catch(()=>{});
  await page.waitForTimeout(400);

  // The card shows on the left; find a visible card container
  const card = await page.locator(
    "[role='dialog'], [class*=card]:has-text('MINTS'), [class*=card]:has([class*=MINTS])"
  ).last();

  // If no explicit role, grab the “Add external win” section as anchor
  const hasCard = await card.count().catch(()=>0);
  if (!hasCard) {
    // try any visible floating panel with action icons
    const alt = page.locator("[class*=popover], [class*=tooltip], [class*=Card]").last();
    if (await alt.count().catch(()=>0)) return alt;
  }
  return card;
}

function parseCardData(text) {
  // Parse the card innerText (generic)
  const t = text.replace(/\u00A0/g, " "); // nbsp
  const firstLine = t.split("\n").find(Boolean) || "";
  const project = firstLine.trim();

  // MINTS 9H or “MINTS 8H”
  const mintMatch = t.match(/MINTS\s+(\d+)\s*H/i);
  const mintRaw = mintMatch ? `${mintMatch[1]}H` : "";

  // SUPPLY
  const supplyMatch = t.match(/\b(\d[\d\s]{0,3}\d)\b(?=.*\bSUPPLY\b|\bMINTS\b|^\s*\d)/i) ||
                      t.match(/^\s*\D*(\d[\d\s]{0,3}\d)/m);
  const supply = supplyMatch ? digits(supplyMatch[1]) : null;

  // Price: "FREE" or numeric; card often shows a second price as “public”
  let publicPrice = "Free";
  const priceFree = /FREE/i.test(t);
  if (!priceFree) {
    const p = t.match(/\b(\d+(\.\d+)?(?:\s*[A-Z]+)?)\b(?!.*MINTS)/i);
    if (p) publicPrice = p[1].replace(/\s+/g, ""); // e.g. 0.15, 0.0002
  } else {
    publicPrice = "Free";
  }

  // Twitter link (icon on card)
  const twHandle = null; // filled by attribute scrape below if found

  return { project, mintRaw, supply, publicPrice, twHandle };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TRACE_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1800 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });

  // Start tracing for post-mortem
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(90_000);

  // collect console logs
  page.on("console", (msg) => logDebug(`[console] ${msg.type()} ${msg.text()}`));
  page.on("pageerror", (err) => logDebug(`[pageerror] ${err.message}`));

  try {
    await gotoWithRetry(page, URL);
    await ensureTodayVisible(page);

    const triggers = await listTodayProjectBadges(page);
    logDebug(`agenda items detected: ${triggers.length}`);

    const items = [];

    for (const trigger of triggers) {
      try {
        const card = await openPopoverAndRead(page, trigger);
        if (!(await card.count())) continue;

        // read plain text
        const text = (await card.innerText()).trim();
        const { project, mintRaw, supply, publicPrice } = parseCardData(text);

        // chain symbol on the card is shown via an icon & sometimes 3-4 letters nearby;
        // as a generic fallback we capture short tokens we know
        const chainGuess = /ETH/i.test(text) ? "eth" :
                           /SOL/i.test(text) ? "sol" :
                           /BASE/i.test(text) ? "base" :
                           /APE\b|APECoin/i.test(text) ? "ape" :
                           /ABS/i.test(text) ? "abs" :
                           /HYPE/i.test(text) ? "hype" :
                           /BTC/i.test(text) ? "btc" :
                           /SEI/i.test(text) ? "sei" :
                           /SUI/i.test(text) ? "sui" :
                           /HL|HYPE/i.test(text) ? "hype" : "";

        // twitter link attribute on the card
        let twitterUrl = null;
        const tw = await card.locator("a[href*='x.com'],a[href*='twitter.com']").first();
        if (await tw.count().catch(()=>0)) {
          twitterUrl = await tw.getAttribute("href");
        }

        // hours: best-effort; card shows "MINTS 9H" relative. Use 24h window from now.
        const scraped_at_unix = Math.floor(Date.now() / 1000);
        let event_unix_utc = null;

        const m = mintRaw.match(/(\d+)\s*H/i);
        if (m) {
          event_unix_utc = scraped_at_unix + Number(m[1]) * 3600;
        } else {
          // if the agenda badge had time like "17:00", grab it from trigger text
          const badgeText = (await trigger.innerText().catch(()=>"" )) || "";
          const t = badgeText.match(/\b(\d{1,2}):(\d{2})\b/);
          if (t) {
            const now = new Date();
            event_unix_utc = Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate(),
              Number(t[1]),
              Number(t[2]),
              0
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

        // close card (Esc)
        await page.keyboard.press("Escape").catch(()=>{});
        await page.mouse.click(10, 10).catch(()=>{});
      } catch (e) {
        logDebug(`[item error] ${e.message}`);
        // keep going
      }
    }

    // write outputs
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
      "scraped_at_unix",
      "event_unix_utc",
      "event_utc_hhmm"
    ];
    const csv = [
      header.join(","),
      ...items.map(x =>
        header.map(k => {
          const v = x[k] == null ? "" : String(x[k]).replace(/"/g, '""');
          return /[,"\n]/.test(v) ? `"${v}"` : v;
        }).join(",")
      )
    ].join("\n");
    const csvPath = path.join(OUT_DIR, `alphabot_${stamp}.csv`);
    fs.writeFileSync(csvPath, csv, "utf-8");

    logDebug(`Saved ${items.length} items`);
    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${csvPath}`);
  } catch (e) {
    logDebug(`[fatal] ${e.stack || e.message}`);
    // snapshot for debugging
    try { await page.screenshot({ path: `playwright-${Date.now()}.png`, fullPage: true }); } catch {}
    throw e;
  } finally {
    try {
      await context.tracing.stop({ path: path.join(TRACE_DIR, `trace-${stamp}.zip`) });
    } catch {}
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
