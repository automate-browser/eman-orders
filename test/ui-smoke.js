// Opens the real screens in Chromium against a local server + fake Odoo and walks the main flow.
// Needs DATABASE_URL (scratch DB) and optionally UI_DATA=path/to/data.json (starting-data file) for realistic volume.
if (!/test/i.test(process.env.DATABASE_URL || '') && process.env.ALLOW_WIPE !== 'yes') {
  console.error('Refusing to run: this test EMPTIES the database. Use a scratch database whose name contains "test".');
  process.exit(2);
}

process.env.APP_SECRET = 'test-secret-test-secret-1234';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ODOO_URL = 'http://127.0.0.1:54700';
process.env.ODOO_DB = 'demo';
process.env.PORT = '54702';
process.env.PGSSL = 'off';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createMock } = require('./mock-odoo');

const base = 'http://127.0.0.1:54702';
const out = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });

async function api(method, p, body, cookie) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

(async () => {
  const db = require('../server/db');
  await db.q('drop schema public cascade; create schema public;');
  const mock = createMock();
  await mock.listen(54700);
  await require('../server/index').main();
  const data = process.env.UI_DATA ? JSON.parse(fs.readFileSync(process.env.UI_DATA, 'utf8')) : {
    P: [['PRD-001', 'CHAPATHI 25', 'CHAPATHI', 25, 4.5], ['PRD-002', 'BURGER 10', 'BURGER', 10, 2]],
    C: [['SLM-001', 'CUST A', 0], ['SLM-002', 'CUST B', 0]], X: {}
  };
  mock.st.partners = data.C.map((c, i) => ({ id: 500 + i, name: c[1] }));
  mock.st.products = data.P.map((p, i) => ({ id: 10 + i, default_code: p[0] }));

  const admin = (await api('POST', '/api/login', { email: 'admin@test.local', password: 'admin-pass-123' })).cookie;
  console.log('import', JSON.stringify((await api('POST', '/api/admin/import', data, admin)).body));
  await api('POST', '/api/admin/users', { name: 'Sidheek', email: 'sidheek@test.local', password: 'sidheek-pass', key: 'key-sidheek', feat: ['order_create', 'order_finalize', 'order_cancel', 'order_view', 'payments', 'credit_notes', 'trays_view', 'daily_print', 'customers_view', 'sync_view'] }, admin);
  await api('POST', '/api/admin/trays/branch', { branch: 'Hira Branch', qty: 500 }, admin);
  for (const c of data.C.slice(0, 5)) await api('POST', '/api/admin/trays/customer', { cust: c[0], qty: 12 }, admin);

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  for (const [name, w, h] of [['desk', 1280, 800], ['phone', 390, 800]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push(name + ' pageerror: ' + e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
    pg.on('dialog', d => d.accept());
    await pg.goto(base);
    await pg.waitForSelector('[data-act="gologin"]');
    await pg.screenshot({ path: `${out}/${name}_landing.png` });
    await pg.click('[data-act="gologin"]');
    await pg.fill('#le', 'sidheek@test.local');
    await pg.fill('#lp', 'wrong-pass');
    await pg.click('#lf button[type=submit]');
    await pg.waitForFunction(() => document.querySelector('#lerr') && document.querySelector('#lerr').textContent.length > 0);
    await pg.screenshot({ path: `${out}/${name}_login_error.png` });
    await pg.fill('#lp', 'sidheek-pass');
    await pg.click('#lf button[type=submit]');
    await pg.waitForSelector('.shell');
    await pg.screenshot({ path: `${out}/${name}_home.png` });

    // new order: branch -> customer -> trays -> products
    await pg.evaluate(() => document.querySelector('[data-act="nav"][data-id="new"]').click());
    await pg.click('[data-act="branch"]');
    await pg.click('[data-act="pickcust"]');
    await pg.click('[data-act="tset"][data-id="5"]');
    await pg.click('[data-act="tnext"]');
    await pg.click('[data-act="cat"]');
    const pcs = await pg.$('[data-act="pcs"]');
    if (pcs) await pcs.click();
    await pg.click('[data-act="padd"]');
    await pg.click('[data-act="padd"]');
    await pg.screenshot({ path: `${out}/${name}_picker.png` });
    await pg.evaluate(() => document.querySelector('[data-act="create"]').click());
    await pg.waitForSelector('.modal');
    await pg.screenshot({ path: `${out}/${name}_created.png` });
    await pg.evaluate(() => document.querySelector('[data-act="closemodal"]').click());
    // finalize
    await pg.evaluate(() => document.querySelector('[data-act="nav"][data-id="pending"]').click());
    await pg.evaluate(() => document.querySelector('[data-act="fin"]').click());
    await pg.waitForSelector('[data-act="mset"]');
    await pg.click('[data-act="mset"][data-id="5"]');
    await pg.screenshot({ path: `${out}/${name}_finalize.png` });
    await pg.click('[data-act="dofin"]');
    await pg.waitForFunction(() => /Invoice posted|Odoo refused|waiting for Odoo/.test(document.body.innerText), null, { timeout: 20000 });
    const txt = await pg.evaluate(() => document.querySelector('.modal').innerText);
    console.log(name, 'finalize result:', txt.split('\n').slice(0, 3).join(' | '));
    await pg.screenshot({ path: `${out}/${name}_done.png` });
    await pg.evaluate(() => document.querySelector('[data-act="closemodal"]').click());
    for (const v of ['orders', 'payments', 'credit', 'trays', 'customers', 'sync', 'daily']) {
      await pg.evaluate(id => { const e = document.querySelector(`[data-act="nav"][data-id="${id}"]`); if (e) e.click(); else { document.querySelector('[data-act="more"]').click(); setTimeout(() => document.querySelector(`[data-act="nav"][data-id="${id}"]`).click(), 50); } }, v);
      await pg.waitForTimeout(150);
      await pg.screenshot({ path: `${out}/${name}_${v}.png` });
    }
    await ctx.close();
  }
  // admin screens
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errors.push('admin pageerror: ' + e.message));
  await pg.goto(base);
  await pg.click('[data-act="gologin"]');
  await pg.fill('#le', 'admin@test.local');
  await pg.fill('#lp', 'admin-pass-123');
  await pg.click('#lf button[type=submit]');
  await pg.waitForSelector('.shell');
  await pg.evaluate(() => document.querySelector('[data-act="nav"][data-id="admin"]').click());
  for (const t of ['users', 'products', 'custs', 'trayopen', 'data', 'audit', 'settings']) {
    await pg.evaluate(id => document.querySelector(`[data-act="tab"][data-id="${id}"]`).click(), t);
    await pg.waitForTimeout(150);
    await pg.screenshot({ path: `${out}/admin_${t}.png` });
  }
  await b.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no browser errors');
  await mock.close();
  await db.pool.end();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
