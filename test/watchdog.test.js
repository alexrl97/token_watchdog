/**
 * Watchdog-Regeltests (keine Deps, `npm test`). Testet die reine Verkaufs-Entscheidung
 * sellReason() — die drei Stop-Regeln und ihre Priorität.
 */
const assert = require("assert");
const { sellReason, STOP_M5_PCT, STOP_H1_PCT, TRAIL_DD_PCT } = require("../watchdog");

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

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed ? 1 : 0);
