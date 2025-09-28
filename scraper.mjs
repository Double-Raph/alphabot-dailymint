// scraper.mjs — calendar edition (v5)
// - Page: https://www.alphabot.app/calendar
// - Clique Today -> lit les pills du jour -> ouvre la popover pour détails
// - Calcule l'heure (pill HH:MM ou "MINTS 9H") et ARRONDIT à l'heure la plus proche
// - Sauvegarde JSON/CSV

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/calendar";
const MAX_ROWS = Number(process.env.MAX_ROWS || 30);
const OUT_DIR = path.join(process.cwd(), "out");

// ---------- Hard timeout global ----------
const HARD_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 6 * 60 * 1000);
const alarm = setTimeout(() => {
  console.error("[HARD-TIMEOUT] Exiting.");
  process.exit(124);
}, HARD_TIMEOUT_MS);
process.on("exit", () => clearTimeout(alarm));

// ---------- Helpers ----------
const norm = (s) => (s ?? "").toString().trim();
const digits = (s) => {
  const x = norm(s).replace(/[^\d]/g, "");
  return x ? Number(x) : null;
};
const todayUTC = new Date();
const stamp = `${todayUTC.getUTCFullYear()}${String(todayUTC.getUTCMonth()+1).padStart(2,"0")}${String(todayUTC.getUTCDate()).padStart(2,"0")}`;

const CHAIN_FROM_SYMBOL = [
  { sym: "◎", chain: "sol" },
  { sym: "Ξ", chain: "eth" },
  { sym: "₿", chain: "btc" },
  { sym: "APE", chain: "ape" },
  { sym: "HYP", chain: "hype" },
  { sym: "HYPE", chain: "hype" },
  { sym: "MATIC", chain: "matic" },
  { sym: "AVAX", chain: "avax" },
  { sym: "SEI", chain: "sei" },
  { sym: "SUI", chain: "sui" },
  { sym: "ABS", chain: "abs" },
  { sym: "BASE", chain: "base" },
  { sym: "ARB", chain: "arb" },
  { sym: "RON", chain: "ron" },
  { sym: "MONAD", chain: "monad" },
  { sym: "TON", chain: "ton" }
];

function guessChain(text) {
  const T = norm(text).toUpperCase();
  for (const { sym, chain } of CHAIN_FROM_SYMBOL) {
    if (T.includes(sym)) return chain;
  }
  // quelques mots-clés directs
  if (/\bETH\b|ETHEREUM/.test(T)) return "eth";
  if (/\bSOL\b|SOLANA/.test(T)) return "sol";
  if (/\bBTC\b|BITCOIN/.test(T)) return "btc";
  if (/\bBASE\b/.test(T)) return "base";
  if (/\bHYPE\b/.test(T)) return "hype";
  if (/\bAPE\b/.test(T)) return "ape";
  return null;
}

function handleFromUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (!/x\.com|twitter\.com/i.test(url.hostname)) return null;
    const h = url.pathname.replace(/\//g, "").trim();
    return h ? `@${h}` : null;
  } catch { return null; }
}

// parse "MINTS 9H" → 9
function hoursFromMints(text) {
  const m = norm(text).match(/MINTS?\s*([0-9]+)\s*H/i);
  return m ? Number(m[1]) : null;
}

// parse "HH:MM"
function hhmmToUnix(hhmm, baseDate, tz = "UTC") {
  if (!hhmm) return null;
  const m = hhmm.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [_, hh, mm] = m;
  // construit date en tz -> epoch UTC
  const d = new Date(baseDate);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const parts = fmt.formatToParts(d).reduce((a,p)=> (p.type!=="literal" && (a[p.type]=p.value), a), {});
  const unix = Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day), Number(hh), Number(mm), 0) / 1000;
  return unix;
}

// round-to-nearest-hour (<=30 down, >30 up)
function roundUnixToNearestHour(unix) {
  const date = new Date(unix * 1000);
  const min = date.getUTCMinutes();
  if (min <= 30) {
    date.setUTCMinutes(0,0,0);
  } else {
    date.setUTCMinutes(0,0,0);
    date.setUTCHours(date.getUTCHours() + 1);
  }
  return Math.floor(date.getTime()/1000);
}

