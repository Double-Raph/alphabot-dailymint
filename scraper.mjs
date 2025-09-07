// scraper.mjs
import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const URL = "https://www.alphabot.app/projects";

// mapping chaînes → symboles monnaie
const CHAIN_MAP = {
  solana: { symbol: "◎" },
  ethereum: { symbol: "Ξ" },
  bitcoin: { symbol: "₿" },
  hyperliquidx: { symbol: "HYP" },
  hyperliquid: { symbol: "HYP" },
  base: { symbol: "BASE" },
  blast: { symbol: "BLAST" },
  arbitrum: { symbol: "ARB" },
  polygon: { symbol: "MATIC" },
  sei: { symbol: "SEI" },
  sui: { symbol: "SUI" },
  avalanche: { symbol: "AVAX" },
  monad: { symbol: "MON" },
  abstract: { symbol: "ABS" }
};

const todayUTC = new Date();
const Y = todayUTC.getUTCFullYear();
const M = String(todayUTC.getUTCMonth() + 1).padStart(2, "0");
const D = String(todayUTC.getUTCDate()).padStart(2, "0");
const stamp = `${Y}${M}${D}`;

// helpers
const norm = (s) => (s || "").toString().trim();
const onlyDigits = (s) => {
  const m = norm(s).replace(/[^\d]/g, "");
  return m ? parseInt(m, 10) : null;
};
const safeChain = (s) => {
  s = norm(s).toLowerCase();
  const alias = {
    eth: "ethereum",
    btc: "bitcoin",
    sol: "solana",
    hyperliquid: "hyperliquidx",
    "abstract chain": "abstract"
  };
  return alias[s] || s;
};
const handleFromUrl = (u) => {
  if (!u) return null;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (!/x\.com|twitter\.com/.test(host)) return null;
    const h = url.pathname.replaceAll("/", "").trim();
    return h ? `@${h}` : null;
  } catch {
    return null;
  }
};
const timeToUnixUTC = (hhmm) => {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [hh, mm] = hhmm.split(":").map(Number);
  const dt = new Date(Date.UTC(
    todayUTC.getUTCFullYear(),
    todayUTC.getUTCMonth(),
    todayUTC.getUTCDate(),
    hh, mm, 0
  ));
  return Math.floor(dt.getTime() / 1000);
};
const hhmmFromText = (text) => {
  const m = norm(text).match(/([01]?\d|2[0-3]):[0-5]\d/);
  return m ? m[0] : null;
};
const priceFormat = (amountStr, chainKey) => {
  const sym = (CHAIN_MAP[chainKey]?.symbol) || chainKey?.toUpperCase() || "";
  if (!amountStr) return `TBA ${sym}`.trim();
  const lower = amountStr.toLowerCase();
  if (["tba", "n/a", "na"].includes(lower)) return `TBA ${sym}`.trim();
  if (["free", "0", "0.0"].includes(lower)) return `0 ${sym}`.trim();
  // Si amountStr contient déjà un symbole, garde tel quel
  if (/[◎Ξ₿]/.test(amountStr)) return amountStr;
  // Sinon compose
  return `${amountStr} ${sym}`.trim();
};

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });

  // 1) Essaye d'intercepter les réponses API (si la page charge /projects via fetch)
  const apiPayloads = [];
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (url.includes("api.alphabot.app") && /projects/i.test(url) && res.ok()) {
        const contentType = res.headers()["content-type"] || "";
        if (contentType.includes("application/json")) {
          const json = await res.json();
          apiPayloads.push(json);
        }
      }
    } catch {}
  });

  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });

  // Attends un peu pour laisser le JS charger
  await page.waitForTimeout(3000);

  // 2) Si on a des payloads API, tente d'en extraire des projets
  let items = [];
  for (const pl of apiPayloads) {
    const arr = Array.isArray(pl?.data) ? pl.data : (Array.isArray(pl) ? pl : []);
    for (const it of arr) {
      const name = norm(it.name || it.projectName || it.title);
      const chain = safeChain(it.chain || it.network || it.blockchain);
      const twitterUrl = norm(
        it.twitter || it.x || it.twitterUrl || it?.socials?.twitter || ""
      );
      const handle = handleFromUrl(twitterUrl);
      const rawTime = it.mintAt || it.mintDate || it.publicAt || it.firstPhaseAt || null;
      let ts = null, hhmm = null;
      if (rawTime) {
        const dt = new Date(rawTime);
        if (!isNaN(dt.getTime())) {
          ts = Math.floor(new Date(
            Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), dt.getUTCHours(), dt.getUTCMinutes(), 0)
          ).getTime() / 1000);
          hhmm = String(dt.getUTCHours()).padStart(2, "0") + ":" + String(dt.getUTCMinutes()).padStart(2, "0");
        }
      }
      const supply = it.supply || it.publicSupply || it.maxSupply || null;
      let priceStr = null;
      const priceCand = it.publicPrice ?? it.price ?? it.mintPrice ?? null;
      if (priceCand != null) {
        priceStr = String(priceCand);
      }
      items.push({
        project: name || "TBA",
        chain: chain || "unknown",
        utc_time: hhmm,
        timestamp_utc: ts,
        public_price: priceFormat(priceStr, chain),
        supply: supply != null ? Number(String(supply).replace(/[^\d]/g, "")) : null,
        twitter_handle: handle,
        twitter_url: twitterUrl || null,
        _source: "api"
      });
    }
  }

  // 3) Fallback DOM + clic si API vide ou incomplète
  if (items.length === 0) {
    // Optionnel: scroll pour charger plus de cartes
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(600);
    }

    // Heuristique de sélection des cartes
    const cardLoc = page.locator("a, div").filter({ hasText: /Supply|Price|Mint|Public/i }).first();
    // On essaie plutôt de récupérer une liste de liens cliquables de projet
    const linkCandidates = await page.$$(`a[href*="/"]`);

    const seen = new Set();
    for (const link of linkCandidates) {
      try {
        const href = await link.getAttribute("href");
        if (!href || seen.has(href)) continue;
        seen.add(href);

        // Ouvre la fiche projet dans le même onglet
        await Promise.all([
          page.waitForLoadState("networkidle", { timeout: 60000 }),
          link.click()
        ]);

        // Extrait infos visibles
        const data = await page.evaluate(() => {
          const Q = (sel) => document.querySelector(sel);
          const qt = (sel) => Q(sel)?.textContent?.trim() || "";
          const findText = (rgx) => {
            const all = Array.from(document.querySelectorAll("body *"));
            for (const el of all) {
              const t = (el.textContent || "").trim();
              if (rgx.test(t)) return t;
            }
            return "";
          };
          const name = qt("h1, h2, [data-project-name]") || findText(/Project|Name/i);
          const priceText = findText(/Price|Public/i);
          const supplyText = findText(/Supply/i);
          const timeText = findText(/UTC|Mint|Time|Public/i);
          const chainText = findText(/Solana|Ethereum|Bitcoin|Hyperliquid|Base|Blast|Arbitrum|Polygon|Sei|Sui|Avalanche|Monad|Abstract/i);
          const twitterA = document.querySelector("a[href*='x.com'], a[href*='twitter.com']");
          return {
            name, priceText, supplyText, timeText, chainText,
            twitter: twitterA ? twitterA.href : ""
          };
        });

        const chainKey = safeChain(data.chainText || "");
        const hhmm = hhmmFromText(data.timeText || "");
        const ts = hhmm ? timeToUnixUTC(hhmm) : null;
        const handle = handleFromUrl(data.twitter);

        const item = {
          project: norm(data.name) || "TBA",
          chain: chainKey || "unknown",
          utc_time: hhmm,
          timestamp_utc: ts,
          public_price: priceFormat(norm(data.priceText).replace(/.*?:/,"").trim(), chainKey),
          supply: onlyDigits(data.supplyText),
          twitter_handle: handle,
          twitter_url: data.twitter || null,
          _source: "dom"
        };
        // Filtre minimal: garder ceux avec un semblant d'info
        if (item.project && (item.utc_time || item.public_price || item.supply || item.twitter_url)) {
          items.push(item);
        }

        // Retour à la liste
        await page.goBack({ waitUntil: "networkidle" });
        await page.waitForTimeout(400);
      } catch {
        // ignore carte cassée
      }
    }
  }

  // 4) Garde uniquement "aujourd'hui UTC" si timestamp trouvé, sinon laisse tout pour révision manuelle
  const startUTC = Date.UTC(Y, todayUTC.getUTCMonth(), todayUTC.getUTCDate(), 0, 0, 0) / 1000;
  const endUTC = startUTC + 86400;
  const todayItems = items.filter(it => !it.timestamp_utc || (it.timestamp_utc >= startUTC && it.timestamp_utc < endUTC));

  // 5) Normalisations finales
  const final = todayItems.map(it => {
    const c = safeChain(it.chain);
    const sym = CHAIN_MAP[c]?.symbol || c.toUpperCase();
    let price = it.public_price;
    if (!price || /^tba/i.test(price)) price = `TBA ${sym}`;
    // harmonise handle
    let handle = it.twitter_handle;
    if (!handle && it.twitter_url) handle = handleFromUrl(it.twitter_url);
    return {
      project: it.project,
      chain: c || "unknown",
      utc_time: it.utc_time || null,
      timestamp_utc: it.timestamp_utc || null,
      public_price: price,
      supply: it.supply ?? null,
      twitter_handle: handle || null,
      twitter_url: it.twitter_url || null
    };
  });

  await browser.close();

  // 6) Sorties JSON + CSV
  const outDir = path.join(process.cwd(), "out");
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, `dailymint_${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(final, null, 2), "utf-8");

  const csvPath = path.join(outDir, `dailymint_${stamp}.csv`);
  const header = ["project","chain","utc_time","timestamp_utc","public_price","supply","twitter_handle","twitter_url"];
  const csv = [
    header.join(","),
    ...final.map(x => header.map(k => {
      const v = x[k] == null ? "" : String(x[k]).replace(/"/g, '""');
      return /[,"\n]/.test(v) ? `"${v}"` : v;
    }).join(","))
  ].join("\n");
  fs.writeFileSync(csvPath, csv, "utf-8");

  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${csvPath}`);
}

scrape().catch(err => {
  console.error(err);
  process.exit(1);
});
