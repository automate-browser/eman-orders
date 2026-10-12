// A tiny stand-in for Odoo's JSON-2 API, only for automated tests. It models what the app relies on:
// cash rounding on invoices, posting, payments, receivable lines and oldest-first reconciliation.
const http = require('http');

function createMock() {
  const st = {
    company: 'Eman Bakery Demo',
    keys: { 'key-sidheek': 'Sidheek', 'key-shafeeq': 'Shafeeq' },
    nextId: 1000,
    moves: [], payments: [], lines: [], calls: [],
    partners: [], products: [],
    journals: { INV: 9, CSH: 20, SAB: 21, NEO: 22, HALA: 23, KRAJ: 24, SHK: 25 },
    fail: null,            // { match: 'account.move/create', times: n, mode: 'down' | 'timeout-after' | 'refuse' }
    down: false
  };
  const id = () => ++st.nextId;

  function partnerLine(m) {
    const sign = m.move_type === 'out_invoice' ? 1 : -1;
    st.lines.push({ id: id(), move_id: m.id, partner_id: m.partner_id, date: m.date, amount_residual: sign * m.amount_total, parent_state: 'posted', reconciled: false });
  }

  function handle(model, method, b, user) {
    const key = model + '/' + method;
    if (key === 'res.company/search_read') return [{ id: 1, name: st.company }];
    if (key === 'account.journal/search_read') {
      const code = b.domain[0][2];
      return st.journals[code] ? [{ id: st.journals[code], code }] : [];
    }
    if (key === 'account.account/search_read') return [{ id: 270, code: '500100' }];
    if (key === 'account.cash.rounding/search_read') return [{ id: 1, name: 'Round to 1 SAR (0.50 up)' }];
    if (key === 'product.product/search_read') {
      const codes = b.domain[0][2];
      return st.products.filter(p => codes.includes(p.default_code));
    }
    if (key === 'res.partner/search_read') {
      const name = b.domain[0][2];
      return st.partners.filter(p => p.name === name);
    }
    if (key === 'account.move/search_read') {
      const d = Object.fromEntries(b.domain.filter(x => x[1] === '=').map(x => [x[0], x[2]]));
      if (b.domain.some(x => x[1] === '=like')) {
        const like = b.domain.find(x => x[1] === '=like');
        const rows = st.moves.filter(m => m.move_type === d.move_type && String(m[like[0]] || '').startsWith(like[2].replace('%', '')));
        return rows.sort((a, c) => String(c.ref).localeCompare(String(a.ref))).slice(0, 1);
      }
      return st.moves.filter(m => m.ref === d.ref && m.move_type === d.move_type && m.state !== 'cancel').slice(0, 2);
    }
    if (key === 'account.payment/search_read') {
      const memo = b.domain.find(x => x[0] === 'memo');
      if (memo && memo[1] === '=like') {
        return st.payments.filter(p => String(p.memo).startsWith('PAY-')).sort((a, c) => String(c.memo).localeCompare(String(a.memo))).slice(0, 1);
      }
      return st.payments.filter(p => p.memo === memo[2] && p.state !== 'canceled').slice(0, 2);
    }
    if (key === 'account.move/create') {
      const v = b.vals_list[0];
      if (!st.partners.some(p => p.id === v.partner_id)) throw { status: 422, message: 'partner missing' };
      const sub = v.invoice_line_ids.reduce((a, l) => a + l[2].quantity * l[2].price_unit, 0);
      const total = v.move_type === 'out_invoice' ? Math.floor(sub + 0.5 + 1e-9) : sub;
      const m = { id: id(), ...v, state: 'draft', amount_total: total, sub, name: '/', createdBy: user };
      st.moves.push(m);
      return [m.id];
    }
    if (key === 'account.move/action_post') {
      const m = st.moves.find(x => x.id === b.ids[0]);
      m.state = 'posted';
      const n = st.moves.filter(x => x.state === 'posted' && x.move_type === m.move_type).length;
      m.name = (m.move_type === 'out_invoice' ? 'INV/2026/' : 'RINV/2026/') + String(n).padStart(5, '0');
      partnerLine(m);
      return true;
    }
    if (key === 'account.move/read') return b.ids.map(i => { const m = st.moves.find(x => x.id === i); return { id: m.id, name: m.name, amount_total: m.amount_total, state: m.state }; });
    if (key === 'account.payment/create') {
      const v = b.vals_list[0];
      const p = { id: id(), ...v, state: 'draft', name: '/', createdBy: user };
      st.payments.push(p);
      return [p.id];
    }
    if (key === 'account.payment/action_post') {
      const p = st.payments.find(x => x.id === b.ids[0]);
      p.state = 'paid';
      p.name = 'P/2026/' + String(st.payments.filter(x => x.state === 'paid').length).padStart(5, '0');
      st.lines.push({ id: id(), payment_id: p.id, partner_id: p.partner_id, date: p.date, amount_residual: -p.amount, parent_state: 'posted', reconciled: false });
      return true;
    }
    if (key === 'account.payment/read') return b.ids.map(i => { const p = st.payments.find(x => x.id === i); return { id: p.id, name: p.name, state: p.state }; });
    if (key === 'account.payment/action_draft') {
      const p = st.payments.find(x => x.id === b.ids[0]);
      p.state = 'draft';
      st.lines = st.lines.filter(l => l.payment_id !== p.id);
      st.lines.filter(l => !l.payment_id).forEach(l => { l.reconciled = false; });
      recompute();
      return true;
    }
    if (key === 'account.payment/action_cancel') { st.payments.find(x => x.id === b.ids[0]).state = 'canceled'; return true; }
    if (key === 'account.move.line/search_read') {
      const pid = b.domain.find(x => x[0] === 'partner_id')[2];
      return st.lines.filter(l => l.partner_id === pid && !l.reconciled && l.amount_residual !== 0).sort((a, c) => a.date.localeCompare(c.date) || a.id - c.id);
    }
    if (key === 'account.move.line/reconcile') {
      st.calls.push({ reconcile: b.ids.length });
      let lines = b.ids.map(i => st.lines.find(l => l.id === i));
      lines.forEach(l => { l.matchOrder = l.matchOrder || 1; });
      st.reconciledSets = (st.reconciledSets || 0) + 1;
      // settle oldest debits with the available credits
      let credit = -lines.filter(l => l.amount_residual < 0).reduce((a, l) => a + l.amount_residual, 0);
      lines.filter(l => l.amount_residual < 0).forEach(l => { l.amount_residual = 0; l.reconciled = true; });
      for (const l of lines.filter(x => x.amount_residual > 0)) {
        const use = Math.min(l.amount_residual, credit);
        l.amount_residual -= use; credit -= use;
        if (l.amount_residual === 0) l.reconciled = true;
      }
      if (credit > 0) st.lines.push({ id: id(), partner_id: lines[0].partner_id, date: lines[lines.length - 1].date, amount_residual: -credit, parent_state: 'posted', reconciled: false });
      return { ok: true };
    }
    if (key === 'account.move.line/formatted_read_group') {
      const by = {};
      st.lines.forEach(l => { by[l.partner_id] = (by[l.partner_id] || 0) + l.amount_residual; });
      st.moves.filter(m => m.opening).forEach(() => {});
      return Object.entries(by).map(([pid, bal]) => {
        const p = st.partners.find(x => x.id === Number(pid));
        return { partner_id: [Number(pid), p.name], 'balance:sum': bal };
      });
    }
    throw { status: 404, message: 'mock: unknown ' + key };
  }

  function recompute() { /* residuals are not rebuilt in the mock; tests avoid depending on it */ }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const m = /^\/json\/2\/([^/]+)\/([^/]+)$/.exec(req.url);
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!m) return send(404, { message: 'not found' });
      const auth = (req.headers.authorization || '').replace(/^bearer /i, '');
      const user = st.keys[auth];
      if (!user) return send(401, { name: 'AccessDenied', message: 'Invalid apikey' });
      if (st.down) { req.socket.destroy(); return; }
      const body = raw ? JSON.parse(raw) : {};
      const key = m[1] + '/' + m[2];
      st.calls.push({ key, user });
      if (st.fail && key === st.fail.match && st.fail.times > 0) {
        st.fail.times--;
        if (st.fail.mode === 'timeout-after') { try { handle(m[1], m[2], body, user); } catch (e) { /* ignore */ } req.socket.destroy(); return; }
        if (st.fail.mode === 'refuse') return send(422, { name: 'ValidationError', message: 'Refused by test' });
        if (st.fail.mode === 'down') { req.socket.destroy(); return; }
      }
      try { send(200, handle(m[1], m[2], body, user)); }
      catch (e) { send(e.status || 500, { name: 'Error', message: e.message || String(e) }); }
    });
  });

  return {
    st,
    listen: port => new Promise(r => server.listen(port, '127.0.0.1', r)),
    close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); })
  };
}

module.exports = { createMock };
