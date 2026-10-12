// End-to-end check of the server against a fake Odoo. Needs a PostgreSQL database:
//   DATABASE_URL=postgres://... PGSSL=off npm test
// WARNING: this empties the database named in DATABASE_URL. Use a scratch database only.
if (!/test/i.test(process.env.DATABASE_URL || '') && process.env.ALLOW_WIPE !== 'yes') {
  console.error('Refusing to run: this test EMPTIES the database. Use a scratch database whose name contains "test".');
  process.exit(2);
}

process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-test-secret-1234';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ODOO_URL = 'http://127.0.0.1:54700';
process.env.ODOO_DB = 'demo';
process.env.ODOO_EXPECT_COMPANY = 'Eman Bakery Demo';
process.env.PORT = '54701';
process.env.PGSSL = 'off';

const assert = require('assert');
const { createMock } = require('./mock-odoo');

const base = 'http://127.0.0.1:54701';
let pass = 0;
const ok = (name, fn) => fn().then(() => { pass++; console.log('  ok  ' + name); }, e => { console.error('FAIL ' + name + '\n     ' + (e && e.message || e)); process.exitCode = 1; });

async function call(method, path, body, cookie) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (email, password) => (await call('POST', '/api/login', { email, password })).cookie;

(async () => {
  const db = require('../server/db');
  await db.q('drop schema public cascade; create schema public;');
  const mock = createMock();
  await mock.listen(54700);
  const { main } = require('../server/index');
  await main();

  const M = mock.st;
  M.partners = [{ id: 501, name: 'CUST A' }, { id: 502, name: 'CUST B' }, { id: 503, name: 'CUST C' }];
  M.products = [{ id: 11, default_code: 'PRD-001' }, { id: 12, default_code: 'PRD-002' }, { id: 13, default_code: 'PRD-003' }];
  M.lines.push({ id: 1, partner_id: 501, date: '2026-10-10', amount_residual: 150, parent_state: 'posted', reconciled: false });

  const admin = await login('admin@test.local', 'admin-pass-123');
  let sidheek;

  console.log('setup');
  await ok('wrong password is refused', async () => {
    const r = await call('POST', '/api/login', { email: 'admin@test.local', password: 'nope' });
    assert.equal(r.status, 401);
  });
  await ok('state needs sign in', async () => assert.equal((await call('GET', '/api/state')).status, 401));
  await ok('starting data loads', async () => {
    const r = await call('POST', '/api/admin/import', {
      P: [['PRD-001', 'CHAPATHI 25', 'CHAPATHI', 25, 4.5], ['PRD-002', 'BURGER 10', 'BURGER', 10, 2.0], ['PRD-003', 'SAMOULI 6', 'SAMOULI', 6, 1.25]],
      C: [['SLM-001', 'CUST A', 0], ['SLM-002', 'CUST B', 0], ['SLM-003', 'CUST C', 0]],
      X: { 'SLM-001': { 'PRD-001': 4.2 } }
    }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.prices, 1);
  });
  await ok('user with Odoo key is created; key is not returned', async () => {
    const r = await call('POST', '/api/admin/users', { name: 'Sidheek', email: 'sidheek@test.local', password: 'sidheek-pass', key: 'key-sidheek', feat: ['order_create', 'order_finalize', 'order_cancel', 'payments', 'credit_notes', 'trays_view', 'sync_view'] }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    sidheek = await login('sidheek@test.local', 'sidheek-pass');
    const st = (await call('GET', '/api/state', null, sidheek)).body;
    assert(!JSON.stringify(st).includes('key-sidheek'));
    assert(!JSON.stringify(st).includes('pw_hash'));
  });
  await ok('admin user needs its own key for Odoo tools', async () => {
    const r = await call('POST', '/api/admin/odoo/test', {}, admin);
    assert.equal(r.status, 400);
    assert(/No Odoo API key/.test(r.body.error));
    await call('PUT', '/api/admin/users/1', { name: 'Shafeeq', email: 'admin@test.local', admin: true, active: true, feat: [], key: 'key-shafeeq' }, admin);
    const r2 = await call('POST', '/api/admin/odoo/test', {}, admin);
    assert.equal(r2.status, 200);
    assert(r2.body.ok);
  });
  await ok('safety stop when the Odoo company is not the expected one', async () => {
    M.company = 'Eman Bakery LIVE';
    const r = await call('POST', '/api/admin/odoo/test', {}, admin);
    assert.equal(r.body.ok, false);
    M.company = 'Eman Bakery Demo';
  });
  await ok('starting balances come from Odoo by customer name', async () => {
    const r = await call('POST', '/api/admin/odoo/balances', {}, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.matched, 1);
    const st = (await call('GET', '/api/state', null, admin)).body;
    assert.equal(st.customers.find(c => c.code === 'SLM-001').open, 150);
  });
  await ok('numbers continue after the last ones in Odoo', async () => {
    M.moves.push({ id: 1, move_type: 'out_invoice', ref: 'ORD-016743', state: 'posted' });
    M.payments.push({ id: 1, memo: 'PAY-004214', state: 'paid' });
    M.moves.push({ id: 2, move_type: 'out_refund', ref: 'DSC-000702', state: 'posted' });
    const r = await call('POST', '/api/admin/odoo/numbers', {}, admin);
    assert.equal(r.body.ord.next, 16744);
    assert.equal(r.body.pay.next, 4215);
    assert.equal(r.body.cn.next, 703);
  });

  console.log('orders and trays');
  await call('POST', '/api/admin/trays/branch', { branch: 'Hira Branch', qty: 100 }, admin);
  await call('POST', '/api/admin/trays/customer', { cust: 'SLM-001', qty: 10 }, admin);
  let ord;
  await ok('create order: server prices it, takes trays, no Odoo yet', async () => {
    const r = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-001', traysIn: 4, lines: [{ code: 'PRD-001', qty: 10 }, { code: 'PRD-002', qty: 3 }] }, sidheek);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ord = r.body.id;
    assert.equal(ord, 'ORD-016744');
    assert(!M.moves.some(m => m.ref === ord));
    const st = (await call('GET', '/api/state', null, sidheek)).body;
    const o = st.orders.find(x => x.id === ord);
    assert.equal(o.lines.find(l => l.code === 'PRD-001').price, 4.2, 'custom price used');
    assert.equal(o.lines.find(l => l.code === 'PRD-002').price, 2, 'default price used');
    assert.equal(st.trays.filter(t => t.cust === 'SLM-001').reduce((a, t) => a + t.qty, 0), 6);
    assert(o.deadline - o.createdAt <= 60 * 60000);
  });
  await ok('cannot bring more trays than the customer holds', async () => {
    const r = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-001', traysIn: 7, lines: [{ code: 'PRD-001', qty: 1 }] }, sidheek);
    assert.equal(r.status, 400);
  });
  await ok('edit order before finalizing; trays follow', async () => {
    const r = await call('PUT', '/api/orders/' + ord, { traysIn: 5, lines: [{ code: 'PRD-001', qty: 10 }, { code: 'PRD-002', qty: 3 }, { code: 'PRD-003', qty: 4 }] }, sidheek);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = (await call('GET', '/api/state', null, sidheek)).body;
    assert.equal(st.trays.filter(t => t.cust === 'SLM-001').reduce((a, t) => a + t.qty, 0), 5);
  });
  await ok('trays out cannot exceed branch stock', async () => {
    const r = await call('POST', '/api/orders/' + ord + '/finalize', { traysOut: 5000 }, sidheek);
    assert.equal(r.status, 400);
  });
  await ok('finalize posts the invoice as the user, with rounding, ref, narration, no tax', async () => {
    const r = await call('POST', '/api/orders/' + ord + '/finalize', { traysOut: 6 }, sidheek);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.odoo, 'posted');
    const mv = M.moves.find(m => m.ref === ord);
    assert.equal(mv.createdBy, 'Sidheek');
    assert.equal(mv.move_type, 'out_invoice');
    assert.equal(mv.journal_id, 9);
    assert.equal(mv.invoice_cash_rounding_id, 1);
    assert.equal(mv.narration, 'Trays in: 5, out: 6');
    assert.equal(mv.invoice_date, mv.date);
    assert.equal(mv.invoice_line_ids.length, 3);
    assert(mv.invoice_line_ids.every(l => l[2].account_id === 270 && l[2].tax_ids[0][2].length === 0 && l[2].name));
    // 10*4.2 + 3*2 + 4*1.25 = 53.00
    assert.equal(mv.amount_total, 53);
    const st = (await call('GET', '/api/state', null, sidheek)).body;
    const o = st.orders.find(x => x.id === ord);
    assert.equal(o.status, 'final');
    assert.equal(o.inv, mv.name);
    assert.equal(o.total, 5300);
    assert.equal(o.odoo.state, 'posted');
  });
  await ok('a finalized order cannot be edited or cancelled', async () => {
    assert.equal((await call('PUT', '/api/orders/' + ord, { traysIn: 0, lines: [{ code: 'PRD-001', qty: 1 }] }, sidheek)).status, 400);
    assert.equal((await call('POST', '/api/orders/' + ord + '/cancel', { reason: 'oops' }, sidheek)).status, 400);
  });
  await ok('rounding: 0.49 goes down and 0.50 goes up', async () => {
    const mk = async lines => {
      const c = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-002', traysIn: 0, lines }, sidheek);
      const f = await call('POST', '/api/orders/' + c.body.id + '/finalize', { traysOut: 0 }, sidheek);
      assert.equal(f.body.odoo, 'posted');
      return (await call('GET', '/api/state', null, sidheek)).body.orders.find(o => o.id === c.body.id);
    };
    assert.equal((await mk([{ code: 'PRD-003', qty: 3 }])).total, 400);   // 3.75 -> 4
    assert.equal((await mk([{ code: 'PRD-003', qty: 2 }])).total, 300);   // 2.50 -> 3
    assert.equal((await mk([{ code: 'PRD-003', qty: 7 }])).total, 900);   // 8.75 -> 9
    assert.equal((await mk([{ code: 'PRD-003', qty: 13 }])).total, 1600); // 16.25 -> 16
  });
  await ok('cancelled order never reaches Odoo and gives the trays back', async () => {
    const before = M.moves.length;
    const c = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-001', traysIn: 3, lines: [{ code: 'PRD-001', qty: 1 }] }, sidheek);
    const x = await call('POST', '/api/orders/' + c.body.id + '/cancel', { reason: 'customer left' }, sidheek);
    assert.equal(x.status, 200);
    assert.equal(M.moves.length, before);
    const st = (await call('GET', '/api/state', null, sidheek)).body;
    assert.equal(st.trays.filter(t => t.cust === 'SLM-001').reduce((a, t) => a + t.qty, 0), 11, 'brought 3 then reversed: count unchanged (10 -5 +6)');
  });

  console.log('Odoo trouble');
  await ok('timeout after Odoo created the invoice: retry does not duplicate', async () => {
    const c = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-003', traysIn: 0, lines: [{ code: 'PRD-001', qty: 2 }] }, sidheek);
    M.fail = { match: 'account.move/create', times: 1, mode: 'timeout-after' };
    const f = await call('POST', '/api/orders/' + c.body.id + '/finalize', { traysOut: 0 }, sidheek);
    assert.equal(f.status, 200);
    assert.equal(f.body.odoo, 'queued', 'kept in the queue after the timeout');
    assert.equal(M.moves.filter(m => m.ref === c.body.id).length, 1, 'Odoo did create it');
    const r = await call('POST', '/api/sync/retry', {}, sidheek);
    assert.equal(r.body.posted, 1);
    assert.equal(M.moves.filter(m => m.ref === c.body.id).length, 1, 'still exactly one invoice');
    assert.equal(M.moves.find(m => m.ref === c.body.id).state, 'posted');
  });
  await ok('Odoo down: items wait, are kept in date order, then post', async () => {
    M.down = true;
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const c = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-003', traysIn: 0, lines: [{ code: 'PRD-002', qty: 1 + i }] }, sidheek);
      const f = await call('POST', '/api/orders/' + c.body.id + '/finalize', { traysOut: 0 }, sidheek);
      assert.equal(f.body.odoo, 'queued');
      ids.push(c.body.id);
    }
    const p = await call('POST', '/api/payments', { method: 'Cash', date: '2026-10-12', total: 5, lines: [{ cc: 'SLM-003', amount: 5 }] }, sidheek);
    assert.equal(p.status, 200);
    M.down = false;
    const r = await call('POST', '/api/sync/retry', {}, sidheek);
    assert.equal(r.body.posted, 3, JSON.stringify(r.body));
    const order = M.moves.filter(m => ids.includes(m.ref)).map(m => m.ref);
    assert.deepEqual(order, ids);
  });
  await ok('Odoo refusing an item marks it failed with the reason; retry works after the fix', async () => {
    const c = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-003', traysIn: 0, lines: [{ code: 'PRD-001', qty: 1 }] }, sidheek);
    M.fail = { match: 'account.move/create', times: 1, mode: 'refuse' };
    const f = await call('POST', '/api/orders/' + c.body.id + '/finalize', { traysOut: 0 }, sidheek);
    assert.equal(f.body.odoo, 'failed');
    assert(/Refused by test/.test(f.body.msg));
    const r = await call('POST', '/api/sync/retry', { failed: true }, sidheek);
    assert.equal(r.body.posted, 1);
  });
  await ok('wrong Odoo company stops posting before anything is written', async () => {
    const odooMod = require('../server/odoo');
    const c = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-003', traysIn: 0, lines: [{ code: 'PRD-001', qty: 1 }] }, sidheek);
    M.company = 'Eman Bakery LIVE';
    odooMod._resetCache();
    const n = M.moves.length;
    const f = await call('POST', '/api/orders/' + c.body.id + '/finalize', { traysOut: 0 }, sidheek);
    assert.equal(f.body.odoo, 'failed');
    assert(/Safety stop/.test(f.body.msg), f.body.msg);
    assert.equal(M.moves.length, n, 'nothing written');
    M.company = 'Eman Bakery Demo';
    odooMod._resetCache();
    const r = await call('POST', '/api/sync/retry', { failed: true }, sidheek);
    assert.equal(r.body.posted, 1);
  });

  console.log('payments, credit notes, reversal');
  await ok('split payment: one payment per customer, shared group, posted and matched oldest first', async () => {
    const r = await call('POST', '/api/payments', { method: 'SAB bank', date: '2026-10-12', note: 'T1', total: 100, lines: [{ cc: 'SLM-001', amount: 60 }, { cc: 'SLM-002', amount: 40 }] }, sidheek);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ids.length, 2);
    const st = (await call('GET', '/api/state', null, sidheek)).body;
    const ps = st.payments.filter(p => r.body.ids.includes(p.id));
    assert(ps.every(p => p.group.startsWith('SPLIT-') && p.groupTotal === 100 && p.odoo.state === 'posted'));
    const pay = M.payments.find(p => p.memo === r.body.ids[0]);
    assert.equal(pay.journal_id, 21);
    assert.equal(pay.payment_type, 'inbound');
    assert.equal(pay.createdBy, 'Sidheek');
    assert(M.calls.some(c => c.reconcile), 'matching was requested');
  });
  await ok('split must add up to the total', async () => {
    const r = await call('POST', '/api/payments', { method: 'Cash', date: '2026-10-12', total: 100, lines: [{ cc: 'SLM-001', amount: 60 }, { cc: 'SLM-002', amount: 30 }] }, sidheek);
    assert.equal(r.status, 400);
  });
  await ok('credit note is posted without rounding on the sales account', async () => {
    const r = await call('POST', '/api/credits', { cust: 'SLM-001', amount: 7.25, reason: 'Discount', note: 'promo' }, sidheek);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.odoo, 'posted');
    const mv = M.moves.find(m => m.ref === r.body.id);
    assert.equal(mv.move_type, 'out_refund');
    assert.equal(mv.invoice_cash_rounding_id, undefined);
    assert.equal(mv.amount_total, 7.25);
    assert.equal(mv.invoice_line_ids[0][2].account_id, 270);
  });
  await ok('reversal cancels the payment in Odoo (never deletes) and drops it from the balance', async () => {
    const st = (await call('GET', '/api/state', null, sidheek)).body;
    const p = st.payments.find(x => x.note === 'T1' && x.cust === 'SLM-002');
    const balBefore = st.customers.find(c => c.code === 'SLM-002').advance;
    const r = await call('POST', '/api/payments/' + p.id + '/reverse', { reason: 'wrong customer' }, sidheek);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(M.payments.find(x => x.memo === p.id).state, 'canceled');
    const st2 = (await call('GET', '/api/state', null, sidheek)).body;
    assert(!st2.payments.some(x => x.id === p.id));
    assert(balBefore >= 0);
  });

  console.log('rules');
  await ok('user without the feature is refused', async () => {
    const r = await call('POST', '/api/credits', { cust: 'SLM-001', amount: 1 }, await (async () => {
      await call('POST', '/api/admin/users', { name: 'Jasil', email: 'jasil@test.local', password: 'jasil-pass-1', key: 'key-sidheek', feat: ['order_view'] }, admin);
      return login('jasil@test.local', 'jasil-pass-1');
    })());
    assert.equal(r.status, 403);
  });
  await ok('only the administrator reaches admin functions', async () => {
    assert.equal((await call('POST', '/api/admin/users', {}, sidheek)).status, 403);
    assert.equal((await call('PUT', '/api/admin/price', { cust: 'SLM-001', prod: 'PRD-001', price: 1 }, sidheek)).status, 403);
  });
  await ok('overdue pending order locks new orders and payments (not for admin)', async () => {
    const c = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-003', traysIn: 0, lines: [{ code: 'PRD-001', qty: 1 }] }, sidheek);
    await db.q('update orders set deadline=$2 where id=$1', [c.body.id, Date.now() - 1000]);
    const r = await call('POST', '/api/orders', { branch: 'Hira Branch', cust: 'SLM-003', traysIn: 0, lines: [{ code: 'PRD-001', qty: 1 }] }, sidheek);
    assert.equal(r.status, 423);
    const p = await call('POST', '/api/payments', { method: 'Cash', date: '2026-10-12', total: 1, lines: [{ cc: 'SLM-003', amount: 1 }] }, sidheek);
    assert.equal(p.status, 423);
    const f = await call('POST', '/api/orders/' + c.body.id + '/finalize', { traysOut: 0 }, sidheek);
    assert.equal(f.status, 200, 'finalizing is still allowed');
  });
  await ok('tray ledger and audit log cannot be changed or deleted', async () => {
    await assert.rejects(db.q('update tray_ledger set qty=0'), /append-only/);
    await assert.rejects(db.q('delete from tray_ledger'), /append-only/);
    await assert.rejects(db.q('delete from audit'), /append-only/);
  });
  await ok('balances: opening + invoices - payments - credits, oldest invoice paid first', async () => {
    const st = (await call('GET', '/api/state', null, admin)).body;
    const a = st.customers.find(c => c.code === 'SLM-001');
    // opening 150 + invoice 53 - payment 60 - credit 7.25 = 135.75 ; payment/credit pay the opening balance first
    assert.equal(a.open + st.orders.filter(o => o.cust === 'SLM-001' && o.status === 'final').reduce((x, o) => x + o.rem, 0) / 100 - a.advance, 135.75);
    assert.equal(a.open, 150 - 67.25);
    const o = st.orders.find(x => x.id === ord);
    assert.equal(o.rem, 5300);
  });
  await ok('API keys are stored encrypted and never logged', async () => {
    const r = await db.q('select odoo_key_enc from users where name=$1', ['Sidheek']);
    assert(!r.rows[0].odoo_key_enc.includes('key-sidheek'));
    const lg = await db.q("select count(*) n from sync_log where request::text like '%key-%' or response::text like '%key-%'");
    assert.equal(Number(lg.rows[0].n), 0);
    assert((await db.q('select count(*) n from sync_log')).rows[0].n > 10, 'calls are logged');
  });

  console.log(`\n${pass} checks passed${process.exitCode ? ', SOME FAILED' : ''}`);
  await mock.close();
  await db.pool.end();
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
