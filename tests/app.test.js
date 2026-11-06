import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store-memory.js';

const DEVICE_TOKEN = 'device-secret', PAIRING = 'pair-code';

function setup(overrides = {}) {
  let t = Date.parse('2026-11-06T06:00:00Z');
  const clock = { now: () => t, advance: ms => { t += ms; } };
  const store = createMemoryStore();
  store.tables.devices.push({ id: 'toilet-01', name: '우리 변기', last_seen_at: null });
  const config = createConfig({}, { deviceToken: DEVICE_TOKEN, pairingCode: PAIRING, allowedOrigins: ['https://app.test'], now: clock.now, ...overrides });
  const verifyToken = async token => {
    if (!token.startsWith('user:')) throw new Error('bad');
    return { id: `00000000-0000-4000-8000-00000000000${token.slice(5)}`, email: `u${token.slice(5)}@example.com` };
  };
  const app = createApp({ config, store, verifyToken });
  const call = async (method, path, { token, device, body, origin } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer user:${token}`;
    if (device) headers.authorization = `Bearer ${device}`;
    if (origin) headers.origin = origin;
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  return { call, store, clock, config };
}

const sensorEvent = (clock, over = {}) => {
  const end = clock.now() - 60_000;
  return { device_id: 'toilet-01', session_id: 's1', measurement_status: 'completed', is_demo: false, time_source: 'sensor',
    clock_status: 'synced', started_at: new Date(end - 120_000).toISOString(), ended_at: new Date(end).toISOString(),
    completed_at: new Date(end + 5_000).toISOString(), sitting_sec: 120, stool_color: 'brown', color_status: 'measured', ...over };
};

test('health, auth required, and bad tokens are rejected', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/health')).data.ok, true);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/records')).status, 401);
  assert.equal((await call('GET', '/api/me', { token: undefined, device: 'garbage' })).status, 401);
});

test('CORS only echoes allowed origins', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/health', { origin: 'https://app.test' })).headers.get('access-control-allow-origin'), 'https://app.test');
  assert.equal((await call('GET', '/api/health', { origin: 'https://evil.test' })).headers.get('access-control-allow-origin'), null);
});

test('board auth: missing/wrong token rejected, unconfigured token is a 503', async () => {
  const { call, clock } = setup();
  assert.equal((await call('POST', '/api/device/events', { body: sensorEvent(clock) })).status, 401);
  assert.equal((await call('POST', '/api/device/events', { device: 'nope', body: sensorEvent(clock) })).status, 401);
  const s2 = setup({ deviceToken: '' });
  assert.equal((await s2.call('POST', '/api/device/events', { device: 'x', body: sensorEvent(s2.clock) })).status, 503);
});

test('full flow: pair, board event, claim, edit, delete, no resurrection', async () => {
  const { call, clock, store } = setup();
  assert.equal((await call('POST', '/api/devices/join', { token: '1', body: { device_id: 'toilet-01', code: 'wrong' } })).status, 403);
  assert.equal((await call('POST', '/api/devices/join', { token: '1', body: { device_id: 'toilet-01', code: PAIRING } })).data.devices.length, 1);
  await call('POST', '/api/device/heartbeat', { device: DEVICE_TOKEN, body: { device_id: 'toilet-01' } });

  const ev = sensorEvent(clock);
  assert.equal((await call('POST', '/api/device/events', { device: DEVICE_TOKEN, body: ev })).status, 200);
  assert.equal((await call('POST', '/api/device/events', { device: DEVICE_TOKEN, body: ev })).data.duplicate, true);

  const ctx = (await call('GET', '/api/devices/toilet-01/context', { token: '1' })).data;
  assert.equal(ctx.state, 'idle'); assert.equal(ctx.candidates.length, 1);
  // a user who is not paired cannot see the device
  assert.equal((await call('GET', '/api/devices/toilet-01/context', { token: '2' })).status, 403);

  const shape = { shape: 4, shape_status: 'selected', excretion_type: 'stool' };
  assert.equal((await call('POST', '/api/sessions/s1/claim', { token: '2', body: shape })).status, 403);
  const claimed = await call('POST', '/api/sessions/s1/claim', { token: '1', body: shape });
  assert.equal(claimed.status, 200); assert.equal(claimed.data.record.shape, 4);
  assert.equal((await call('POST', '/api/sessions/s1/claim', { token: '1', body: shape })).status, 200); // idempotent
  assert.equal(store.tables.toilet_sessions[0].user_id, '00000000-0000-4000-8000-000000000001');

  // other users never see it
  assert.equal((await call('GET', '/api/records', { token: '2' })).data.records.length, 0);
  assert.equal((await call('PATCH', '/api/records/s1', { token: '2', body: shape })).status, 404);
  assert.equal((await call('DELETE', '/api/records/s1', { token: '2' })).status, 404);

  const patched = await call('PATCH', '/api/records/s1', { token: '1', body: { shape: null, shape_status: 'unknown', excretion_type: 'both' } });
  assert.equal(patched.data.record.shape_status, 'unknown');

  assert.equal((await call('DELETE', '/api/records/s1', { token: '1' })).status, 200);
  assert.equal((await call('POST', '/api/device/events', { device: DEVICE_TOKEN, body: ev })).data.deleted, true);
  assert.equal(store.tables.toilet_sessions.length, 0);
});

test('claim window, double claim, and invalid shapes', async () => {
  const { call, clock } = setup();
  await call('POST', '/api/devices/join', { token: '1', body: { device_id: 'toilet-01', code: PAIRING } });
  await call('POST', '/api/devices/join', { token: '2', body: { device_id: 'toilet-01', code: PAIRING } });
  await call('POST', '/api/device/events', { device: DEVICE_TOKEN, body: sensorEvent(clock) });
  const bad = await call('POST', '/api/sessions/s1/claim', { token: '1', body: { shape: 9, shape_status: 'selected', excretion_type: 'stool' } });
  assert.equal(bad.status, 400);
  const ok = { shape: 3, shape_status: 'selected', excretion_type: 'stool' };
  assert.equal((await call('POST', '/api/sessions/s1/claim', { token: '1', body: ok })).status, 200);
  assert.equal((await call('POST', '/api/sessions/s1/claim', { token: '2', body: ok })).status, 409);

  await call('POST', '/api/device/events', { device: DEVICE_TOKEN, body: sensorEvent(clock, { session_id: 's2' }) });
  clock.advance(11 * 60_000);
  assert.equal((await call('POST', '/api/sessions/s2/claim', { token: '2', body: ok })).status, 410);
});

test('board event validation and measuring -> completed lifecycle', async () => {
  const { call, clock, store } = setup();
  const post = body => call('POST', '/api/device/events', { device: DEVICE_TOKEN, body });
  assert.equal((await post({ ...sensorEvent(clock), device_id: 'other' })).status, 400);
  assert.equal((await post({ ...sensorEvent(clock), stool_color: 'purple' })).status, 400);
  assert.equal((await post({ ...sensorEvent(clock), ended_at: '2026-11-06 06:00' })).status, 400);
  assert.equal((await post({ ...sensorEvent(clock), spectral_raw: [1, 'x'] })).status, 400);

  const start = new Date(clock.now() - 30_000).toISOString();
  assert.equal((await post({ device_id: 'toilet-01', session_id: 'm1', measurement_status: 'measuring', time_source: 'sensor',
    clock_status: 'synced', started_at: start, color_status: 'unmeasured' })).status, 200);
  await call('POST', '/api/device/heartbeat', { device: DEVICE_TOKEN, body: { device_id: 'toilet-01' } });
  await call('POST', '/api/devices/join', { token: '1', body: { device_id: 'toilet-01', code: PAIRING } });
  assert.equal((await call('GET', '/api/devices/toilet-01/context', { token: '1' })).data.state, 'measuring');

  const end = clock.now();
  assert.equal((await post({ device_id: 'toilet-01', session_id: 'm1', measurement_status: 'completed', time_source: 'sensor',
    clock_status: 'synced', started_at: start, ended_at: new Date(end).toISOString(), completed_at: new Date(end).toISOString(),
    sitting_sec: 30, color_status: 'measured', stool_color: 'green' })).status, 200);
  assert.equal(store.tables.toilet_sessions[0].measurement_status, 'completed');
  // sessions under 20 seconds are discarded
  await post({ ...sensorEvent(clock, { session_id: 'short', sitting_sec: 5, started_at: new Date(clock.now() - 65_000).toISOString() }) });
  assert.equal(store.tables.toilet_sessions.find(r => r.id === 'short').measurement_status, 'discarded');
});

test('meals: own data only, validation, edit/delete, analyze needs config', async () => {
  const { call, clock } = setup();
  const meal = { foods: [{ name: '현미밥', tags: ['식이섬유'] }], eaten_at: new Date(clock.now() - 3_600_000).toISOString(), keep_photo: false, source: 'manual' };
  const created = await call('POST', '/api/meals', { token: '1', body: meal });
  assert.equal(created.status, 200);
  const id = created.data.meal.id;
  assert.equal((await call('POST', '/api/meals', { token: '1', body: { ...meal, eaten_at: new Date(clock.now() + 3_600_000).toISOString() } })).status, 400);
  assert.equal((await call('POST', '/api/meals', { token: '1', body: { ...meal, foods: [] } })).status, 400);
  assert.equal((await call('GET', '/api/meals', { token: '2' })).data.meals.length, 0);
  assert.equal((await call('PATCH', `/api/meals/${id}`, { token: '2', body: meal })).status, 404);
  assert.equal((await call('DELETE', `/api/meals/${id}`, { token: '2' })).status, 404);
  assert.equal((await call('PATCH', `/api/meals/${id}`, { token: '1', body: { ...meal, foods: [{ name: '샐러드', tags: [] }] } })).data.meal.foods[0].name, '샐러드');
  assert.equal((await call('DELETE', `/api/meals/${id}`, { token: '1' })).status, 200);
  assert.equal((await call('POST', '/api/meals/analyze', { token: '1', body: { image: 'x' } })).status, 503);
});

test('insights and account deletion', async () => {
  const { call, clock, store } = setup();
  await call('POST', '/api/devices/join', { token: '1', body: { device_id: 'toilet-01', code: PAIRING } });
  await call('POST', '/api/device/events', { device: DEVICE_TOKEN, body: sensorEvent(clock, { stool_color: 'red' }) });
  await call('POST', '/api/sessions/s1/claim', { token: '1', body: { shape: 4, shape_status: 'selected', excretion_type: 'stool' } });
  const ins = (await call('GET', '/api/insights', { token: '1' })).data;
  assert.equal(ins.record_count, 1); assert.equal(ins.alerts.length, 1); assert.equal(ins.chart.length, 7);
  assert.equal((await call('GET', '/api/me', { token: '1' })).data.devices.length, 1);

  assert.equal((await call('DELETE', '/api/account', { token: '1' })).status, 200);
  assert.equal(store.tables.toilet_sessions.length, 0);
  assert.equal(store.tables.deleted_sessions.length, 1);
});
