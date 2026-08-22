/**
 * Watchdog-Regeltests (keine Deps, `npm test`). Testet die reine Verkaufs-Entscheidung
 * sellReason() — die drei Stop-Regeln und ihre Priorität.
 */
const assert = require("assert");
const {
  sellReason,
  panicReason,
  findPanic,
  pruneExited,
  STOP_M5_PCT,
  STOP_H1_PCT,
  TRAIL_DD_PCT,
  PANIC_PCT,
  PANIC_WATCH_MS,
} = require("../watchdog");

let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  ✓ " + name);
    passed++;
  } catch (e) {
    console.log("  ✗ " + name + "\n      " + e.message);
    failed++;
  }
}

console.log("\nwatchdog sellReason — Verkaufs-Regeln");

test("Schwellen wie dokumentiert (5m -10, 1h -10, Trail 15)", () => {
  assert.equal(STOP_M5_PCT, -10);
  assert.equal(STOP_H1_PCT, -10);
  assert.equal(TRAIL_DD_PCT, 15);
});

test("5m <= -10% -> STOP-5M", () => assert.ok(sellReason(-10, 0, 0).startsWith("STOP-5M")));
test("5m knapp über -10% -> kein 5m-Stop", () => assert.ok(!(sellReason(-9.9, 0, 0) || "").startsWith("STOP-5M")));
test("1h <= -10% -> STOP-LOSS", () => assert.ok(sellReason(0, -10, 0).startsWith("STOP-LOSS")));
test("Drawdown vom Hoch <= -15% -> TRAILING-STOP", () => assert.ok(sellReason(0, 0, -15).startsWith("TRAILING-STOP")));
test("alles im grünen Bereich -> null (halten)", () => assert.equal(sellReason(-5, -5, -10), null));
test("null-Werte (kein Datenpunkt) -> kein Fehl-Verkauf", () => assert.equal(sellReason(null, null, 0), null));

test("Priorität: 5m schlägt 1h schlägt Trailing", () => {
  assert.ok(sellReason(-10, -10, -15).startsWith("STOP-5M"));
  assert.ok(sellReason(-5, -10, -15).startsWith("STOP-LOSS"));
  assert.ok(sellReason(-5, -5, -15).startsWith("TRAILING-STOP"));
});

test("KEIN Zu-heiß-Verkauf mehr (Runner dürfen laufen)", () => {
  // Egal wie hoch der Kurs steht: solange keine Stop-Bedingung greift -> halten.
  assert.equal(sellReason(5, 50, 0), null);
});

console.log("\nwatchdog panicReason — Notaus-Schwelle je Position");

test("Notaus-Schwelle ist -50 %", () => assert.equal(PANIC_PCT, -50));
test("5m <= -50% -> NOTAUS", () => assert.ok(panicReason(-50, 0).startsWith("NOTAUS")));
test("1h <= -50% -> NOTAUS", () => assert.ok(panicReason(0, -50).startsWith("NOTAUS")));
test("genau -50% löst aus (<=)", () => assert.ok(panicReason(-50, null)));
test("-49.9% löst NICHT aus", () => assert.equal(panicReason(-49.9, -49.9), null));
test("-10% (normaler Stop) ist KEIN Notaus", () => assert.equal(panicReason(-10, -10), null));
test("null-Werte -> kein Notaus", () => assert.equal(panicReason(null, null), null));

console.log("\nwatchdog findPanic — Portfolio-Notaus-Auswahl");

const rec = (o) => ({ name: "T", m5: null, h1: null, dust: false, fetchOk: true, ...o });

test("gehaltene nicht-Staub-Position <= -50% -> Notaus", () => {
  const hit = findPanic([rec({ name: "A", m5: -5 }), rec({ name: "B", h1: -60 })]);
  assert.ok(hit && hit.rec.name === "B");
});