function fmtHHMM(unix) {
  return new Date(unix * 1000).toISOString().slice(11,16);
}

// start-of-day (filter) in tz
function startOfDayUnixInTZ(date, tz = "UTC") {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const parts = fmt.formatToParts(date).reduce((a,p)=> (p.type!=="literal" && (a[p.type]=p.value), a), {});
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day), 0,0,0) / 1000);
}

// safe goto with quick retries
async function safeGoto(page, url) {
  for (let i=0;i<3;i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});
      return;
    } catch (e) {
      console.warn(`[goto retry ${i+1}]`, e.message);
      await page.waitForTimeout(3000);
    }
  }
}

// ---------- MAIN ----------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 1800 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(25000);

  await safeGoto(page, URL);

  // 1) Cliquer "Today" (plusieurs sélecteurs possibles)
  const todayBtn = page.locator("text=Today");
  if (await todayBtn.count()) {
    await todayBtn.first().click().catch(()=>{});
    await page.waitForTimeout(600);
  }

  // 2) Récupérer la liste de "pills" à droite (nom + heure)
  // On prend plusieurs sélecteurs potentiels pour être robuste
  const pillSel = [
    // panneaux à droite, boutons avec heure
    "aside button:has-text(':')",
    "aside a:has-text(':')",
    // fallback: tout élément dans la sidebar qui contient HH:MM
    "aside :is(button,a,div[role='button']):text-matches('/\\b\\d{1,2}:\\d{2}\\b/')",
    // autre fallback: chips dans la zone à droite
    "[class*='Sidebar'] :is(button,a,div[role='button']):text-matches('/\\b\\d{1,2}:\\d{2}\\b/')"
  ].join(", ");

  // Si pas trouvé, on prend tous les "tags" visibles dans la colonne de droite
  let pills = await page.$$(pillSel);
  if (!pills.length) {
    // fallback très permissif
    pills = await page.$$(
      "aside :is(button,a,div[role='button']):visible, [class*='Sidebar'] :is(button,a,div[role='button']):visible"
    );
  }

  // convertir en objets {el, label, hhmm}
  let candidates = [];
  for (const el of pills) {
    const txt = norm(await el.innerText());
    // cherche HH:MM
    const m = txt.match(/\b(\d{1,2}:\d{2})\b/);
    // nom = texte sans l’heure
    const name = norm(m ? txt.replace(m[1], "") : txt).replace(/\s+/g, " ").replace(/[,;|]+/g, " ").trim();
    candidates.push({ el, label: txt, hhmm: m ? m[1] : null, name });
  }

  // dé-duplique par nom
  const uniq = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = `${c.name}||${c.hhmm||""}`;
    if (!seen.has(key) && c.name) {
      seen.add(key);
      uniq.push(c);
    }
  }
  console.log(`Found ~${uniq.length} potential project pills (raw)`);
  const toProcess = uniq.slice(0, MAX_ROWS);
  console.log(`Processing first ${toProcess.length}`);

  const items = [];
  const now = new Date();
  const dayStart = startOfDayUnixInTZ(now, process.env.DAY_TZ || "UTC");
  const dayEnd = dayStart + 86400;

  for (let i = 0; i < toProcess.length; i++) {
    const p = toProcess[i];

    // 3) Ouvrir la popover (stratégie click → hover fallback)
    let pop = null;
    try {
      await p.el.scrollIntoViewIfNeeded?.().catch(()=>{});
      await p.el.click({ delay: 20 }).catch(()=>{});
      await page.waitForTimeout(200);
      pop = page.locator(
        "[role='dialog'], [class*='popover'], [data-radix-popper-content-wrapper']"
      ).last();
      await pop.waitFor({ state: "visible", timeout: 1200 }).catch(()=>{});

      if (!(await pop.count())) {
        await p.el.hover({ force: true }).catch(()=>{});
        await page.waitForTimeout(300);
        await pop.waitFor({ state: "visible", timeout: 1200 }).catch(()=>{});
      }
    } catch(e) {
      console.warn("[popover open failed]", e.message);
    }

    // 4) Extraire infos
    let popText = "";
    let twitterUrl = null;

    if (pop && (await pop.count())) {
      try {
        popText = norm(await pop.innerText());
        const links = await pop.$$("a[href*='x.com'], a[href*='twitter.com']");
        for (const a of links) {
          const href = await a.getAttribute("href");
          if (href && !/alphabot/i.test(href) && !/intent|share/i.test(href)) {
            twitterUrl = href;
            break;
          }
        }
      } catch {}
    }

    // prix public
    // on prend "Free" sinon première occurrence 0.xxx + symbole
    let public_price_raw = "";
    if (/FREE/i.test(popText)) public_price_raw = "Free";
    else {
      const mPrice = popText.match(/([0-9]+(?:\.[0-9]+)?)\s*(◎|Ξ|₿|APE|HYPE|HYP|MATIC|AVAX|SEI|SUI|ABS|BASE|ARB|RON|MONAD)\b/i);
      if (mPrice) public_price_raw = `${mPrice[1]} ${mPrice[2]}`;
    }

    // supply (plus grand groupe de chiffres plausible)
    let supply = null;
    const mSupply = popText.match(/\b([0-9][0-9\.\s]{2,})\b/); // 1 000, 5 555...
    if (mSupply) supply = digits(mSupply[1]);

    // chain (déduite)
    let chain = guessChain(popText) || null;

    // Event time (priorité: hhmm du pill ; fallback: "MINTS 9H")
    let event_unix_utc = null;
    if (p.hhmm) {
      // On suppose que l'heure du pill est en DAY_TZ → converti vers UTC
      event_unix_utc = hhmmToUnix(p.hhmm, now, process.env.DAY_TZ || "UTC");
    }
    if (!event_unix_utc) {
      const h = hoursFromMints(popText);
      if (typeof h === "number") {
        const nowUnix = Math.floor(Date.now()/1000);
        event_unix_utc = nowUnix + h * 3600;
      }
    }
    if (!event_unix_utc) {
      // dernier fallback : ignore si on n'a pas d'heure
      console.warn(`[time missing] ${p.name}`);
      continue;
    }

    // arrondi nearest hour (spéc de Raph)
    const event_unix_utc_rounded = roundUnixToNearestHour(event_unix_utc);

    // filtre: dans la journée DAY_TZ
    if (!(event_unix_utc_rounded >= dayStart && event_unix_utc_rounded < dayEnd)) {
      // skip si hors du jour
      continue;
    }

    // Si pas de chain mais prix trouvé avec symbole — re-deviner
    if (!chain && public_price_raw) chain = guessChain(public_price_raw);

    items.push({
      project: norm(p.name),
      mint_raw: p.hhmm ? p.hhmm : (hoursFromMints(popText) ? `${hoursFromMints(popText)}H` : ""),
      chain: chain || "",
      supply: supply ?? "",
      public_price_raw: public_price_raw || "",
      twitter_handle: handleFromUrl(twitterUrl),
      twitter_url: twitterUrl || "",
      scraped_at_unix: Math.floor(Date.now()/1000),
      event_unix_utc: event_unix_utc,
      event_unix_utc_rounded: event_unix_utc_rounded,
      event_utc_hhmm: fmtHHMM(event_unix_utc),
      event_utc_hhmm_rounded: fmtHHMM(event_unix_utc_rounded)
    });

    // fermer popover
    try {
      await page.keyboard.press("Escape").catch(()=>{});
      await page.mouse.click(10,10).catch(()=>{});
      await page.waitForTimeout(100);
    } catch {}
  }

  // ------- Sauvegardes -------
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
    "event_unix_utc_rounded",
    "event_utc_hhmm",
    "event_utc_hhmm_rounded"
  ];
  const csv = [
    header.join(","),
    ...items.map(x =>
      header.map(k => {
        const v = x[k] == null ? "" : String(x[k]).replace(/"/g,'""');
        return /[,"\n]/.test(v) ? `"${v}"` : v;
      }).join(",")
    )
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
