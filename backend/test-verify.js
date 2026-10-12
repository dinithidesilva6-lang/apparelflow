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

function show(label, r, expected) {
  const mark = r.status === expected ? 'PASS' : 'FAIL';
  console.log(mark + '  ' + label + ' -> ' + r.status + ' (expect ' + expected + ')');
}

async function createOrder(sup, qty, yards) {
  const r = await call('POST', '/orders', sup, {
    recipe_id: 1, target_qty: qty, fabric_roll_id: 'FAB-ROLL-882', actual_fabric_yds: yards,
  });
  return r.data.order.id;
}

async function main() {
  const sup = await login('supervisor@apparelflow.com', 'Supervisor@123');
  const ver = await login('verifier@apparelflow.com', 'Verifier@123');

  const a = await createOrder(sup, 10, 18);
  show('Approve with no counts (uncounted)', await call('POST', '/verification/' + a + '/approve', ver), 422);

  const detailA = await call('GET', '/orders/' + a, ver);
  const countsA = detailA.data.items.map((i, idx) => ({
    component_id: i.component_id,
    actual_qty: idx === 2 ? i.expected_qty - 1 : i.expected_qty,
  }));
  const cA = await call('POST', '/verification/' + a + '/count', ver, { counts: countsA });
  show('Count with one shortage (RED)', cA, 200);
  console.log('      can_approve =', cA.data.can_approve, '(expect false)');

  show('Approve with a RED component', await call('POST', '/verification/' + a + '/approve', ver), 422);
  show('Supervisor tries to approve', await call('POST', '/verification/' + a + '/approve', sup), 403);
  show('Reject without a note', await call('POST', '/verification/' + a + '/reject', ver, { rejection_note: '   ' }), 400);
  show('Reject with a note', await call('POST', '/verification/' + a + '/reject', ver, { rejection_note: 'Sleeve shortage, re-cut required' }), 200);

  const b = await createOrder(sup, 10, 19.8);
  const detailB = await call('GET', '/orders/' + b, ver);
  const countsB = detailB.data.items.map((i, idx) => ({
    component_id: i.component_id,
    actual_qty: idx === 0 ? i.expected_qty + 1 : i.expected_qty,
  }));
  show('Count all GREEN (one YELLOW excess)', await call('POST', '/verification/' + b + '/count', ver, { counts: countsB }), 200);

  const ok = await call('POST', '/verification/' + b + '/approve', ver);
  show('Approve valid batch', ok, 200);
  if (ok.data && ok.data.log) {
    console.log('      verifier_id =', ok.data.log.verifier_id, ' wastage_pct =', ok.data.log.wastage_pct, '(expect 10)');
  }

  show('Approve same batch again', await call('POST', '/verification/' + b + '/approve', ver), 409);
}

main().catch((e) => console.error('TEST ERROR:', e.message));