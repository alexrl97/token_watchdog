#!/usr/bin/env node
// Wächter v2: Stop-Loss + TRAILING-STOP.
//   - Stop-Loss:    1h-Änderung <= -10 %  -> sofort verkaufen (Distribution/Rug)
//   - Trailing:     Kurs fällt >= 15 % unter das beobachtete Hoch seit Erstsichtung
//                   -> verkaufen (Gewinne sichern, Spitzen nicht zurückgeben)
// Das Hoch je Position wird in positions.json geführt (vom Workflow committet).
//
// Aufruf: node watchdog.js [--check]   (--check: nur anzeigen, nicht verkaufen)
try {
  process.loadEnvFile(require("path").join(__dirname, ".env"));
} catch {}

const fs = require("fs");
const path = require("path");
const { Keypair, Connection, VersionedTransaction } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const bs58 = require("bs58");

const STOP_M5_PCT = -10; // Verkauf: 5m-Änderung <= -10 % (schnellster Dump-Trigger)
const STOP_H1_PCT = -10; // Verkauf: 1h-Änderung <= -10 %
const TRAIL_DD_PCT = 15; // Verkauf: >= 15 % unter dem Hoch seit Erstsichtung
// v3: "Zu-heiß"-Take-Profit. Referenz = Open der ersten AMM-Kerze (Migration), also der
// Wert, den Phantom im Tageschart zeigt (kalibriert: Phantom +95% = +98% ab erster Kerze).
// Ab +250% seit Start gilt der Token als überhitzt/rug-gefährdet -> verkaufen.
const TOO_HOT_MULT = 3.0; // Kurs >= 3.0x der ersten Kerze = +200%
const HIGH_PERSIST_STEP = 1.02; // Hoch erst ab +2 % neu speichern (weniger Commits)
const MIN_VALUE_USD = 0.5; // Staub ignorieren
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER = "https://lite-api.jup.ag";
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const POSITIONS_FILE = path.join(__dirname, "positions.json");

function loadKeypair() {
  const key = process.env.FAMILY_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("FAMILY_WALLET_PRIVATE_KEY fehlt (.env oder Actions-Secret)");
  const decode = typeof bs58.decode === "function" ? bs58.decode : bs58.default.decode;
  return Keypair.fromSecretKey(decode(key.trim()));
}

function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePositions(p) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2) + "\n", "utf8");
}

async function fetchJson(url, opts) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...opts,
    });
    if (res.status === 429 && attempt <= 3) {
      await new Promise((r) => setTimeout(r, attempt * 15000));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  }
}

async function sellAll(keypair, mint, rawAmount) {
  const params = new URLSearchParams({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: String(rawAmount),
    taker: keypair.publicKey.toBase58(),
  });
  const order = await fetchJson(`${JUPITER}/ultra/v1/order?${params}`);
  if (!order.transaction) throw new Error(order.errorMessage || "keine Route");
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([keypair]);
  const result = await fetchJson(`${JUPITER}/ultra/v1/execute`, {
    method: "POST",
    body: JSON.stringify({
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId: order.requestId,
    }),
  });
  if (result.status !== "Success") throw new Error(`Status ${result.status}`);
  return result.signature;
}

// v3: Open der ERSTEN AMM-Kerze (Migrationspreis) = Referenz für "seit Start"-%,
// so wie Phantom es zeigt. Wird pro Position genau EINMAL geholt und in positions.json
// gecached. Gibt Preis oder null (dann bleibt die Zu-heiß-Regel für die Position inaktiv).
async function fetchStartPrice(mint) {
  let pool = null, mig = null;
  try {
    const j = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`).then((r) => r.json());
    if (j && j.pump_swap_pool) pool = j.pump_swap_pool;
  } catch {}
  try {
    const d = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).then((r) => r.json());
    const p = (d.pairs || [])
      .filter((x) => x.chainId === "solana")
      .sort((a, b) => (a.pairCreatedAt || 0) - (b.pairCreatedAt || 0))[0];
    if (p) { if (!pool) pool = p.pairAddress; if (p.pairCreatedAt) mig = Math.floor(p.pairCreatedAt / 1000); }
  } catch {}
  if (!pool) return null;
  try {
    const before = mig ? mig + 3600 : Math.floor(Date.now() / 1000);
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=50&currency=usd&before_timestamp=${before}`;
    const g = await fetch(url, { headers: { Accept: "application/json" } }).then((r) => r.json());
    const list = (((g.data || {}).attributes || {}).ohlcv_list || []).sort((a, b) => a[0] - b[0]);
    return list.length ? list[0][1] : null; // Open der ersten Kerze
  } catch {
    return null;
  }
}

