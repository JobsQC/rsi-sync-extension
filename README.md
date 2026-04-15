Outreach RSI Sync - extension (Edge / Chrome)

Overview
--------
Small browser extension that collects the visible RSI fleet on a Robertsspaceindustries page and opens Outreach Syndicate with a prefilled payload to sync your fleet.

Important: Edit `manifest.json` and `background.js` to replace `YOUR_SITE_DOMAIN` with your Outreach site origin (e.g. `https://outreach.example`). Also add the exact RSI domain(s) you want the extension to run on in `host_permissions`.

Install (Edge - developer/unpacked)
----------------------------------
1. Open Edge and go to `edge://extensions`.
2. Enable "Developer extensions" (coin en bas à gauche).
3. Click "Load unpacked" and select this folder: `extensions/rsi-sync-extension` from the repository.
4. Confirm the extension appears in the toolbar.

Usage
-----
- Navigate to your RSI fleet page (the page where your ships are listed). Click the extension icon in the toolbar.
- The extension will attempt to detect ships on the page. If it finds them it will open Outreach at `/settings/fleet#rsi=...&auto=1` so Outreach can auto-sync.
- If nothing is detected you'll get a short alert with troubleshooting advice.

Notes
-----
- This extension replaces the previous bookmarklet + manual JSON paste workflow.
- The extension only prepares and opens the Outreach URL; the actual sync is performed by the Outreach client when the page loads (the site decodes the `#rsi` payload and posts to the API while you're logged in).
- For Chrome the steps are identical (chrome://extensions).

Security
--------
- The extension never uploads your fleet to any third-party server; it only opens a local tab to your Outreach site with an encoded payload in the URL fragment.
- Because the payload is placed in the URL fragment it is not sent to Outreach in the initial GET request — the Outreach client decodes it in the browser and posts securely using your session.

Troubleshooting
---------------
- If the extension doesn't detect ships, make sure you're on the RSI page that lists ships (not a commerce or store page). The selectors are heuristic and may require updates depending on RSI page structure.
- If Outreach doesn't auto-sync after the tab opens, log into Outreach in that tab and reload; the client will process the fragment on load.
