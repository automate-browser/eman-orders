// Odoo JSON-2 posting layer.
// Rules (see CLAUDE.md): invoices with cash rounding "Round to 1 SAR (0.50 up)", payments matched oldest-first (FIFO),
// discounts = credit notes on account 500100 without rounding, every create is idempotent by reference.
const db = require('./db');
const { decrypt } = require('./crypto');

const ODOO_URL = (process.env.ODOO_URL || '').replace(/\/+$/, '');
const ODOO_DB = process.env.ODOO_DB || '';
const EXPECT_COMPANY = process.env.ODOO_EXPECT_COMPANY || '';
const TIMEOUT_MS = Number(process.env.ODOO_TIMEOUT_MS || 45000);

const JOURNAL_CODE = {
  'Cash': 'CSH',
  'SAB bank': 'SAB',
  'Neoleap wallet': 'NEO',
  'HALA bank': 'HALA',
  'Kafeel Al Rajhi': 'KRAJ',
  'Shaikhs bank': 'SHK'
};
const ROUNDING_NAME = 'Round to 1 SAR (0.50 up)';

class OdooError extends Error {
  constructor(message, retryable, status) {
    super(message);
    this.retryable = !!retryable;
    this.status = status || 0;
  }
}

const configured = () => !!(ODOO_URL && ODOO_DB);

// Riyadh calendar date (UTC+3, no daylight saving) of a millisecond timestamp
const ryDate = ms => new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);

async function getUserKey(userId) {
  const r = await db.q('select name, odoo_key_enc from users where id=$1', [userId]);
  if (!r.rows.length) throw new OdooError('The user who made this entry no longer exists', false);
  const key = decrypt(r.rows[0].odoo_key_enc);
  if (!key) throw new OdooError('No Odoo API key saved for ' + r.rows[0].name + '. Add it in Admin > Users, then retry.', false);
  return { name: r.rows[0].name, key };
}

async function rpc(ctx, model, method, body) {
  if (!configured()) throw new OdooError('Odoo address is not set (ODOO_URL / ODOO_DB)', false);
  const url = `${ODOO_URL}/json/2/${model}/${method}`;
  let status = 0;
  let out;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'bearer ' + ctx.key,
        'X-Odoo-Database': ODOO_DB,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    status = res.status;
    const text = await res.text();
    try { out = text ? JSON.parse(text) : null; } catch (e) { out = text; }
    if (!res.ok) {
      const msg = out && typeof out === 'object' ? (out.message || out.name || JSON.stringify(out).slice(0, 300)) : String(out || res.statusText).slice(0, 300);
      const retryable = status >= 500 || status === 429;
      await log(ctx, `${model}/${method}`, body, { status, message: msg }, 'error');
      throw new OdooError(`Odoo said (${status}): ${msg}`, retryable, status);
    }
  } catch (e) {
    if (e instanceof OdooError) throw e;
    const m = e && e.name === 'TimeoutError' ? 'Odoo did not answer in time' : 'Odoo is not reachable (' + (e && e.message ? e.message : e) + ')';
    await log(ctx, `${model}/${method}`, body, { error: m }, 'network');
    throw new OdooError(m, true, 0);
  }
  await log(ctx, `${model}/${method}`, body, out, 'ok');
  return out;
}

async function log(ctx, endpoint, request, response, status) {
  try {
    const clip = v => {
      const s = JSON.stringify(v === undefined ? null : v);
      return s.length > 4000 ? JSON.stringify({ clipped: s.slice(0, 4000) }) : s;
    };
    await db.q('insert into sync_log(t,user_name,endpoint,request,response,status) values($1,$2,$3,$4,$5,$6)',
      [Date.now(), ctx.name || '', endpoint, clip(request), clip(response), status]);
  } catch (e) { /* logging must never break posting */ }
}

// ---- lookups (by code / name, cached; ids differ between demo and live) ----
const cache = { journals: {}, account: null, rounding: null, products: {}, companyOk: false };