test("KRITISCH: Staub-Rest eines alten Rugs (-90%) löst NICHTS aus", () => {
  // Genau der Fall 'irgendein random alter Token schmiert ab': bereits verkauft,
  // nur Staub im Wallet -> darf NICHT das ganze Wallet leeren.
  const r = findPanic([rec({ name: "alt-rug", m5: -90, h1: -95, dust: true })]);
  assert.equal(r, null);
});

test("Staub-Rug neben gesunder Position -> kein Notaus", () => {
  const r = findPanic([rec({ name: "alt-rug", m5: -99, dust: true }), rec({ name: "gut", m5: 4, h1: 8 })]);
  assert.equal(r, null);
});

test("Position ohne Kursdaten (fetchOk=false) löst nichts aus", () => {
  const r = findPanic([rec({ name: "kein-preis", m5: -80, fetchOk: false })]);
  assert.equal(r, null);
});

test("gesundes Portfolio -> kein Notaus", () => {
  const r = findPanic([rec({ m5: -5, h1: 2 }), rec({ m5: 10, h1: -8 }), rec({ m5: 0, h1: 0 })]);
  assert.equal(r, null);
});

test("normaler -10%-Dip (Einzel-Stop) löst KEINEN Notaus aus", () => {
  // -10% verkauft nur die eine Position (sellReason), NICHT das ganze Wallet.
  const r = findPanic([rec({ m5: -12, h1: -10 })]);
  assert.equal(r, null);
});

console.log("\nwatchdog findPanic — Nachbeobachtung verkaufter Token");

test("SZENARIO: -10%-Stop, dann Total-Rug -> verkaufter Token löst Notaus aus", () => {
  // gehaltene Restposition ist gesund (-4%), aber der GERADE VERKAUFTE Token ruggt (-70%)
  // -> Notaus. exited-Records tragen dust:false -> zählen als Auslöser.
  const held = rec({ name: "B gehalten", m5: -4, h1: 2 });
  const exitedRug = rec({ name: "A [verkauft]", m5: -70, dust: false });
  const hit = findPanic([held, exitedRug]);
  assert.ok(hit && hit.rec.name === "A [verkauft]", "verkaufter Rug muss auslösen");
});

test("verkaufter Token gesund (kein Rug danach) -> kein Notaus", () => {
  const r = findPanic([rec({ name: "gehalten", m5: 1 }), rec({ name: "A [verkauft]", m5: -8, h1: -5 })]);
  assert.equal(r, null);
});

console.log("\nwatchdog pruneExited — Nachbeobachtung zeitlich begrenzt");

test("Notaus-Fenster ist 5 min", () => assert.equal(PANIC_WATCH_MS, 5 * 60 * 1000));

test("frischer Eintrag (< 5 min) bleibt, alter (> 5 min) fliegt raus", () => {
  const now = 1_000_000_000_000;
  const exited = {
    frisch: { name: "frisch", exitedAt: new Date(now - 2 * 60 * 1000).toISOString() }, // 2 min
    alt: { name: "alt", exitedAt: new Date(now - 10 * 60 * 1000).toISOString() }, // 10 min
  };
  const changed = pruneExited(exited, now, PANIC_WATCH_MS);
  assert.ok(changed);
  assert.ok(exited.frisch && !exited.alt, "nur der alte Eintrag wird entfernt");
});

test("KRITISCH: alter verkaufter Token (> 5 min) wird nicht mehr beobachtet -> kein Fehl-Notaus", () => {
  const now = 1_000_000_000_000;
  const exited = { alt: { name: "alt-rug", exitedAt: new Date(now - 30 * 60 * 1000).toISOString() } }; // 30 min
  pruneExited(exited, now, PANIC_WATCH_MS);
  assert.equal(Object.keys(exited).length, 0);
});

test("pruneExited ohne Änderung -> false", () => {
  const now = 1_000_000_000_000;
  const exited = { a: { name: "a", exitedAt: new Date(now - 60 * 1000).toISOString() } };
  assert.equal(pruneExited(exited, now, PANIC_WATCH_MS), false);
});

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed ? 1 : 0);
