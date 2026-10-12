// Posting queue: sends finalized orders, payments and credit notes to Odoo, oldest first.
// Network trouble keeps an item in the queue (retried automatically). A refusal from Odoo marks it "failed" with the reason.
const db = require('./db');
const odoo = require('./odoo');
const { audit } = require('./util');

let chain = Promise.resolve();
const locked = fn => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function loadQueued() {
  const [o, p, c, r] = await Promise.all([
    db.q("select *, finalized_at as sort_t from orders where status='final' and odoo_state='queued'"),
    db.q("select *, t as sort_t from payments where odoo_state='queued' and not reversed"),
    db.q("select *, t as sort_t from credits where odoo_state='queued'"),
    db.q("select *, t as sort_t from payments where reversed and reverse_state='queued'")
  ]);
  const items = [
    ...o.rows.map(x => ({ kind: 'order', row: x })),
    ...p.rows.map(x => ({ kind: 'payment', row: x })),
    ...c.rows.map(x => ({ kind: 'credit', row: x })),
    ...r.rows.map(x => ({ kind: 'reverse', row: x }))
  ];
  items.sort((a, b) => Number(a.row.sort_t) - Number(b.row.sort_t) || String(a.row.id).localeCompare(String(b.row.id)));
  return items;
}

async function markFailed(table, id, msg, extra = '') {
  await db.q(`update ${table} set ${extra}odoo_state='failed', odoo_msg=$2, odoo_tries=odoo_tries+1 where id=$1`, [id, msg]);
}

async function postItem(item) {
  const { kind, row } = item;
  const custRow = (await db.q('select * from customers where code=$1', [row.cust])).rows[0];
  const uid = row.by_id;
  let ctx;
  try {
    const u = await odoo.getUserKey(uid);
    ctx = { name: u.name, key: u.key };
  } catch (e) {
    return fail(kind, row, e);
  }
  try {
    if (db.__offline) throw new odoo.OdooError('Odoo is switched off (simulation)', true);
    if (kind === 'order') {
      const r = await odoo.postInvoice(ctx, row, custRow);
      const diff = Math.abs(Number(r.total) * 100 - Number(row.total_cents)) > 0.5;
      const msg = diff ? `Posted as ${r.name}, but Odoo total ${r.total} differs from the app total ${Number(row.total_cents) / 100}. Check it.` : 'Posted as ' + r.name;
      await db.q("update orders set odoo_state='posted', odoo_move_id=$2, inv=$3, odoo_msg=$4, odoo_tries=odoo_tries+1 where id=$1", [row.id, r.moveId, r.name, msg]);
      await audit(ctx.name, 'Posted to Odoo', 'Order', row.id, msg);
    } else if (kind === 'payment') {
      const r = await odoo.postPayment(ctx, row, custRow);
      await db.q("update payments set odoo_state='posted', odoo_id=$2, odoo_ref=$3, odoo_msg='', odoo_tries=odoo_tries+1 where id=$1", [row.id, r.id, r.name]);
      await audit(ctx.name, 'Posted to Odoo', 'Payment', row.id, r.name);
    } else if (kind === 'credit') {
      const r = await odoo.postCredit(ctx, row, custRow);
      await db.q("update credits set odoo_state='posted', odoo_id=$2, odoo_ref=$3, odoo_msg='', odoo_tries=odoo_tries+1 where id=$1", [row.id, r.id, r.name]);
      await audit(ctx.name, 'Posted to Odoo', 'Credit note', row.id, r.name);
    } else if (kind === 'reverse') {
      await odoo.reversePayment(ctx, row, custRow);
      await db.q("update payments set reverse_state='done' where id=$1", [row.id]);
      await audit(ctx.name, 'Payment cancelled in Odoo', 'Payment', row.id, '');
    }
    return 'ok';
  } catch (e) {
    return fail(kind, row, e);
  }
}

async function fail(kind, row, e) {
  if (!(e instanceof odoo.OdooError)) e = new odoo.OdooError(String(e && e.message || e), false);
  const table = kind === 'order' ? 'orders' : kind === 'credit' ? 'credits' : 'payments';
  if (e.retryable) {
    await db.q(`update ${table} set odoo_msg=$2, odoo_tries=${kind === 'reverse' ? 'odoo_tries' : 'odoo_tries+1'} where id=$1`, [row.id, e.message]);
    throw e; // stop the run, try again later
  }
  if (kind === 'reverse') await db.q("update payments set reverse_state='failed', odoo_msg=$2 where id=$1", [row.id, e.message]);
  else await markFailed(table, row.id, e.message);
  await audit('system', 'Odoo posting failed', kind, row.id, e.message);
  return 'failed';
}

// Posts everything waiting. Stops quietly at the first network problem.
function drain() {
  return locked(async () => {
    const set = await db.getSettings();
    db.__offline = !!set.offline;
    let posted = 0, failed = 0, stopped = null;
    const items = await loadQueued();
    for (const it of items) {
      try {
        const r = await postItem(it);
        if (r === 'ok') posted++; else failed++;
      } catch (e) {
        stopped = e.message;
        break;
      }
    }
    return { posted, failed, stopped, waiting: stopped ? items.length - posted - failed : 0 };
  });
}

let timer = null;
function startWorker(everyMs = 60000) {
  if (timer) return;
  timer = setInterval(() => { drain().catch(e => console.error('queue run failed:', e.message)); }, everyMs);
  timer.unref();
}

module.exports = { drain, startWorker };
