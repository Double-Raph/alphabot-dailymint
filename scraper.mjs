// scraper.mjs — Calendar scraper (alphabot.app/calendar)
// Node >= 18, Playwright ^1.47
// Sorties: out/alphabot_YYYYMMDD.json + .csv
// DEBUG: traces + screenshots si souci

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const CAL_URL  = "https://www.alphabot.app/calendar";
const OUT_DIR  = path.join(process.cwd(), "out");
const MAX_ROWS = Number(process.env.MAX_ROWS || 30);

// ---------- utils ----------
const norm = (s) => (s ?? "").toString().trim();

const digits = (s) => {
  const x = norm(s).replace(/[^\d]/g, "");
  return x ? Number(x) : null;
};

function handleFromUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (!/x\.com|twitter\.com/i.test(url.hostname)) return null;
    const h = url.pathname.replace(/\//g, "").trim();
    return h ? `@${h}` : null;
  } catch {
    return null;
  }
}

const todayUTC = new Date();
const stamp = `${todayUTC.getUTCFullYear()}${String(todayUTC.getUTCMonth() + 1).padStart(2, "0")}${String(todayUTC.getUTCDate()).padStart(2, "0")}`;

function logDebug(msg) {
  fs.appendFileSync(path.join(OUT_DIR, "debug.log"), `[${new Date().toISOString()}] ${msg}\n`);
}

// Attendre "l'un OU l'autre"
async function waitForAny(page, waiters, overallTimeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), overallTimeoutMs);
  const wrapped = waiters.map(w => w().catch(() => new Promise(() => {})));
  try {
    await Promise.race(wrapped);
  } finally {
    clearTimeout(timer);
  }
}