async function checkCompany(ctx) {
  if (cache.companyOk || !EXPECT_COMPANY) { cache.companyOk = true; return; }
  const rows = await rpc(ctx, 'res.company', 'search_read', { domain: [], fields: ['name'] });
  const names = (rows || []).map(r => r.name);
  if (!names.includes(EXPECT_COMPANY)) {
    throw new OdooError(`Safety stop: this Odoo database is "${names.join(', ')}", expected "${EXPECT_COMPANY}". Nothing was posted.`, false);
  }
  cache.companyOk = true;
}

async function journalId(ctx, code) {
  if (cache.journals[code]) return cache.journals[code];
  const rows = await rpc(ctx, 'account.journal', 'search_read', { domain: [['code', '=', code]], fields: ['code'], limit: 1 });
  if (!rows || !rows.length) throw new OdooError(`Odoo journal with code ${code} was not found`, false);
  return (cache.journals[code] = rows[0].id);
}

async function salesAccountId(ctx) {
  if (cache.account) return cache.account;
  const rows = await rpc(ctx, 'account.account', 'search_read', { domain: [['code', '=', '500100']], fields: ['code'], limit: 1 });
  if (!rows || !rows.length) throw new OdooError('Odoo account 500100 (Sales Account) was not found', false);
  return (cache.account = rows[0].id);
}

async function roundingId(ctx) {
  if (cache.rounding) return cache.rounding;
  const rows = await rpc(ctx, 'account.cash.rounding', 'search_read', { domain: [['name', '=', ROUNDING_NAME]], fields: ['name'], limit: 1 });
  if (!rows || !rows.length) throw new OdooError(`Odoo cash rounding "${ROUNDING_NAME}" was not found`, false);
  return (cache.rounding = rows[0].id);
}

async function productIds(ctx, codes) {
  const need = codes.filter(c => !cache.products[c]);
  if (need.length) {
    const rows = await rpc(ctx, 'product.product', 'search_read', { domain: [['default_code', 'in', need]], fields: ['default_code'] });
    (rows || []).forEach(r => { cache.products[r.default_code] = r.id; });
  }
  const miss = codes.filter(c => !cache.products[c]);
  if (miss.length) throw new OdooError('Product not found in Odoo: ' + miss.join(', ') + '. Create it in Odoo with the same code, then retry.', false);
  return codes.map(c => cache.products[c]);
}

async function partnerId(ctx, cust) {
  if (cust.odoo_partner_id) return cust.odoo_partner_id;
  const rows = await rpc(ctx, 'res.partner', 'search_read', { domain: [['name', '=', cust.name], ['customer_rank', '>', 0]], fields: ['name'], limit: 3 });
  if (!rows || rows.length !== 1) {
    throw new OdooError(rows && rows.length > 1 ? `More than one Odoo customer is named ${cust.name}` : `Customer not found in Odoo: ${cust.name}`, false);
  }
  await db.q('update customers set odoo_partner_id=$1 where code=$2', [rows[0].id, cust.code]);
  return rows[0].id;
}

// ---- oldest-first matching of a customer's open receivable items ----
async function fifo(ctx, pid) {
  const lines = await rpc(ctx, 'account.move.line', 'search_read', {
    domain: [['account_id.account_type', '=', 'asset_receivable'], ['parent_state', '=', 'posted'], ['reconciled', '=', false], ['partner_id', '=', pid]],
    fields: ['amount_residual', 'date'],
    order: 'date, id'
  });
  if (!lines || lines.length < 2) return 0;
  const hasDebit = lines.some(l => l.amount_residual > 0);
  const hasCredit = lines.some(l => l.amount_residual < 0);
  if (!hasDebit || !hasCredit) return 0;
  await rpc(ctx, 'account.move.line', 'reconcile', { ids: lines.map(l => l.id) });
  return lines.length;
}

