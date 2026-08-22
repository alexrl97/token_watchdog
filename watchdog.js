#!/usr/bin/env node
// Wächter v3: Stop-Loss + TRAILING-STOP (je Position) + PORTFOLIO-NOTAUS.
//   - Stop-Loss:    5m- ODER 1h-Änderung <= -10 %  -> NUR diese Position verkaufen
//                   (Distribution — nicht zwangsläufig ein Rug).
//   - Trailing:     Kurs fällt >= 15 % unter das beobachtete Hoch seit Erstsichtung
//                   -> diese Position verkaufen (Gewinne sichern).
//   - NOTAUS:       bricht IRGENDEINE gehaltene (nicht-Staub) Position ODER ein gerade
//                   erst vom Wächter verkaufter Token um <= -50 % in 5m ODER 1h ein
//                   -> ALLE gehaltenen Positionen sofort verkaufen (korrelierter Meta-Rug).
//
// NACHBEOBACHTUNG (schließt die Lücke "erst -10%-Stop, kurz danach Total-Rug"):
//   Verkauft der Wächter eine Position (Stop/Trailing), merkt er sich den Mint in
//   state.exited und beobachtet ihn PANIC_WATCH_MS (5 min) WEITER. Ruggt der Token
//   danach komplett (<= -50 %), löst er den Notaus für die übrigen Positionen aus —
//   obwohl er schon aus dem Wallet geflogen ist. Nach einem Notaus wird state.exited
//   geleert (einmaliger Trigger, keine Dauerauslösung).
//
// WICHTIG — was den Notaus NICHT auslöst:
//   Nur (a) aktuell GEHALTENE Positionen (per RPC) und (b) vom WÄCHTER SELBST in den
//   letzten 5 min verkaufte Token. Vom Bot regulär (6h-Frist) verkaufte Token und alte/
//   zufällige Token werden NIE nachbeobachtet. Das 5-min-Fenster ist zudem lange abgelaufen,
//   bevor der Bot (kauft nur alle 2h) neue Positionen hält -> FRISCHE KÄUFE werden nie
//   mit-einkassiert. Staub-Reste (< MIN_VALUE_USD) sind vom gehaltenen Trigger ausgenommen.
//
// State (positions.json, vom Workflow committet): { positions: {Trailing-Hoch je gehaltene
// Position}, exited: {Mint -> {name, exitedAt} der zuletzt verkauften} }.
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
const PANIC_PCT = -50; // NOTAUS: Position <= -50 % in 5m ODER 1h -> ALLES verkaufen
// Ein Token, das der WÄCHTER selbst gerade (unter Stress) verkauft hat, wird noch so lange
// weiter beobachtet: ruggt es DANACH komplett (<= PANIC_PCT), löst es den Notaus für die
// übrigen Positionen aus — auch wenn es schon aus dem Wallet geflogen ist. Bewusst KURZ (5 min):
// deckt "kurz nach dem Stop komplett geruggt" ab, ist aber lange abgelaufen, bevor der Bot
// (kauft nur alle 2h) frische Positionen hält -> frische Käufe werden NIE mit-einkassiert.
const PANIC_WATCH_MS = 5 * 60 * 1000; // 5 min
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

/**
 * PURE: entfernt aus `exited` (Mint -> {name, exitedAt}) alle Einträge, deren Verkauf länger
 * als windowMs her ist. Gibt true, wenn etwas entfernt wurde. So bleibt das Nachbeobachten
 * strikt zeitlich begrenzt (kein alter Token kann später fälschlich den Notaus auslösen).
 */
function pruneExited(exited, nowMs, windowMs) {
  let changed = false;
  for (const [mint, r] of Object.entries(exited || {})) {
    const t = r && r.exitedAt ? new Date(r.exitedAt).getTime() : 0;
    if (!(nowMs - t < windowMs)) {
      delete exited[mint];
      changed = true;
    }
  }
  return changed;
}
if (require.main !== module)
  module.exports = { sellReason, panicReason, findPanic, pruneExited, STOP_M5_PCT, STOP_H1_PCT, TRAIL_DD_PCT, PANIC_PCT, PANIC_WATCH_MS };
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const POSITIONS_FILE = path.join(__dirname, "positions.json");

