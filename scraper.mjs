// scraper.mjs — v5 (alphabot /calendar)
// - Va sur /calendar
// - Choisit "aujourd'hui"
// - Lit la liste du jour (panneau à droite) pour les heures absolues
// - Ouvre chaque projet (popover) pour Supply / Public Price / Twitter
// - Exporte JSON + CSV

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const URLS = [
  "https://www.alphabot.app/calendar",
  "https://alphabot.app/calendar",
];

const MAX_ROWS = Number(process.env.MAX_ROWS || 30);
const OUT_DIR = path.join(process.cwd(), "out");
const DAY_TZ = process.env.DAY_TZ || "Europe/Paris"; // la colonne de droite est affichée en TZ locale

// ---------- helpers ----------
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

// HH:MM -> epoch UTC pour "aujourd'hui" dans DAY_TZ
function todayLocalTimeToUnix(hhmm, tz = DAY_TZ) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [HH, MM] = hhmm.split(":").map(Number);

  // On récupère Y-M-D "dans le fuseau tz"
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now).reduce((a, p) => {
    if (p.type !== "literal") a[p.type] = p.value;
    return a;
  }, {});
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);

  // construisons une date "dans tz", puis convertissons en epoch UTC
  // Astuce: on passe par Date.UTC et on corrige offset via Intl
  const local = new Date(Date.UTC(y, m - 1, d, HH, MM, 0));
  // Reformattons cette "local time dans tz" en epoch réel:
  const offMinutes = -new Date(local.toLocaleString("en-US", { timeZone: tz })).getTimezoneOffset();
  // NB: getTimezoneOffset() renvoie l'offset du runtime, pas tz. On corrige via trick:
  // plus robuste: calculer offset tz via Intl.DateTimeFormat formatToParts('timeZoneName')—trop verbeux ici.
  // Pour rester simple/stable, on s'appuie sur Intl pour obtenir la bonne date "affichée"
  // puis on refait un Date.parse dessus:
  const s = local.toLocaleString("sv-SE", { timeZone: tz, hour12: false });
  const ms = Date.parse(s.replace(" ", "T") + ".000Z"); // sv-SE => "YYYY-MM-DD HH:MM:SS"
  return Math.floor(ms / 1000);
}

function detectChainFromText(text) {
  const t = norm(text);
  if (/[ΞΕ]/.test(t)) return "eth";
  if (/[◎]/.test(t)) return "sol";
  if (/₿/.test(t)) return "btc";
  if (/\bape\b/i.test(t)) return "ape";
  if (/\bhype\b/i.test(t)) return "hype";
  if (/\bbase\b/i.test(t)) return "base";
  if (/\babs\b/i.test(t)) return "abs";
  if (/\bsei\b/i.test(t)) return "sei";
  if (/\bavax\b/i.test(t)) return "avax";
  if (/\bmatic\b|\bpolygon\b/i.test(t)) return "matic";
  return "";
}

function priceFromPopoverText(txt) {
  // On veut le "public" => souvent le 2e prix, libellé "FREE" ou un nombre
  // On prend le dernier token ressemblant à prix
  const t = norm(txt).replace(/\s+/g, " ");
  const tokens = [];
  const re = /(free|0(\.\d+)?|[0-9]+(\.[0-9]+)?)/gi;
  let m;
  while ((m = re.exec(t))) tokens.push(m[0]);
  if (!tokens.length) return { raw: "", chainGuess: "" };

  const raw = tokens[tokens.length - 1].toLowerCase() === "free" ? "Free" : tokens[tokens.length - 1];
  const chainGuess = detectChainFromText(t);
  return { raw, chainGuess };
}

