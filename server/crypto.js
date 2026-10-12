const crypto = require('crypto');

function secret() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) {
    console.error('APP_SECRET is missing or too short (use at least 16 random characters). Set it in Replit Secrets.');
    process.exit(1);
  }
  return s;
}

const encKey = () => crypto.createHash('sha256').update('odoo-key:' + secret()).digest();
const macKey = () => crypto.createHash('sha256').update('session:' + secret()).digest();

// Odoo API keys are stored encrypted (AES-256-GCM); they never leave the server.
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return 's1$' + salt.toString('base64') + '$' + h.toString('base64');
}

function checkPassword(pw, stored) {
  try {
    const [v, s, h] = stored.split('$');
    if (v !== 's1') return false;
    const calc = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64);
    const want = Buffer.from(h, 'base64');
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch (e) {
    return false;
  }
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', macKey()).update(body).digest('base64url');
  return body + '.' + mac;
}

function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [body, mac] = tok.split('.');
  if (!body || !mac) return null;
  const calc = crypto.createHmac('sha256', macKey()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(calc);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}

module.exports = { secret, encrypt, decrypt, hashPassword, checkPassword, signToken, verifyToken };
