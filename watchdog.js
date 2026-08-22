#!/usr/bin/env node
// Wächter v3: Stop-Loss + TRAILING-STOP (je Position) + PORTFOLIO-NOTAUS.
//   - Stop-Loss:    5m- ODER 1h-Änderung <= -10 %  -> NUR diese Position verkaufen
//                   (Distribution — nicht zwangsläufig ein Rug).
//   - Trailing:     Kurs fällt >= 15 % unter das beobachtete Hoch seit Erstsichtung
//                   -> diese Position verkaufen (Gewinne sichern).
//   - NOTAUS:       bricht IRGENDEINE gehaltene (nicht-Staub) Position um <= -50 % in
//                   5m ODER 1h ein -> ALLE gehaltenen Positionen sofort verkaufen
//                   (Signal für einen korrelierten Meta-Rug).
//
// WICHTIG — was den Notaus NICHT auslöst:
//   Der Wächter betrachtet AUSSCHLIESSLICH aktuell gehaltene Positionen (per RPC aus
//   dem Wallet). Bereits vom Bot verkaufte Token stehen nicht mehr im Wallet und können
//   daher keinen Notaus auslösen — es wird nur verkauft, wenn ein Token IM Haltefenster
//   ruggt. Staub-Reste bereits verkaufter Rug-Token (< MIN_VALUE_USD) sind vom
//   Notaus-Trigger ausgenommen, damit nicht "irgendein alter Token" das ganze Wallet leert.
//
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

const STOP_M5_PCT = -10; // Einzel-Verkauf: 5m-Änderung <= -10 % (schnellster Dump-Trigger)
const STOP_H1_PCT = -10; // Einzel-Verkauf: 1h-Änderung <= -10 %
const TRAIL_DD_PCT = 15; // Einzel-Verkauf: >= 15 % unter dem Hoch seit Erstsichtung
const PANIC_PCT = -50; // NOTAUS: gehaltene (nicht-Staub) Position <= -50 % in 5m ODER 1h -> ALLES
// Der "Zu-heiß"-Take-Profit wurde ENTFERNT: das Nicht-zu-hoch-Kaufen ist beim Kauf
// gelöst (Runup-Gate ab erster Kerze im Bot), ein Verkaufs-Deckel würde nur die
// seltenen Mega-Runner abschneiden (Fat-Tail-Killer).
const HIGH_PERSIST_STEP = 1.02; // Hoch erst ab +2 % neu speichern (weniger Commits)
const MIN_VALUE_USD = 0.5; // Staub ignorieren
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER = "https://lite-api.jup.ag";

/**
 * PURE Verkaufs-Entscheidung. Reihenfolge = Priorität. Gibt den Grund-String oder null
 * (halten). Ausgelagert, damit die drei Stop-Regeln testbar sind.
 */
function sellReason(m5, h1, ddFromHigh) {
  if (m5 != null && m5 <= STOP_M5_PCT) return `STOP-5M (5m ${m5.toFixed(1)}%)`;
  if (h1 != null && h1 <= STOP_H1_PCT) return `STOP-LOSS (1h ${h1.toFixed(1)}%)`;
  if (ddFromHigh <= -TRAIL_DD_PCT) return `TRAILING-STOP (${ddFromHigh.toFixed(1)}% vom Hoch)`;
  return null;
}

/**
 * PURE Notaus-Entscheidung für EINE Position: bricht sie um <= PANIC_PCT in 5m ODER 1h
 * ein? Gibt den Grund-String oder null.
 */
function panicReason(m5, h1) {
  if (m5 != null && m5 <= PANIC_PCT) return `NOTAUS (5m ${m5.toFixed(1)}%)`;
  if (h1 != null && h1 <= PANIC_PCT) return `NOTAUS (1h ${h1.toFixed(1)}%)`;
  return null;
}

/**
 * PURE Portfolio-Notaus-Auswahl. `records` = angereicherte gehaltene Positionen
 * ({ name, m5, h1, dust, fetchOk }). Liefert den ersten Auslöser oder null.
 * WICHTIG: Staub (dust) und Positionen ohne Kursdaten (fetchOk=false) lösen NICHTS aus —
 * so leert kein alter Rug-Staubrest versehentlich das ganze Wallet.
 */
