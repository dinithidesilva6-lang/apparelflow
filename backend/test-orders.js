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

async function main() {
  const sup = await login('supervisor@apparelflow.com', 'Supervisor@123');
  const ver = await login('verifier@apparelflow.com', 'Verifier@123');
  const sew = await login('sewing@apparelflow.com', 'Sewing@123');

  const good = await call('POST', '/orders', sup, {
    recipe_id: 1, target_qty: 50, fabric_roll_id: 'FAB-ROLL-882', actual_fabric_yds: 95,
  });
  console.log('1. Supervisor create order  ->', good.status, good.data.order && good.data.order.order_no);

  const id = good.data.order && good.data.order.id;
  const detail = await call('GET', '/orders/' + id, sup);
  console.log('2. Expected counts:');
  detail.data.items.forEach((i) => console.log('    ', i.component_name, '=', i.expected_qty));

  const asVerifier = await call('POST', '/orders', ver, {
    recipe_id: 1, target_qty: 50, fabric_roll_id: 'X', actual_fabric_yds: 95,
  });
  console.log('3. Verifier create order    ->', asVerifier.status, '(expect 403)');

  const asSewing = await call('GET', '/orders', sew);
  console.log('4. Sewing list orders       ->', asSewing.status, '(expect 403)');

  const neg = await call('POST', '/orders', sup, {
    recipe_id: 1, target_qty: -5, fabric_roll_id: 'X', actual_fabric_yds: 95,
  });
  console.log('5. Negative quantity        ->', neg.status, '(expect 400)');

  const dec = await call('POST', '/orders', sup, {
    recipe_id: 1, target_qty: 2.5, fabric_roll_id: 'X', actual_fabric_yds: 95,
  });
  console.log('6. Decimal quantity         ->', dec.status, '(expect 400)');

  const noAuth = await call('GET', '/orders', null);
  console.log('7. No token                 ->', noAuth.status, '(expect 401)');
}

main().catch((e) => console.error('TEST ERROR:', e.message));