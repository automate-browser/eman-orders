// Builds the snapshot the browser shows. Money: orders in cents, payments/credits in SAR, same as the screens expect.
const db = require('./db');

const FEATURES = ['order_create', 'order_finalize', 'order_cancel', 'order_view', 'payments', 'credit_notes', 'trays_view', 'daily_print', 'customers_view', 'sync_view'];

const state = s => (s === 'queued' || s === 'posted' || s === 'failed' ? s : 'queued');

function orderOut(r, rem) {
  return {
    id: r.id, branch: r.branch, cust: r.cust,
    createdAt: Number(r.created_at), deadline: Number(r.deadline),
    lines: r.lines, traysIn: r.trays_in, traysOut: r.trays_out,
    status: r.status, by: r.by_name, byId: r.by_id,
    inv: r.inv, total: Number(r.total_cents), rounding: r.rounding_cents, rem: rem || 0,
    finalizedAt: r.finalized_at == null ? null : Number(r.finalized_at), finalBy: r.final_by,
    cancelReason: r.cancel_reason,
    odoo: r.odoo_state ? { state: state(r.odoo_state), tries: r.odoo_tries, msg: r.odoo_msg || '' } : null
  };
}

// Oldest-first allocation: credits (payments, discounts, advance) pay the opening balance first, then invoices by date.
function allocate(opening, finals, payCents, credCents) {
  let credit = payCents + credCents + Math.max(-opening, 0);
  let open = Math.max(opening, 0);
  const u0 = Math.min(open, credit);
  open -= u0; credit -= u0;
  const rem = {};
  for (const o of finals) {
    const use = Math.min(Number(o.total_cents), credit);
    credit -= use;
    rem[o.id] = Number(o.total_cents) - use;
  }
  return { open, advance: credit, rem };
}

async function customerLedger() {
  const [cu, os, ps, cs] = await Promise.all([
    db.q('select code, opening_cents from customers'),
    db.q("select id, cust, total_cents, finalized_at from orders where status='final' order by finalized_at, id"),
    db.q('select cust, sum(amount_cents) s from payments where not reversed group by cust'),
    db.q('select cust, sum(amount_cents) s from credits group by cust')
  ]);
  const pay = {}, cred = {}, fin = {};
  ps.rows.forEach(r => { pay[r.cust] = Number(r.s); });
  cs.rows.forEach(r => { cred[r.cust] = Number(r.s); });
  os.rows.forEach(r => { (fin[r.cust] = fin[r.cust] || []).push(r); });
  const out = {};
  cu.rows.forEach(c => {
    out[c.code] = allocate(Number(c.opening_cents), fin[c.code] || [], pay[c.code] || 0, cred[c.code] || 0);
  });
  return out;
}

async function buildState(user) {
  const admin = user.admin;
  const [set, products, customers, prices, orders, payments, credits, trays, audit, users, led] = await Promise.all([
    db.getSettings(),
    db.q('select code,name,cat,ppp,dflt,active from products order by cat, name'),
    db.q('select code,name,opening_cents,active,odoo_partner_id from customers order by name'),
    db.q('select cust,prod,price from customer_prices'),
    db.q('select * from orders order by created_at desc, id desc'),
    db.q('select * from payments where not reversed order by t desc, id desc'),
    db.q('select * from credits order by t desc, id desc'),
    db.q('select id,t,cust,branch,qty,type,ref,by_name,reason from tray_ledger order by id desc'),
    db.q('select id,t,user_name,action,entity,ref,detail from audit order by id desc limit $1', [admin ? 800 : 12]),
    db.q('select id,name,email,admin,active,feat,(odoo_key_enc is not null) has_key from users order by id'),
    customerLedger()
  ]);

  const custom = {};
  prices.rows.forEach(r => { (custom[r.cust] = custom[r.cust] || {})[r.prod] = Number(r.price); });

  return {
    clock: 0,
    session: user.id,
    serverNow: Date.now(),
    users: users.rows.map(u => ({
      id: u.id, name: u.name, email: admin ? u.email : '', admin: u.admin, active: u.active,
      feat: u.feat, key: u.has_key ? 'set' : ''
    })),
    products: products.rows.map(p => ({ code: p.code, name: p.name, cat: p.cat, ppp: p.ppp, dflt: Number(p.dflt), active: p.active })),
    customers: customers.rows.map(c => {
      const l = led[c.code] || { open: 0, advance: 0 };
      return {
        code: c.code, name: c.name, o0: Number(c.opening_cents) / 100,
        open: l.open / 100, advance: l.advance / 100, active: c.active, odooId: c.odoo_partner_id
      };
    }),
    custom,
    orders: orders.rows.map(r => orderOut(r, (led[r.cust] && led[r.cust].rem[r.id]) || 0)),
    payments: payments.rows.map(r => ({
      id: r.id, cust: r.cust, amount: Number(r.amount_cents) / 100, method: r.method, date: r.pdate, note: r.note,
      group: r.grp, groupTotal: Number(r.group_total_cents) / 100, by: r.by_name, t: Number(r.t),
      odoo: { state: state(r.odoo_state), ref: r.odoo_ref || '', msg: r.odoo_msg || '' }
    })),
    credits: credits.rows.map(r => ({
      id: r.id, cust: r.cust, amount: Number(r.amount_cents) / 100, reason: r.reason, note: r.note, by: r.by_name, t: Number(r.t),
      odoo: { state: state(r.odoo_state), ref: r.odoo_ref || '', msg: r.odoo_msg || '' }
    })),
    trays: trays.rows.map(r => ({ id: Number(r.id), t: Number(r.t), cust: r.cust, branch: r.branch, qty: r.qty, type: r.type, ref: r.ref, by: r.by_name, reason: r.reason })),
    audit: audit.rows.map(r => ({ id: Number(r.id), t: Number(r.t), user: r.user_name, action: r.action, entity: r.entity, ref: r.ref, detail: r.detail })),
    set: {
      finalizeMin: set.finalizeMin, autoPrint: set.autoPrint, footer: set.footer, branches: set.branches, offline: set.offline,
      odooUrl: process.env.ODOO_URL || '(not set)', db: process.env.ODOO_DB || '(not set)',
      company: process.env.ODOO_EXPECT_COMPANY || ''
    }
  };
}

module.exports = { buildState, customerLedger, allocate, FEATURES };