async function findOne(ctx, model, domain, fields) {
  const rows = await rpc(ctx, model, 'search_read', { domain, fields, limit: 2, order: 'id' });
  return rows && rows.length ? rows[0] : null;
}

// ---- documents ----
async function postInvoice(ctx, o, cust) {
  await checkCompany(ctx);
  const pid = await partnerId(ctx, cust);
  let move = await findOne(ctx, 'account.move', [['ref', '=', o.id], ['move_type', '=', 'out_invoice'], ['state', '!=', 'cancel']], ['name', 'state', 'amount_total']);
  if (!move) {
    const codes = o.lines.map(l => l.code);
    const [jid, acc, rid, pids] = [await journalId(ctx, 'INV'), await salesAccountId(ctx), await roundingId(ctx), await productIds(ctx, codes)];
    const prodNames = {};
    const pr = await db.q('select code,name from products where code = any($1)', [codes]);
    pr.rows.forEach(r => { prodNames[r.code] = r.name; });
    const d = ryDate(Number(o.created_at));
    const vals = {
      move_type: 'out_invoice',
      partner_id: pid,
      journal_id: jid,
      invoice_date: d,
      date: d,
      ref: o.id,
      invoice_cash_rounding_id: rid,
      narration: `Trays in: ${o.trays_in}, out: ${o.trays_out == null ? 0 : o.trays_out}`,
      invoice_line_ids: o.lines.map((l, i) => [0, 0, {
        product_id: pids[i],
        name: prodNames[l.code] || l.code,
        quantity: l.qty,
        price_unit: Number(l.price),
        account_id: acc,
        tax_ids: [[6, 0, []]]
      }])
    };
    const ids = await rpc(ctx, 'account.move', 'create', { vals_list: [vals] });
    const id = Array.isArray(ids) ? ids[0] : ids;
    move = { id, state: 'draft' };
  }
  if (move.state === 'draft') await rpc(ctx, 'account.move', 'action_post', { ids: [move.id] });
  const rd = await rpc(ctx, 'account.move', 'read', { ids: [move.id], fields: ['name', 'amount_total', 'state'] });
  const m = rd && rd[0] ? rd[0] : move;
  if (m.state && m.state !== 'posted') throw new OdooError(`Invoice ${o.id} is in state ${m.state} in Odoo`, false);
  await fifo(ctx, pid);
  return { moveId: move.id, name: m.name, total: m.amount_total };
}

async function postPayment(ctx, p, cust) {
  await checkCompany(ctx);
  const pid = await partnerId(ctx, cust);
  const code = JOURNAL_CODE[p.method];
  if (!code) throw new OdooError('Unknown payment method: ' + p.method, false);
  let pay = await findOne(ctx, 'account.payment', [['memo', '=', p.id], ['payment_type', '=', 'inbound'], ['state', '!=', 'canceled']], ['name', 'state']);
  if (!pay) {
    const jid = await journalId(ctx, code);
    const ids = await rpc(ctx, 'account.payment', 'create', { vals_list: [{
      payment_type: 'inbound',
      partner_type: 'customer',
      partner_id: pid,
      amount: Number(p.amount_cents) / 100,
      date: p.pdate,
      journal_id: jid,
      memo: p.id
    }] });
    pay = { id: Array.isArray(ids) ? ids[0] : ids, state: 'draft' };
  }
  if (pay.state === 'draft') await rpc(ctx, 'account.payment', 'action_post', { ids: [pay.id] });
  const rd = await rpc(ctx, 'account.payment', 'read', { ids: [pay.id], fields: ['name', 'state'] });
  const m = rd && rd[0] ? rd[0] : pay;
  await fifo(ctx, pid);
  return { id: pay.id, name: m.name };
}

