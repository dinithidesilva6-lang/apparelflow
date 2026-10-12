const BASE = 'http://localhost:5000/api';

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

async function login(email, password) {
  const r = await call('POST', '/auth/login', null, { email, password });
  return r.data.token;
}

function show(label, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' -> ' + extra : ''));
}

async function createOrder(sup, qty, yards) {
  const r = await call('POST', '/orders', sup, {
    recipe_id: 2, target_qty: qty, fabric_roll_id: 'FAB-ROLL-901', actual_fabric_yds: yards,
  });
  return r.data.order.id;
}

async function main() {
  const sup = await login('supervisor@apparelflow.com', 'Supervisor@123');
  const ver = await login('verifier@apparelflow.com', 'Verifier@123');
  const sew = await login('sewing@apparelflow.com', 'Sewing@123');

  const pending = await createOrder(sup, 20, 22);
  const good = await createOrder(sup, 20, 22);

  const detail = await call('GET', '/orders/' + good, ver);
  const counts = detail.data.items.map((i) => ({ component_id: i.component_id, actual_qty: i.expected_qty }));
  await call('POST', '/verification/' + good + '/count', ver, { counts });
  const approve = await call('POST', '/verification/' + good + '/approve', ver);
  show('Approve valid batch', approve.status === 200, approve.status);

  const q = await call('GET', '/sewing/queue', sew);
  const ids = (q.data.orders || []).map((o) => o.id);
  show('Sewing queue status 200', q.status === 200, q.status);
  show('Verified order IS in queue', ids.includes(good));
  show('Pending order is NOT in queue', !ids.includes(pending));
  const mine = (q.data.orders || []).find((o) => o.id === good);
  if (mine) console.log('      verifier =', mine.verifier_name, ' wastage_pct =', mine.wastage_pct);

  const qs = await call('GET', '/sewing/queue?status=PENDING_VERIFICATION', sew);
  const ids2 = (qs.data.orders || []).map((o) => o.id);
  show('URL param tampering leaks nothing', !ids2.includes(pending));

  const peek = await call('GET', '/sewing/' + pending, sew);
  show('Pending order by ID via sewing', peek.status === 404, peek.status + ' (expect 404)');

  const peekStart = await call('POST', '/sewing/' + pending + '/start', sew);
  show('Start sewing on pending order', peekStart.status === 404, peekStart.status + ' (expect 404)');

  const asSup = await call('GET', '/sewing/queue', sup);
  show('Supervisor opens sewing queue', asSup.status === 403, asSup.status + ' (expect 403)');

  const asVer = await call('GET', '/sewing/queue', ver);
  show('Verifier opens sewing queue', asVer.status === 403, asVer.status + ' (expect 403)');

  const noAuth = await call('GET', '/sewing/queue', null);
  show('No token', noAuth.status === 401, noAuth.status + ' (expect 401)');

  const start = await call('POST', '/sewing/' + good + '/start', sew);
  show('Start sewing on verified order', start.status === 200, start.status + ' (expect 200)');

  const again = await call('POST', '/sewing/' + good + '/start', sew);
  show('Start sewing twice', again.status === 409, again.status + ' (expect 409)');

  const q2 = await call('GET', '/sewing/queue', sew);
  show('Started order leaves the queue', !(q2.data.orders || []).some((o) => o.id === good));
}

main().catch((e) => console.error('TEST ERROR:', e.message));