// Gehaltene Positionen per RPC ermitteln (schwerer Call — nur selten aufrufen).
async function fetchHeld(connection, keypair) {
  const held = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId });
    for (const { account } of res.value) {
      const info = account.data.parsed.info;
      if (info.mint !== SOL_MINT && info.tokenAmount.amount !== "0") {
        held.push({
          mint: info.mint,
          rawAmount: info.tokenAmount.amount,
          uiAmount: info.tokenAmount.uiAmount,
        });
      }
    }
  }
  return held;
}

// Preis-Check + ggf. Verkauf für die aktuell bekannten Positionen (leichter Teil,
// nur Jupiter). Mutiert positions UND held (Verkauftes wird entfernt). Gibt zurück,
// ob sich der Trailing-State geändert hat. `quiet` unterdrückt Halte-Zeilen.
async function checkHeld(keypair, held, positions, checkOnly, quiet) {
  let stateChanged = false;

  // State von nicht mehr gehaltenen Positionen aufräumen
  const heldMints = new Set(held.map((h) => h.mint));
  for (const mint of Object.keys(positions)) {
    if (!heldMints.has(mint)) {
      delete positions[mint];
      stateChanged = true;
    }
  }

  if (held.length === 0) {
    if (!quiet) console.log(`${new Date().toISOString()} Wächter: keine Positionen.`);
    return stateChanged;
  }

  // rückwärts iterieren, damit splice bei Verkauf sicher ist
  for (let hi = held.length - 1; hi >= 0; hi--) {
    const acc = held[hi];
    let h1 = null,
      m5 = null,
      priceUsd = 0,
      name = acc.mint;
    try {
      const list = await fetchJson(`${JUPITER}/tokens/v2/search?query=${acc.mint}`);
      const t = Array.isArray(list) ? list.find((x) => x.id === acc.mint) : null;
      if (t) {
        name = `${t.name} (${t.symbol})`;
        priceUsd = t.usdPrice || 0;
        h1 = t.stats1h && typeof t.stats1h.priceChange === "number" ? t.stats1h.priceChange : null;
        m5 = t.stats5m && typeof t.stats5m.priceChange === "number" ? t.stats5m.priceChange : null;
      }
    } catch (err) {
      if (!quiet) console.log(`${acc.mint}: Datenabruf fehlgeschlagen (${err.message}) — übersprungen`);
      continue;
    }

    const valueUsd = (acc.uiAmount || 0) * priceUsd;
    if (valueUsd < MIN_VALUE_USD) {
      if (!quiet) console.log(`${new Date().toISOString()} ${name} | ~$${valueUsd.toFixed(2)} — Staub, ignoriert`);
      continue;
    }

    // Trailing-Hoch führen (Erstsichtung = Basis)
    if (!positions[acc.mint]) {
      positions[acc.mint] = { name, firstSeen: new Date().toISOString(), high: priceUsd };
      stateChanged = true;
    }
    const pos = positions[acc.mint];
    // v3: Referenzpreis (erste AMM-Kerze) genau einmal holen + cachen (max. 3 Versuche).
    if (pos.startPrice === undefined && (pos.startTries || 0) < 3) {
      const sp = await fetchStartPrice(acc.mint);
      if (sp) pos.startPrice = sp;
      else { pos.startTries = (pos.startTries || 0) + 1; if (pos.startTries >= 3) pos.startPrice = null; }
      stateChanged = true;
    }
    if (priceUsd > (pos.high || 0)) {
      // nur in 2%-Schritten persistieren, damit nicht jeder Tick einen Commit erzeugt
      if (priceUsd >= (pos.high || 0) * HIGH_PERSIST_STEP) stateChanged = true;
      pos.high = Math.max(pos.high || 0, priceUsd);
    }
    const ddFromHigh = pos.high > 0 ? (priceUsd / pos.high - 1) * 100 : 0;
    const runupPct = pos.startPrice ? (priceUsd / pos.startPrice - 1) * 100 : null; // seit erster Kerze

    const tag =
      `5m: ${m5 == null ? "n/a" : m5.toFixed(1) + "%"} | ` +
      `1h: ${h1 == null ? "n/a" : h1.toFixed(1) + "%"} | ` +
      `vom Hoch: ${ddFromHigh.toFixed(1)}% | ` +
      `seit Start: ${runupPct == null ? "n/a" : "+" + runupPct.toFixed(0) + "%"} | ~$${valueUsd.toFixed(2)}`;

    let reason = null;
    if (m5 != null && m5 <= STOP_M5_PCT) reason = `STOP-5M (5m ${m5.toFixed(1)}%)`;
    else if (h1 != null && h1 <= STOP_H1_PCT) reason = `STOP-LOSS (1h ${h1.toFixed(1)}%)`;
    else if (ddFromHigh <= -TRAIL_DD_PCT)
      reason = `TRAILING-STOP (${ddFromHigh.toFixed(1)}% vom Hoch)`;
    else if (pos.startPrice && priceUsd >= pos.startPrice * TOO_HOT_MULT)
      reason = `ZU-HEISS (+${runupPct.toFixed(0)}% seit Start)`;

    if (!reason) {
      if (!quiet) console.log(`${new Date().toISOString()} ${name} | ${tag} — hält`);
      continue;
    }
    // Verkaufsgrund wird IMMER geloggt (auch im quiet-Modus)
    console.log(
      `${new Date().toISOString()} ${name} | ${tag} — ${reason}${checkOnly ? " (nur Check)" : ", verkaufe"}`
    );
    if (checkOnly) continue;
    try {
      const sig = await sellAll(keypair, acc.mint, acc.rawAmount);
      console.log(`  -> verkauft (${sig})`);
      delete positions[acc.mint];
      held.splice(hi, 1); // nicht erneut prüfen/verkaufen
      stateChanged = true;
    } catch (err) {
      console.log(`  -> Verkauf fehlgeschlagen: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return stateChanged;
}

// Ein externer Trigger startet EINEN Job, der über WATCHDOG_LOOP_SECONDS hinweg
// alle WATCHDOG_INTERVAL_SECONDS den Preis prüft. Der SCHWERE RPC-Call (gehaltene
// Positionen) läuft nur alle WATCHDOG_RPC_REFRESH_SECONDS — so bleibt der schnelle
// Preis-Check (nur Jupiter) rate-limit-fest. Ohne WATCHDOG_LOOP_SECONDS läuft der
// Wächter wie bisher genau einmal.
async function main() {
  const checkOnly = process.argv.includes("--check");
  const keypair = loadKeypair();
  const connection = new Connection(RPC_URL, "confirmed");
  const loopSec = Number(process.env.WATCHDOG_LOOP_SECONDS || 0);
  const intervalSec = Number(process.env.WATCHDOG_INTERVAL_SECONDS || 20);
  const rpcRefreshMs = Number(process.env.WATCHDOG_RPC_REFRESH_SECONDS || 300) * 1000;
  const positions = loadPositions();

  if (!(loopSec > 0)) {
    const held = await fetchHeld(connection, keypair);
    if (await checkHeld(keypair, held, positions, checkOnly, false)) savePositions(positions);
    return;
  }

  const startMs = Date.now();
  let held = [];
  let lastRpc = 0;
  let i = 0;
  while (Date.now() - startMs < loopSec * 1000) {
    i++;
    // Positionsliste nur selten via RPC auffrischen (schwerer Call)
    let refreshed = false;
    if (Date.now() - lastRpc >= rpcRefreshMs) {
      try {
        held = await fetchHeld(connection, keypair);
        lastRpc = Date.now();
        refreshed = true;
      } catch (err) {
        console.error(`RPC-Refresh fehlgeschlagen (${err.message}) — nutze letzten Stand`);
      }
    }
    if (refreshed) {
      const tSec = Math.round((Date.now() - startMs) / 1000);
      console.log(`--- Check ${i} (t+${tSec}s / ${loopSec}s, alle ${intervalSec}s, ${held.length} Position(en)) ---`);
    }
    try {
      // Halte-Zeilen nur bei RPC-Refresh loggen (sonst würden 20s-Ticks das Log fluten);
      // Verkäufe werden immer geloggt.
      if (await checkHeld(keypair, held, positions, checkOnly, !refreshed)) savePositions(positions);
    } catch (err) {
      console.error("Check-Fehler:", err.message);
    }
    if (Date.now() - startMs + intervalSec * 1000 >= loopSec * 1000) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  savePositions(positions);
  console.log(`Loop beendet nach ${i} Check(s).`);
}

main().catch((err) => {
  console.error("WÄCHTER-FEHLER:", err.message);
  process.exit(1);
});