async function postCredit(ctx, c, cust) {
  await checkCompany(ctx);
  const pid = await partnerId(ctx, cust);
  let move = await findOne(ctx, 'account.move', [['ref', '=', c.id], ['move_type', '=', 'out_refund'], ['state', '!=', 'cancel']], ['name', 'state']);
  if (!move) {
    const [jid, acc] = [await journalId(ctx, 'INV'), await salesAccountId(ctx)];
    const d = ryDate(Number(c.t));
    const ids = await rpc(ctx, 'account.move', 'create', { vals_list: [{
      move_type: 'out_refund',
      partner_id: pid,
      journal_id: jid,
      invoice_date: d,
      date: d,
      ref: c.id,
      narration: c.reason + (c.note ? ' - ' + c.note : ''),
      invoice_line_ids: [[0, 0, {
        name: 'Discount',
        quantity: 1,
        price_unit: Number(c.amount_cents) / 100,
        account_id: acc,
        tax_ids: [[6, 0, []]]
      }]]
    }] });
    move = { id: Array.isArray(ids) ? ids[0] : ids, state: 'draft' };
  }
  if (move.state === 'draft') await rpc(ctx, 'account.move', 'action_post', { ids: [move.id] });
  const rd = await rpc(ctx, 'account.move', 'read', { ids: [move.id], fields: ['name'] });
  await fifo(ctx, pid);
  return { id: move.id, name: rd && rd[0] ? rd[0].name : '' };
}

// Cancel a posted payment in Odoo (never delete), then re-match
async function reversePayment(ctx, p, cust) {
  await checkCompany(ctx);
  const pid = await partnerId(ctx, cust);
  const pay = await findOne(ctx, 'account.payment', [['memo', '=', p.id], ['payment_type', '=', 'inbound']], ['state']);
  if (!pay) return { done: false };
  if (pay.state !== 'canceled') {
    if (pay.state === 'paid' || pay.state === 'in_process' || pay.state === 'posted') await rpc(ctx, 'account.payment', 'action_draft', { ids: [pay.id] });
    await rpc(ctx, 'account.payment', 'action_cancel', { ids: [pay.id] });
  }
  await fifo(ctx, pid);
  return { done: true };
}

// ---- admin helpers ----
// Receivable balance per Odoo customer (posted entries)
async function receivableBalances(ctx) {
  const rows = await rpc(ctx, 'account.move.line', 'formatted_read_group', {
    domain: [['parent_state', '=', 'posted'], ['account_id.account_type', '=', 'asset_receivable']],
    groupby: ['partner_id'],
    aggregates: ['balance:sum'],
    limit: 1000
  });
  return (rows || []).filter(r => r.partner_id).map(r => ({ id: r.partner_id[0], name: r.partner_id[1], balance: r['balance:sum'] }));
}

// Highest numbers already used in Odoo so the app continues the sequence
async function lastRefs(ctx) {
  const top = async (model, domain, field) => {
    const rows = await rpc(ctx, model, 'search_read', { domain, fields: [field], order: field + ' desc', limit: 1 });
    return rows && rows[0] ? String(rows[0][field] || '') : '';
  };
  return {
    ord: await top('account.move', [['move_type', '=', 'out_invoice'], ['ref', '=like', 'ORD-%']], 'ref'),
    pay: await top('account.payment', [['payment_type', '=', 'inbound'], ['memo', '=like', 'PAY-%']], 'memo'),
    cn: await top('account.move', [['move_type', '=', 'out_refund'], ['ref', '=like', 'DSC-%']], 'ref')
  };
}

async function ping(ctx) {
  const rows = await rpc(ctx, 'res.company', 'search_read', { domain: [], fields: ['name'] });
  return (rows || []).map(r => r.name);
}

const _resetCache = () => { cache.journals = {}; cache.account = null; cache.rounding = null; cache.products = {}; cache.companyOk = false; };

module.exports = {
  _resetCache, OdooError, configured, ryDate, getUserKey, JOURNAL_CODE, ODOO_URL, ODOO_DB, EXPECT_COMPANY,
  postInvoice, postPayment, postCredit, reversePayment, receivableBalances, lastRefs, ping, rpc
};