function findPanic(records) {
  for (const r of records) {
    if (r.dust || !r.fetchOk) continue;
    const reason = panicReason(r.m5, r.h1);
    if (reason) return { rec: r, reason };
  }
  return null;
}
if (require.main !== module)
  module.exports = { sellReason, panicReason, findPanic, STOP_M5_PCT, STOP_H1_PCT, TRAIL_DD_PCT, PANIC_PCT };
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

  // PASS 1: Für jede gehaltene Position Kursdaten holen und (bei nicht-Staub) das
  // Trailing-Hoch pflegen. Ergebnis ist eine angereicherte Liste, auf der DANACH
  // erst der Portfolio-Notaus und dann die Einzel-Stops entscheiden.
  const enriched = [];
  for (const acc of held) {
    let h1 = null,
      m5 = null,
      priceUsd = 0,
      name = acc.mint,
      fetchOk = false;
    try {
      const list = await fetchJson(`${JUPITER}/tokens/v2/search?query=${acc.mint}`);
      const t = Array.isArray(list) ? list.find((x) => x.id === acc.mint) : null;
      if (t) {
        name = `${t.name} (${t.symbol})`;
        priceUsd = t.usdPrice || 0;
        h1 = t.stats1h && typeof t.stats1h.priceChange === "number" ? t.stats1h.priceChange : null;
        m5 = t.stats5m && typeof t.stats5m.priceChange === "number" ? t.stats5m.priceChange : null;
      }
      fetchOk = true;
    } catch (err) {
      if (!quiet) console.log(`${acc.mint}: Datenabruf fehlgeschlagen (${err.message}) — übersprungen`);
    }

    const valueUsd = (acc.uiAmount || 0) * priceUsd;
    const dust = valueUsd < MIN_VALUE_USD;
    let ddFromHigh = 0;

    // Trailing-Hoch nur für echte (nicht-Staub, mit Kursdaten) Positionen führen.
    if (fetchOk && !dust) {
      if (!positions[acc.mint]) {
        positions[acc.mint] = { name, firstSeen: new Date().toISOString(), high: priceUsd };
        stateChanged = true;
      }
      const pos = positions[acc.mint];
      if (priceUsd > (pos.high || 0)) {
        // nur in 2%-Schritten persistieren, damit nicht jeder Tick einen Commit erzeugt
        if (priceUsd >= (pos.high || 0) * HIGH_PERSIST_STEP) stateChanged = true;
        pos.high = Math.max(pos.high || 0, priceUsd);
      }
      ddFromHigh = pos.high > 0 ? (priceUsd / pos.high - 1) * 100 : 0;
    }

    enriched.push({ acc, name, m5, h1, priceUsd, valueUsd, dust, fetchOk, ddFromHigh });
  }

  const fmtTag = (r) =>
    `5m: ${r.m5 == null ? "n/a" : r.m5.toFixed(1) + "%"} | ` +
    `1h: ${r.h1 == null ? "n/a" : r.h1.toFixed(1) + "%"} | ` +
    `vom Hoch: ${r.ddFromHigh.toFixed(1)}% | ~$${r.valueUsd.toFixed(2)}`;

  // Verkauft eine Position; pflegt positions/held/stateChanged. Gibt true bei Erfolg.
  const doSell = async (acc, label) => {
    console.log(`${new Date().toISOString()} ${label}${checkOnly ? " (nur Check)" : ", verkaufe"}`);
    if (checkOnly) return false;
    try {
      const sig = await sellAll(keypair, acc.mint, acc.rawAmount);
      console.log(`  -> verkauft (${sig})`);
      delete positions[acc.mint];
      const idx = held.indexOf(acc);
      if (idx >= 0) held.splice(idx, 1);
      stateChanged = true;
      await new Promise((r) => setTimeout(r, 500));
      return true;
    } catch (err) {
      console.log(`  -> Verkauf fehlgeschlagen: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500));
      return false;
    }
  };

  // NOTAUS (Priorität 1): bricht IRGENDEINE gehaltene, nicht-Staub-Position um <= -50 %
  // in 5m ODER 1h ein -> ALLE (nicht-Staub-)Positionen sofort verkaufen. Staub und
  // Positionen ohne Kursdaten lösen NICHTS aus (findPanic filtert das).
  const panic = findPanic(enriched);
  if (panic) {
    console.log(
      `${new Date().toISOString()} !!! NOTAUS !!! Auslöser: ${panic.rec.name} | ${fmtTag(panic.rec)} ` +
        `— ${panic.reason} -> ALLE Positionen verkaufen`
    );
    // Über eine Kopie iterieren, weil doSell aus `held` splict.
    for (const r of enriched.slice()) {
      if (r.dust) {
        if (!quiet) console.log(`${new Date().toISOString()} ${r.name} | ~$${r.valueUsd.toFixed(2)} — Staub, übersprungen`);
        continue;
      }
      await doSell(r.acc, `NOTAUS-Verkauf ${r.name} | ${fmtTag(r)}`);
    }
    return stateChanged;
  }

  // EINZEL-STOPS (Priorität 2): je Position 5m/1h/Trailing prüfen.
  for (const r of enriched) {
    if (!r.fetchOk) continue; // Fehler schon in Pass 1 geloggt
    if (r.dust) {
      if (!quiet) console.log(`${new Date().toISOString()} ${r.name} | ~$${r.valueUsd.toFixed(2)} — Staub, ignoriert`);
      continue;
    }
    const reason = sellReason(r.m5, r.h1, r.ddFromHigh);
    if (!reason) {
      if (!quiet) console.log(`${new Date().toISOString()} ${r.name} | ${fmtTag(r)} — hält`);
      continue;
    }
    // Verkaufsgrund wird IMMER geloggt (auch im quiet-Modus)
    await doSell(r.acc, `${r.name} | ${fmtTag(r)} — ${reason}`);
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

// Nur als Skript ausführen; beim require (Tests) NICHT den Poll-Loop starten.
if (require.main === module) {
  main().catch((err) => {
    console.error("WÄCHTER-FEHLER:", err.message);
    process.exit(1);
  });
}
