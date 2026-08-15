# token_watchdog

Stop-Loss-Wächter für ein Solana-Wallet: verkauft alle 10 Minuten jede gehaltene
Position, deren **1h-Kursänderung ≤ -10 %** ist (Jupiter Ultra API).

Öffentliches Repo mit Absicht: GitHub-Actions-Minuten sind in öffentlichen Repos
unbegrenzt kostenlos. Der Wallet-Key liegt ausschließlich im Actions-Secret
`FAMILY_WALLET_PRIVATE_KEY` (nicht im Code, nicht einsehbar).

## Setup

1. Secret anlegen: *Settings → Secrets and variables → Actions* →
   `FAMILY_WALLET_PRIVATE_KEY` (optional: `RPC_URL` für einen eigenen RPC).
2. Einmal manuell testen: *Actions → watchdog → Run workflow*.
3. Danach läuft der Cron alle 10 Minuten (GitHub-Jitter: 0–15 min).
   Für Pünktlichkeit optional extern triggern:
   ```
   curl -X POST -H "Authorization: Bearer <PAT>" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/alexrl97/token_watchdog/actions/workflows/watchdog.yml/dispatches \
     -d '{"ref":"main"}'
   ```

Hinweis: Scheduled Workflows in Repos ohne Commit-Aktivität werden nach 60 Tagen
pausiert — gelegentlich committen oder den externen Trigger nutzen.

Lokal: `npm install`, Key in `.env` (`FAMILY_WALLET_PRIVATE_KEY=...`),
`node watchdog.js --check` (nur anzeigen) bzw. `node watchdog.js` (scharf).
