const path = require('path');
const express = require('express');
const crypto = require('./crypto');
crypto.secret(); // stops early with a clear message when APP_SECRET is missing
const db = require('./db');
const routes = require('./routes');
const post = require('./post');
const { audit } = require('./util');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '8mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, routes);

const pub = path.join(__dirname, '..', 'public');
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(pub, 'sw.js'));
});
app.use(express.static(pub, {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); }
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(pub, 'index.html'));
});

// First start: create the administrator from secrets. No default passwords exist in the code.
async function bootstrapAdmin() {
  const n = await db.q('select count(*) n from users');
  if (Number(n.rows[0].n) > 0) return;
  const email = (process.env.ADMIN_EMAIL || 'sales@emanbakeries.com').toLowerCase();
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || pw.length < 8) {
    console.error('No users yet. Set ADMIN_PASSWORD (at least 8 characters) in Replit Secrets and restart to create the administrator.');
    return;
  }
  await db.q('insert into users(name,email,pw_hash,admin,active,feat) values($1,$2,$3,true,true,$4)',
    [process.env.ADMIN_NAME || 'Shafeeq', email, crypto.hashPassword(pw), require('./state').FEATURES]);
  await audit('system', 'Administrator created', 'User', email, '');
  console.log('Administrator created:', email);
}

async function main() {
  await db.init();
  await bootstrapAdmin();
  post.startWorker();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log('Eman orders app on port ' + port));
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { app, main };
