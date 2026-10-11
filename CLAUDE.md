# Eman Bakery – rules for Claude (put in repo root)
Read handover/HANDOVER.md first.
- Owner: Shafeeq (sales@emanbakeries.com). Replies: short, plain, no jargon, ALWAYS end with a "Your action" section.
- Odoo 19.4 free plan, Accounting only, SAR, no VAT. Everything free.
- Work on Odoo DEMO ("Eman Bakery Demo") only. LIVE is read-only until he explicitly says go. Confirm company name before write batches.
- NEVER commit API keys / .env / Supabase service keys. Use environment secrets.
- Never write to the production Supabase (dispatch-order7). Read-only.
- Product names/categories: use the Odoo-demo names, map by code PRD-xxx.
- Never claim data matches without a per-customer reconciliation.
- Odoo rules: invoices with cash rounding "Round to 1 SAR (0.50 up)"; payments FIFO oldest-first; discounts = credit notes to 500100; idempotency by ref; trays app-only append-only ledger; branches app-only.
