# Eman Bakery orders app

Orders, payments, credit notes and trays for Eman Bakery, Jeddah. The app is the working system for orders. Odoo (Accounting only, SAR, no VAT) receives only the final documents: invoices, payments and credit notes.

- Server: Node.js + Express, database: PostgreSQL (Replit's own database)
- Screens: one installable web app (PWA) for desktop, tablet and phone
- Odoo: JSON-2 API, one API key per person so Odoo shows who created each record

## What it does

1. **Create order** (app only): branch, customer, trays brought, products. Changes allowed until finalized. Finalize deadline: 60 minutes (admin can change), never later than midnight.
2. **Finalize**: trays taken back, then the invoice is posted to Odoo with cash rounding "Round to 1 SAR (0.50 up)". The Odoo invoice number is stored on the order.
3. **Payments**: Cash, SAB, Neoleap, HALA, Kafeel Al Rajhi, Shaikhs. One transfer can be split between several customers. Posted at once, matched to the oldest invoices first.
4. **Credit notes** (discounts later): booked to Sales Account 500100, no rounding, matched oldest first.
5. **Trays**: an append-only ledger in the app. Never in Odoo's books (only a text note on the invoice).
6. **Day statement**: one combined sheet per customer per day, invoices and credit notes only.
7. **Safety**: if Odoo is down, finalized items wait in a queue and are retried (nothing is posted twice, because every send first checks Odoo for the same reference). Cancelled orders never go to Odoo. Posted documents are never deleted; a payment is cancelled, a wrong invoice is corrected with a credit note.

## Start on Replit (step by step)

1. Replit: **Create App > Import from GitHub** > choose `automate-browser/eman-orders`.
2. Left side **Tools > PostgreSQL**: create the database (Replit fills `DATABASE_URL` by itself).
3. Open **Secrets** and add (see `.env.example`):
   - `APP_SECRET` (long random text, set once, never change)
   - `ADMIN_PASSWORD` (your first sign-in password)
   - `ODOO_URL`, `ODOO_DB`, `ODOO_EXPECT_COMPANY` (demo values are in `.env.example`)
4. Press **Run**. Sign in as `sales@emanbakeries.com` with `ADMIN_PASSWORD`.
5. **Admin console > Users**: add Alsaman, Sidheek, Jasil, Shinaj (and edit yourself). For each person paste their own Odoo API key and set an app password. Your own user needs your Odoo API key too, because the admin tools use it.
6. **Admin console > Data and Odoo**, in this order:
   1. Choose the starting-data file (`data.json`) to load products, customers and prices.
   2. **Test connection and company name** (must say Eman Bakery Demo).
   3. **Load starting balances from Odoo** (only possible before the first real order).
   4. **Continue numbers from Odoo** (order, payment, credit note).
7. **Admin console > Opening trays**: enter branch stock and the trays each customer holds.
8. Try a few orders, payments and a credit note, then check them in Odoo.
9. Phone or tablet: open the Replit address and choose "Add to Home Screen".

## Going live later

Only when the owner says "go" in words: change `ODOO_URL`, `ODOO_DB`, `ODOO_EXPECT_COMPANY` to the live company, give each user their live Odoo API key in Admin > Users, run step 6 again on a fresh database. Never share keys in chat, files or this repository.

## Never in this repository

API keys, passwords, `.env`, database exports, the `handover/` folder, `data.json`.

## For developers

```
server/      index.js (start), routes.js (API), odoo.js (JSON-2 posting layer), post.js (queue), state.js, db.js, crypto.js
public/      index.html (the whole screen app), sw.js, manifest, icons
test/        run.js (server against a fake Odoo), ui-smoke.js (real browser), mock-odoo.js
scripts/     make-icons.js
```

Tests need a scratch PostgreSQL database whose name contains "test" (the tests empty it):

```
DATABASE_URL=postgresql://user@localhost/emantest PGSSL=off npm test
```

Technical rules are in `CLAUDE.md`. Known limits: the screens load all orders into the browser (fine for the first months; add date windows later), one server instance only.