function loadKeypair() {
  const key = process.env.FAMILY_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("FAMILY_WALLET_PRIVATE_KEY fehlt (.env oder Actions-Secret)");
  const decode = typeof bs58.decode === "function" ? bs58.decode : bs58.default.decode;
  return Keypair.fromSecretKey(decode(key.trim()));
}

// State = { positions: {Mint -> Trailing-Hoch der GEHALTENEN}, exited: {Mint -> {name, exitedAt}
// der zuletzt vom Wächter verkauften} }. Migriert das alte flache Format (nur positions).
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
    if (raw && typeof raw === "object" && (raw.positions || raw.exited)) {
      return { positions: raw.positions || {}, exited: raw.exited || {} };
    }
    // Legacy: flache Mint-Map -> als positions übernehmen
    return { positions: raw && typeof raw === "object" ? raw : {}, exited: {} };
  } catch {
    return { positions: {}, exited: {} };
  }
}

function saveState(state) {
  const out = { positions: state.positions || {}, exited: state.exited || {} };
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
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

// Kursdaten eines Mints (name, priceUsd, m5, h1) + fetchOk. Zentral genutzt für gehaltene
// UND nachbeobachtete (bereits verkaufte) Mints.
async function fetchStats(mint) {
  try {
    const list = await fetchJson(`${JUPITER}/tokens/v2/search?query=${mint}`);
    const t = Array.isArray(list) ? list.find((x) => x.id === mint) : null;
    if (t) {
      return {
        name: `${t.name} (${t.symbol})`,
        priceUsd: t.usdPrice || 0,
        m5: t.stats5m && typeof t.stats5m.priceChange === "number" ? t.stats5m.priceChange : null,
        h1: t.stats1h && typeof t.stats1h.priceChange === "number" ? t.stats1h.priceChange : null,
        fetchOk: true,
      };
    }
    return { name: mint, priceUsd: 0, m5: null, h1: null, fetchOk: true };
  } catch {
    return { name: mint, priceUsd: 0, m5: null, h1: null, fetchOk: false };
  }
}

// Preis-Check + ggf. Verkauf. Mutiert state (positions/exited) UND held (Verkauftes wird
// entfernt). Gibt zurück, ob sich der State geändert hat. `quiet` unterdrückt Halte-Zeilen.
async function checkHeld(keypair, held, state, checkOnly, quiet) {
  const positions = state.positions;
  const exited = state.exited;
  let stateChanged = false;
  const nowMs = Date.now();

  // Abgelaufene Nachbeobachtungen entfernen (strikt auf PANIC_WATCH_MS begrenzt)
  if (pruneExited(exited, nowMs, PANIC_WATCH_MS)) stateChanged = true;

  // Trailing-State nicht mehr gehaltener Positionen aufräumen
  const heldMints = new Set(held.map((h) => h.mint));
  for (const mint of Object.keys(positions)) {
    if (!heldMints.has(mint)) {
      delete positions[mint];
      stateChanged = true;
    }
  }

  if (held.length === 0) {
    if (!quiet) console.log(`${new Date().toISOString()} Wächter: keine Positionen.`);
    return stateChanged; // nichts gehalten -> Notaus wäre wirkungslos
  }

  // PASS 1: gehaltene Positionen anreichern + Trailing-Hoch pflegen.
  const enriched = [];
  for (const acc of held) {
    const s = await fetchStats(acc.mint);
    if (!s.fetchOk && !quiet) console.log(`${acc.mint}: Datenabruf fehlgeschlagen — übersprungen`);
    const priceUsd = s.priceUsd;
    const valueUsd = (acc.uiAmount || 0) * priceUsd;
    const dust = valueUsd < MIN_VALUE_USD;
    let ddFromHigh = 0;

    if (s.fetchOk && !dust) {
      if (!positions[acc.mint]) {
        positions[acc.mint] = { name: s.name, firstSeen: new Date().toISOString(), high: priceUsd };
        stateChanged = true;
      }
      const pos = positions[acc.mint];
      if (priceUsd > (pos.high || 0)) {
        if (priceUsd >= (pos.high || 0) * HIGH_PERSIST_STEP) stateChanged = true;
        pos.high = Math.max(pos.high || 0, priceUsd);
      }
      ddFromHigh = pos.high > 0 ? (priceUsd / pos.high - 1) * 100 : 0;
    }

    enriched.push({ acc, name: s.name, m5: s.m5, h1: s.h1, priceUsd, valueUsd, dust, fetchOk: s.fetchOk, ddFromHigh });
  }

  // PASS 1b: kürzlich VOM WÄCHTER verkaufte Mints (nicht mehr gehalten) nachbeobachten.
  // Ruggt so ein Token NACH dem Verkauf (<= -50 %), löst es den Notaus für die übrigen
  // Positionen aus. Dust-Ausnahme gilt hier NICHT — wir wissen, dass diese Mints relevant sind.
  const exitedRecords = [];
  for (const mint of Object.keys(exited)) {
    if (heldMints.has(mint)) continue; // wieder gehalten -> steckt schon in enriched
    const s = await fetchStats(mint);
    exitedRecords.push({ name: `${(exited[mint] && exited[mint].name) || mint} [verkauft]`, m5: s.m5, h1: s.h1, dust: false, fetchOk: s.fetchOk });
  }

  const fmtTag = (r) =>
    `5m: ${r.m5 == null ? "n/a" : r.m5.toFixed(1) + "%"} | ` +
    `1h: ${r.h1 == null ? "n/a" : r.h1.toFixed(1) + "%"}` +
    (r.ddFromHigh != null ? ` | vom Hoch: ${r.ddFromHigh.toFixed(1)}%` : "") +
    (r.valueUsd != null ? ` | ~$${r.valueUsd.toFixed(2)}` : "");

  // Verkauft eine Position; pflegt positions/exited/held/stateChanged. Gibt true bei Erfolg.
  // Ein Verkauf trägt den Mint in `exited` ein -> er wird ab jetzt (PANIC_WATCH_MS lang)
  // nachbeobachtet: ruggt er danach komplett, löst er den Notaus für den Rest aus.
  const doSell = async (acc, name, label) => {
    console.log(`${new Date().toISOString()} ${label}${checkOnly ? " (nur Check)" : ", verkaufe"}`);
    if (checkOnly) return false;
    try {
      const sig = await sellAll(keypair, acc.mint, acc.rawAmount);
      console.log(`  -> verkauft (${sig})`);
      delete positions[acc.mint];
      exited[acc.mint] = { name, exitedAt: new Date().toISOString() };
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

  // NOTAUS (Priorität 1): irgendeine gehaltene (nicht-Staub) ODER kürzlich verkaufte Position
  // <= -50 % in 5m ODER 1h -> ALLE gehaltenen (nicht-Staub-)Positionen sofort verkaufen.
  const panic = findPanic([...enriched, ...exitedRecords]);
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
      await doSell(r.acc, r.name, `NOTAUS-Verkauf ${r.name} | ${fmtTag(r)}`);
    }
    // Nachbeobachtungen leeren (Zweck erfüllt, Portfolio ist flach) — verhindert, dass ein
    // dauerhaft -50%-Token bei jedem Tick erneut auslöst und spätere Käufe sofort dumpt.
    for (const m of Object.keys(exited)) delete exited[m];
    stateChanged = true;
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
    await doSell(r.acc, r.name, `${r.name} | ${fmtTag(r)} — ${reason}`);
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
  const state = loadState();

  if (!(loopSec > 0)) {
    const held = await fetchHeld(connection, keypair);
    if (await checkHeld(keypair, held, state, checkOnly, false)) saveState(state);
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
      if (await checkHeld(keypair, held, state, checkOnly, !refreshed)) saveState(state);
    } catch (err) {
      console.error("Check-Fehler:", err.message);
    }
    if (Date.now() - startMs + intervalSec * 1000 >= loopSec * 1000) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  saveState(state);
  console.log(`Loop beendet nach ${i} Check(s).`);
}

// Nur als Skript ausführen; beim require (Tests) NICHT den Poll-Loop starten.
if (require.main === module) {
  main().catch((err) => {
    console.error("WÄCHTER-FEHLER:", err.message);
    process.exit(1);
  });
}