// Aller/attendre la page
async function gotoCalendar(page) {
  await page.goto(CAL_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(()=>{});

  const calendarSelectors = '[role="grid"], [class*="Calendar"], [class*="calendar"]';
  await waitForAny(page, [
    () => page.locator("text=FILTER").first().waitFor({ state: "visible", timeout: 6000 }),
    () => page.locator(calendarSelectors).first().waitFor({ state: "visible", timeout: 6000 }),
  ], 18000);
}

// Trouver la case "Today" ou celle correspondant à la date du jour
async function findTodayCell(page) {
  // 1) essai direct "Today"
  const byToday = page.locator("text=/^\\s*Today\\s*$/i").first();
  if (await byToday.count().catch(()=>0)) {
    // remonte à la cellule parent (case calendrier)
    const cell = await byToday.locator("xpath=ancestor::*[self::*[contains(@role,'gridcell')] or self::*[contains(@class,'day')] or self::*[contains(@class,'cell')]][1]").first();
    if (await cell.count().catch(()=>0)) return cell;
  }

  // 2) fallback: repérer un gridcell avec aria-selected=true
  const selected = page.locator('[role="gridcell"][aria-selected="true"]').first();
  if (await selected.count().catch(()=>0)) return selected;

  // 3) fallback: jour numérique
  const d = new Date();
  const dd = String(d.getDate());
  // un chiffre en haut à gauche de la case
  const anyCell = page.locator(`[role="gridcell"]:has-text("${dd}")`).first();
  if (await anyCell.count().catch(()=>0)) return anyCell;

  // 4) dernier fallback: toute case visible du calendrier
  const any = page.locator('[role="gridcell"]').first();
  if (await any.count().catch(()=>0)) return any;

  return null;
}

// Extraire infos depuis la popover/modale
async function readFromPopover(page) {
  // la popover peut être: [role=dialog], [data-radix-popper-content-wrapper], etc.
  const card = page.locator(
    "[role='dialog'], [data-radix-popper-content-wrapper], [class*='popover'], [class*='TooltipContent'], [class*='card']"
  ).last();
  await card.waitFor({ state: "visible", timeout: 2000 }).catch(()=>{});

  if (!(await card.count().catch(()=>0))) return null;

  // Le texte complet, on parse
  const txt = await card.innerText().catch(()=> "") || "";

  // Nom: 1ère ligne non vide
  const firstLine = txt.split("\n").map(t => t.trim()).filter(Boolean)[0] || "";
  const project = norm(firstLine);

  // MINTS 9H / 8H …
  let mint_raw = null;
  const m1 = txt.match(/MINTS?\s+(\d+\s*H)\b/i);
  if (m1) mint_raw = m1[1].toUpperCase();

  // Supply: on prend le 1er nombre « grand »
  // (souvent "2 555" / "5 000" → digits())
  let supply = null;
  const candidateSup = txt.match(/(?:\b|^)([\d\s]{2,6})(?:\b|$)/g);
  if (candidateSup) {
    for (const c of candidateSup) {
      const n = digits(c);
      if (n && n >= 100 && n <= 200000) { supply = n; break; }
    }
  }

  // Prix: "FREE" ou un 0.xxx
  let public_price_raw = null;
  const pf = txt.match(/\bFREE\b/i);
  if (pf) {
    public_price_raw = "Free";
  } else {
    const pn = txt.match(/\b0\.\d{1,6}\b/);
    if (pn) public_price_raw = pn[0];
  }

  // Twitter / X dans la popover s'il y en a
  let twitter_url = null;
  const links = await card.locator("a[href]").all();
  for (const a of links) {
    const href = await a.getAttribute("href");
    if (href && /twitter\.com|x\.com/i.test(href)) {
      twitter_url = href;
      break;
    }
  }
  const twitter_handle = handleFromUrl(twitter_url);

  // Optionnel: la chaîne n'apparaît pas toujours sur cette popover
  const chain = null;

  return { project, mint_raw, chain, supply, public_price_raw, twitter_handle, twitter_url };
}

// Cliquer un chip projet (dans la case du jour)
async function openProjectCard(page, chip) {
  try {
    await chip.scrollIntoViewIfNeeded?.().catch(()=>{});
    await chip.hover({ force: true }).catch(()=>{});
    await page.waitForTimeout(120);
    await chip.click({ delay: 40 }).catch(()=>{});
    // petite attente pour la popover
    await page.waitForTimeout(250);
  } catch {}
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const traceDir = path.join(process.cwd(), "traces");
  fs.mkdirSync(traceDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1100 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });

  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  try {
    await gotoCalendar(page);

    const todayCell = await findTodayCell(page);
    if (!todayCell) {
      logDebug("No 'today' cell found");
      throw new Error("Cannot locate today cell");
    }

    // Dans la case, les "chips" projets (le design varie, on cast large)
    const chipSelector = [
      "a[role='button']",
      "button",
      "[class*='chip']",
      "[class*='Badge']",
      "[class*='tag']",
      "[class*='pill']",
      "a", // fallback
    ].join(",");

    const chips = await todayCell.locator(chipSelector).all();
    logDebug(`Found ${chips.length} chips in Today cell`);

    const take = Math.min(chips.length, MAX_ROWS);
    const items = [];

    for (let i = 0; i < take; i++) {
      const chip = chips[i];
      try {
        await openProjectCard(page, chip);
        const row = await readFromPopover(page);
        if (row && row.project) {
          // éviter doublons par nom
          if (!items.some(it => it.project === row.project)) {
            items.push(row);
          }
        }
        // fermer la pop si possible (Esc + clic à l’écart)
        await page.keyboard.press("Escape").catch(()=>{});
        await page.mouse.click(10, 10).catch(()=>{});
        await page.waitForTimeout(150);
      } catch (e) {
        logDebug(`chip#${i} error: ${e?.message || e}`);
      }
    }

    // Sauvegardes
    const jsonPath = path.join(OUT_DIR, `alphabot_${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), "utf-8");

    const header = [
      "project",
      "mint_raw",
      "chain",
      "supply",
      "public_price_raw",
      "twitter_handle",
      "twitter_url"
    ];
    const csv = [
      header.join(","),
      ...items.map(x => header.map(k => {
        const v = x[k] == null ? "" : String(x[k]).replace(/"/g, '""');
        return /[,"\n]/.test(v) ? `"${v}"` : v;
      }).join(","))
    ].join("\n");
    const csvPath = path.join(OUT_DIR, `alphabot_${stamp}.csv`);
    fs.writeFileSync(csvPath, csv, "utf-8");

    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${csvPath}`);

  } catch (err) {
    logDebug(`FATAL: ${err?.message || err}`);
    // dump screenshot pour debug
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `playwright-${Date.now()}.png`), fullPage: true });
    } catch {}
    throw err;
  } finally {
    await context.tracing.stop({ path: path.join(traceDir, `trace-${Date.now()}.zip`) }).catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
