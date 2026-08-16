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

const STOP_H1_PCT = -10; // Verkauf: 1h-Änderung <= -10 %
const TRAIL_DD_PCT = 15; // Verkauf: >= 15 % unter dem Hoch seit Erstsichtung
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

async function main() {
  const checkOnly = process.argv.includes("--check");
  const keypair = loadKeypair();
  const connection = new Connection(RPC_URL, "confirmed");
  const positions = loadPositions();
  let stateChanged = false;

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

  // State von nicht mehr gehaltenen Positionen aufräumen
  const heldMints = new Set(held.map((h) => h.mint));
  for (const mint of Object.keys(positions)) {
    if (!heldMints.has(mint)) {
      delete positions[mint];
      stateChanged = true;
    }
  }

  if (held.length === 0) {
    console.log(`${new Date().toISOString()} Wächter: keine Positionen.`);
    if (stateChanged) savePositions(positions);
    return;
  }

  for (const acc of held) {
    let h1 = null,
      priceUsd = 0,
      name = acc.mint;
    try {
      const list = await fetchJson(`${JUPITER}/tokens/v2/search?query=${acc.mint}`);
      const t = Array.isArray(list) ? list.find((x) => x.id === acc.mint) : null;
      if (t) {
        name = `${t.name} (${t.symbol})`;
        priceUsd = t.usdPrice || 0;
        h1 = t.stats1h && typeof t.stats1h.priceChange === "number" ? t.stats1h.priceChange : null;
      }
    } catch (err) {
      console.log(`${acc.mint}: Datenabruf fehlgeschlagen (${err.message}) — übersprungen`);
      continue;
    }

    const valueUsd = (acc.uiAmount || 0) * priceUsd;
    if (valueUsd < MIN_VALUE_USD) {
      console.log(`${new Date().toISOString()} ${name} | ~$${valueUsd.toFixed(2)} — Staub, ignoriert`);
      continue;
    }

    // Trailing-Hoch führen (Erstsichtung = Basis)
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
    const ddFromHigh = pos.high > 0 ? (priceUsd / pos.high - 1) * 100 : 0;

    const tag =
      `1h: ${h1 == null ? "n/a" : h1.toFixed(1) + "%"} | ` +
      `vom Hoch: ${ddFromHigh.toFixed(1)}% | ~$${valueUsd.toFixed(2)}`;

    let reason = null;
    if (h1 != null && h1 <= STOP_H1_PCT) reason = `STOP-LOSS (1h ${h1.toFixed(1)}%)`;
    else if (ddFromHigh <= -TRAIL_DD_PCT)
      reason = `TRAILING-STOP (${ddFromHigh.toFixed(1)}% vom Hoch)`;

    if (!reason) {
      console.log(`${new Date().toISOString()} ${name} | ${tag} — hält`);
      continue;
    }
    console.log(
      `${new Date().toISOString()} ${name} | ${tag} — ${reason}${checkOnly ? " (nur Check)" : ", verkaufe"}`
    );
    if (checkOnly) continue;
    try {
      const sig = await sellAll(keypair, acc.mint, acc.rawAmount);
      console.log(`  -> verkauft (${sig})`);
      delete positions[acc.mint];
      stateChanged = true;
    } catch (err) {
      console.log(`  -> Verkauf fehlgeschlagen: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (stateChanged) savePositions(positions);
}

main().catch((err) => {
  console.error("WÄCHTER-FEHLER:", err.message);
  process.exit(1);
});