async function safeGoto(page, attempts = 4) {
  for (let k = 1; k <= attempts; k++) {
    for (const u of URLS) {
      try {
        const r = await page.goto(u, { waitUntil: "domcontentloaded", timeout: 70000 });
        await page.waitForTimeout(1000);
        const ok = await page.waitForSelector("[role='grid'], [data-testid*='calendar']", { timeout: 8000 }).then(() => true).catch(() => false);
        if (ok) return true;
      } catch (e) {
        console.warn("goto:", e.message);
      }
    }
    await page.waitForTimeout(6000);
  }
  return false;
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1800 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    locale: "en-US"
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  // NAV
  const ok = await safeGoto(page);
  if (!ok) {
    console.error("Calendar not reachable.");
    await page.screenshot({ path: path.join(OUT_DIR, "calendar_fail.png"), fullPage: true }).catch(()=>{});
    process.exit(2);
  }

  // 1) Sélectionner "aujourd'hui" dans la grille
  // On cherche une cellule qui contient "Today"
  const todayCell = await page.locator("text=Today").first();
  if (await todayCell.count()) {
    await todayCell.click().catch(()=>{});
    await page.waitForTimeout(400);
  } else {
    // fallback: la dernière cellule marquée 'Today' sur le côté droit (si existant)
    console.warn("No explicit 'Today' tag found — continuing.");
  }

  // 2) Lire le panneau de droite : noms + heures
  // Le panneau de droite (sidebar jour) contient des lignes: [Nom] [HH:MM]
  // On va récupérer (nom, hhmm) pour construire l'heure absolue
  const dayItems = await page.evaluate(() => {
    const items = [];
    // heuristique : dans la colonne droite, il y a des badges heure (ex. 18:30) à côté des titres
    const sidebar = document.body; // on va chercher globalement
    const rows = Array.from(sidebar.querySelectorAll("div,li,span,a")).filter(el => {
      const txt = (el.textContent || "").trim();
      return /\b\d{1,2}:\d{2}\b/.test(txt) && el.closest("[class*='right'],[class*='sidebar'],[class*='Day'],[class*='panel']");
    });
    const seen = new Set();
    for (const el of rows) {
      const txt = (el.textContent || "").trim();
      const m = txt.match(/(.+?)\s+(\d{1,2}:\d{2})$/);
      if (m) {
        const name = m[1].trim();
        const hhmm = m[2].trim();
        const key = name + "|" + hhmm;
        if (!seen.has(key)) {
          items.push({ name, hhmm });
          seen.add(key);
        }
      }
    }
    // si trop vide, on tente autre structuration (badges de temps à part)
    if (!items.length) {
      const timeBadges = Array.from(sidebar.querySelectorAll("span,div")).filter(x => /^\d{1,2}:\d{2}$/.test((x.textContent||"").trim()));
      for (const tb of timeBadges) {
        const hhmm = tb.textContent.trim();
        const container = tb.closest("div,li") || tb.parentElement;
        let name = "";
        if (container) {
          const t = (container.textContent || "").trim();
          // enlève l'heure
          name = t.replace(hhmm, "").trim();
        }
        if (name) items.push({ name, hhmm });
      }
    }
    return items;
  });

  if (!dayItems.length) {
    console.warn("No right-panel items found — trying grid pills only.");
  }

  // Index rapide: nom -> hhmm (il peut y avoir des doublons → on garde le premier)
  const timeByName = new Map();
  for (const it of dayItems) {
    const key = it.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (!timeByName.has(key)) timeByName.set(key, it.hhmm);
  }

  // 3) Récupérer les "pills" dans la cellule du jour, cliquer pour popover et lire infos
  // Heuristique: la cellule "Today" est encore sélectionnée; on prend tous les boutons/liens à l'intérieur
  // Si on ne trouve pas, on prend toutes les pills visibles sur la page (limité MAX_ROWS)
  let pills = await page.$$("button, a");
  // Filtrage heuristique: courts labels + fond badge
  pills = (await Promise.all(pills.map(async p => {
    const txt = (await p.innerText().catch(()=> ""))?.trim();
    const box = await p.boundingBox().catch(()=>null);
    return (!txt || !box) ? null : { el: p, txt, area: box.width * box.height };
  }))).filter(Boolean)
     .filter(x => x.area < 60000 && x.txt.length >= 2 && x.txt.length <= 40); // évite gros blocs

  // On n'en veut que MAX_ROWS
  const unique = new Map();
  for (const p of pills) {
    const key = p.txt.toLowerCase().replace(/\s+/g," ").trim();
    if (!unique.has(key)) unique.set(key, p);
    if (unique.size >= MAX_ROWS) break;
  }

  const projects = Array.from(unique.values());
  console.log(`Found ~${projects.length} potential project pills`);

  const items = [];
  const stampDate = new Date();
  const scraped_at_unix = Math.floor(stampDate.getTime()/1000);

  for (const p of projects) {
    const name = p.txt;
    // Associer l'heure à partir du panneau de droite
    const hhmm = timeByName.get(name.toLowerCase().replace(/\s+/g," ").trim()) || null;
    let event_unix_utc = null, event_utc_hhmm = "";

    if (hhmm) {
      event_unix_utc = todayLocalTimeToUnix(hhmm, DAY_TZ);
      if (event_unix_utc) {
        event_utc_hhmm = new Date(event_unix_utc*1000).toISOString().slice(11,16);
      }
    }

    // Ouvrir popover + extraire Supply / Public / Twitter
    let supply = null;
    let public_price_raw = "";
    let chain = "";

    try {
      await p.el.scrollIntoViewIfNeeded?.().catch(()=>{});
      await p.el.click({ delay: 40 }).catch(()=>{});
      await page.waitForTimeout(300);

      // popover probable
      const pop = await page.locator("[role='dialog'], [class*='popover'], [data-radix-popper-content-wrapper]").last();
      if (await pop.count()) {
        const txt = (await pop.innerText()).trim();

        // supply
        // Ex: "3 500" → on prend le + grand nombre raisonnable
        const nums = Array.from(txt.matchAll(/\b[0-9]{2,}(?:\s[0-9]{3})*\b/g)).map(m=>m[0]);
        if (nums.length) {
          // heuristique: le plus grand ressemble souvent à la supply
          supply = digits(nums.sort((a,b)=>digits(b)-digits(a))[0]);
        }

        const price = priceFromPopoverText(txt);
        public_price_raw = price.raw || "";
        chain = price.chainGuess || chain;

        // Twitter
        let twitterUrl = null;
        const link = await pop.locator("a[href*='twitter.com'], a[href*='x.com']").first();
        if (await link.count()) twitterUrl = await link.getAttribute("href");

        items.push({
          project: norm(name),
          mint_raw: hhmm ? `${hhmm} local` : "",   // info panneau (local)
          chain: chain,
          supply: supply,
          public_price_raw: public_price_raw,
          twitter_handle: handleFromUrl(twitterUrl),
          twitter_url: twitterUrl || "",
          scraped_at_unix,
          event_unix_utc,
          event_utc_hhmm
        });
      }
      // fermer popover (Esc / click outside)
      await page.keyboard.press("Escape").catch(()=>{});
      await page.mouse.click(10,10).catch(()=>{});
      await page.waitForTimeout(150);
    } catch (e) {
      console.warn(`popover failed for ${name}:`, e.message);
    }
  }

  // sortie
  const todayUTC = new Date();
  const stamp = `${todayUTC.getUTCFullYear()}${String(todayUTC.getUTCMonth()+1).padStart(2,"0")}${String(todayUTC.getUTCDate()).padStart(2,"0")}`;

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

  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${csvPath}`);
  await browser.close();
})();
