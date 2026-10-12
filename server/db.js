const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. On Replit: open Tools > PostgreSQL and create the database.');
  process.exit(1);
}

const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 8
});

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn((text, params) => c.query(text, params));
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (x) { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

const SCHEMA = `
create table if not exists users(
  id serial primary key,
  name text not null,
  email text unique not null,
  pw_hash text not null,
  admin boolean not null default false,
  active boolean not null default true,
  feat text[] not null default '{}',
  odoo_key_enc text,
  created_at timestamptz not null default now()
);
create table if not exists products(
  code text primary key,
  name text not null,
  cat text not null,
  ppp int not null default 1,
  dflt numeric(12,2) not null default 0,
  active boolean not null default true
);
create table if not exists customers(
  code text primary key,
  name text unique not null,
  opening_cents bigint not null default 0,
  active boolean not null default true,
  odoo_partner_id int
);
create table if not exists customer_prices(
  cust text not null references customers(code) on update cascade,
  prod text not null references products(code) on update cascade,
  price numeric(12,2) not null,
  primary key(cust, prod)
);
create table if not exists orders(
  id text primary key,
  branch text not null,
  cust text not null references customers(code),
  created_at bigint not null,
  deadline bigint not null,
  status text not null,
  trays_in int not null default 0,
  trays_out int,
  by_name text not null,
  by_id int,
  lines jsonb not null,
  total_cents bigint not null default 0,
  rounding_cents int not null default 0,
  inv text,
  odoo_move_id int,
  odoo_state text,
  odoo_msg text,
  odoo_tries int not null default 0,
  finalized_at bigint,
  final_by text,
  cancel_reason text
);
create index if not exists orders_cust on orders(cust);
create index if not exists orders_status on orders(status);
create table if not exists payments(
  id text primary key,
  cust text not null references customers(code),
  amount_cents bigint not null,
  method text not null,
  pdate text not null,
  note text not null default '',
  grp text not null default '',
  group_total_cents bigint not null default 0,
  by_name text not null,
  by_id int,
  t bigint not null,
  odoo_state text not null default 'queued',
  odoo_id int,
  odoo_ref text,
  odoo_msg text,
  odoo_tries int not null default 0,
  reversed boolean not null default false,
  reverse_reason text,
  reversed_by text,
  reverse_state text
);
create index if not exists payments_cust on payments(cust);
create table if not exists credits(
  id text primary key,
  cust text not null references customers(code),
  amount_cents bigint not null,
  reason text not null,
  note text not null default '',
  by_name text not null,
  by_id int,
  t bigint not null,
  odoo_state text not null default 'queued',
  odoo_id int,
  odoo_ref text,
  odoo_msg text,
  odoo_tries int not null default 0
);
create index if not exists credits_cust on credits(cust);
create table if not exists tray_ledger(
  id bigserial primary key,
  t bigint not null,
  cust text,
  branch text,
  qty int not null,
  type text not null,
  ref text not null default '',
  by_name text not null,
  reason text not null default '',
  reverses_id bigint
);
create table if not exists audit(
  id bigserial primary key,
  t bigint not null,
  user_name text not null,
  action text not null,
  entity text not null default '',
  ref text not null default '',
  detail text not null default ''
);
create table if not exists sync_log(
  id bigserial primary key,
  t bigint not null,
  user_name text,
  endpoint text,
  request jsonb,
  response jsonb,
  status text
);
create table if not exists settings(key text primary key, value jsonb not null);
create table if not exists counters(name text primary key, val bigint not null);

create or replace function eb_append_only() returns trigger as $$
begin
  raise exception 'This table is append-only: rows cannot be changed or deleted';
end;
$$ language plpgsql;
drop trigger if exists tray_ledger_ro on tray_ledger;
create trigger tray_ledger_ro before update or delete on tray_ledger for each row execute function eb_append_only();
drop trigger if exists audit_ro on audit;
create trigger audit_ro before update or delete on audit for each row execute function eb_append_only();
`;

const DEFAULT_SETTINGS = {
  finalizeMin: 60,
  autoPrint: true,
  footer: 'Thank you. Please return the trays.',
  branches: ['Hira Branch', 'Rahmaniyyah Branch'],
  offline: false
};

async function init() {
  await q(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await q('insert into settings(key,value) values($1,$2) on conflict(key) do nothing', [k, JSON.stringify(v)]);
  }
  for (const [n, v] of [['ord', 1], ['pay', 1], ['cn', 1], ['split', 1]]) {
    await q('insert into counters(name,val) values($1,$2) on conflict(name) do nothing', [n, v]);
  }
}

async function getSettings(run = q) {
  const r = await run('select key,value from settings');
  const s = {};
  r.rows.forEach(x => { s[x.key] = x.value; });
  return s;
}

async function setSetting(key, value, run = q) {
  await run('insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
}

// Atomic next number for a counter (never reused)
async function nextNo(name, run = q) {
  const r = await run('update counters set val=val+1 where name=$1 returning val-1 as n', [name]);
  return Number(r.rows[0].n);
}

module.exports = { pool, q, tx, init, getSettings, setSetting, nextNo };
