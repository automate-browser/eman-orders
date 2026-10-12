const db = require('./db');

const pad = (n, l) => String(n).padStart(l, '0');

async function audit(user, action, entity, ref, detail, run = db.q) {
  await run('insert into audit(t,user_name,action,entity,ref,detail) values($1,$2,$3,$4,$5,$6)',
    [Date.now(), user || 'system', action, entity || '', ref || '', detail || '']);
}

// End of the order's day in Jeddah (UTC+3, no daylight saving)
function endOfDayRiyadh(t) {
  const off = 3 * 3600 * 1000;
  const day = Math.floor((t + off) / 86400000);
  return (day + 1) * 86400000 - 1000 - off;
}

// Whole riyal, .49 down, .50 up (all amounts here are positive)
function totals(lines) {
  let sub = 0;
  lines.forEach(l => { sub += Math.round(Number(l.price) * 100) * l.qty; });
  const rounded = Math.floor((sub + 50) / 100);
  return { sub, rounded, diff: rounded * 100 - sub };
}

module.exports = { pad, audit, endOfDayRiyadh, totals };
