import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { safeEqual } from './auth.js';
import { analyzeFoodPhoto } from './analyze.js';
import { personalAnalysis } from './personal.js';
import { boardSessionToEvent } from './board.js';
import {
  HttpError, fail, check, text, dateField, shapeInput, foodInput, imageInput, deviceEventInput,
  DAY, ID, UUID, ALERT_STOOL,
} from './validate.js';

const JSON_LIMIT = 3 * 1024 * 1024;
const kstDate = ms => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

const publicRecord = r => ({
  id: r.id, device_id: r.device_id, started_at: r.started_at, ended_at: r.ended_at, sitting_sec: r.sitting_sec,
  time_source: r.time_source, stool_color: r.stool_color, urine_color: r.urine_color, color_status: r.color_status,
  shape: r.shape, shape_status: r.shape_status, excretion_type: r.excretion_type,
});
const publicMeal = m => ({ id: m.id, foods: m.foods, eaten_at: m.eaten_at, photo: m.photo, source: m.source });

export function createApp({ config, store, verifyToken }) {
  const app = new Hono();
  const now = () => Number(config.now());
  const iso = ms => new Date(ms).toISOString();

  // Best-effort per-instance limiter (serverless instances do not share memory).
  const limits = new Map();
  function limit(key, max, windowMs) {
    const t = now(); let e = limits.get(key);
    if (!e || e.until <= t) { e = { n: 0, until: t + windowMs }; limits.set(key, e); }
    if (++e.n > max) fail(429, 'RATE_LIMITED', '요청이 많아요. 잠시 후 다시 시도해 주세요.');
    if (limits.size > 5000) for (const [k, v] of limits) if (v.until <= t) limits.delete(k);
  }

  app.use('*', async (c, next) => { await next(); c.header('X-Content-Type-Options', 'nosniff'); c.header('Cache-Control', 'no-store'); });
  app.use('/api/*', cors({
    origin: origin => (config.allowedOrigins.includes(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status);
    console.error('Request failed:', err?.name, err?.code || 'unknown'); // never log messages/details
    return c.json({ error: '서버에서 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', code: 'SERVER_ERROR' }, 500);
  });
  app.notFound(c => c.json({ error: '요청한 기능을 찾을 수 없어요.', code: 'NOT_FOUND' }, 404));

  async function readBody(c) {
    if (Number(c.req.header('content-length') || 0) > JSON_LIMIT) fail(413, 'BODY_TOO_LARGE', '요청이 너무 커요. 사진 크기를 줄여 주세요.');
    let body;
    try { body = await c.req.json(); } catch { fail(400, 'INVALID_JSON', '요청 형식을 확인해 주세요.'); }
    check(body && typeof body === 'object' && !Array.isArray(body));
    return body;
  }

  // ---- public ----
  app.get('/api/health', async c => {
    try { await store.ping(); } catch { fail(503, 'DATABASE_UNAVAILABLE', '데이터베이스에 연결할 수 없어요.'); }
    return c.json({ ok: true });
  });

  // ---- board (device token) ----
  const deviceAuth = async c => {
    if (!config.deviceToken) fail(503, 'DEVICE_NOT_CONFIGURED', '서버에 기기 토큰을 먼저 설정해 주세요.');
    if (!safeEqual(c.req.header('authorization') || '', `Bearer ${config.deviceToken}`)) fail(401, 'DEVICE_UNAUTHORIZED', '기기 인증에 실패했어요.');
    return readBody(c);
  };

  // Heartbeat: only a few whitelisted, size-bounded diagnostics are kept.
  const heartbeatStatus = b => {
    const s = v => (typeof v === 'string' ? v.slice(0, 200) : null);
    const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const sensors = b.sensors && typeof b.sensors === 'object' && !Array.isArray(b.sensors)
      ? Object.fromEntries(Object.entries(b.sensors).slice(0, 8).map(([k, v]) => [k.slice(0, 20), Boolean(v)])) : null;
    return { state: s(b.state), mode: s(b.mode), sensors, in_session: Boolean(b.in_session), warm: Boolean(b.warm),
      outbox_pending: n(b.outbox_pending), uptime_s: n(b.uptime_s), last_upload_error: s(b.last_upload_error) };
  };
  app.post('/api/device/heartbeat', async c => {
    const body = await deviceAuth(c);
    check(body.device_id === config.deviceId, '등록된 기기 ID를 사용해 주세요.');
    await store.update('devices', [['id', 'eq', config.deviceId]], { last_seen_at: iso(now()), status: heartbeatStatus(body) });
    return c.json({ ok: true });
  });

  async function ingest(row, extra = {}) {
    if ((await store.select('deleted_sessions', { where: [['id', 'eq', row.id]] })).length) return { ok: true, deleted: true };
    await store.update('devices', [['id', 'eq', row.device_id]], { last_seen_at: iso(now()) });
    const [old] = await store.select('toilet_sessions', { where: [['id', 'eq', row.id]] });
    // A final sample is immutable, including after ownership is assigned.
    if (old && (old.measurement_status !== 'measuring' || row.measurement_status === 'measuring')) return { ok: true, duplicate: true };
    const received_at = iso(now());
    if (old) {
      await store.update('toilet_sessions', [['id', 'eq', row.id], ['measurement_status', 'eq', 'measuring'], ['user_id', 'is', null]], { ...row, ...extra, received_at });
    } else {
      try { await store.insert('toilet_sessions', { ...row, ...extra, user_id: null, received_at }); }
      catch (e) { if (e.code === '23505') return { ok: true, duplicate: true }; throw e; }
    }
    return { ok: true };
  }

  // Generic event (start/finish) in the normalized shape.
  app.post('/api/device/events', async c => c.json(await ingest(deviceEventInput(await deviceAuth(c), config.deviceId))));

  // Board upload (device/main.py): envelope with the full analysis packet.
  app.post('/api/session', async c => {
    const body = await deviceAuth(c);
    const { event, analysis } = boardSessionToEvent(body, { deviceId: config.deviceId, now: now(), claimWindowMs: config.claimWindowMs, colorGate: config.colorGate });
    return c.json(await ingest(deviceEventInput(event, config.deviceId), { analysis }));
  });

  // ---- user (Supabase Auth JWT) ----
  const requireUser = async (c, next) => {
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') || '');
    if (!m) fail(401, 'AUTH_REQUIRED', '로그인해 주세요.');
    let user;
    try { user = await verifyToken(m[1]); } catch { fail(401, 'AUTH_REQUIRED', '로그인 상태를 확인해 주세요.'); }
    c.set('user', user);
    await next();
  };
  const authed = ['/api/me', '/api/account', '/api/devices/*', '/api/sessions/*', '/api/records', '/api/records/*', '/api/meals', '/api/meals/*', '/api/insights', '/api/insights/*'];
  for (const p of authed) app.use(p, requireUser);

  const memberOf = async (deviceId, userId) => {
    const [m] = await store.select('device_members', { where: [['device_id', 'eq', deviceId], ['user_id', 'eq', userId]] });
    if (!m) fail(403, 'DEVICE_FORBIDDEN', '이 변기에 연결할 권한이 없어요. 연결 코드를 확인해 주세요.');
    const [device] = await store.select('devices', { where: [['id', 'eq', deviceId]] });
    return device;
  };
  const devicesOf = async userId => {
    const links = await store.select('device_members', { where: [['user_id', 'eq', userId]] });
    const out = [];
    for (const l of links) { const [d] = await store.select('devices', { where: [['id', 'eq', l.device_id]] }); if (d) out.push({ id: d.id, name: d.name }); }
    return out;
  };

  app.get('/api/me', async c => {
    const user = c.get('user');
    await store.insert('profiles', { id: user.id, display_name: (user.email || '사용자').split('@')[0].slice(0, 50), created_at: iso(now()) }, { ignoreDuplicates: true });
    const [profile] = await store.select('profiles', { where: [['id', 'eq', user.id]] });
    return c.json({ user: { id: user.id, email: user.email, name: profile?.display_name ?? null }, devices: await devicesOf(user.id),
      config: { aiEnabled: Boolean(config.anthropicKey && config.anthropicModel), claimWindowSec: config.claimWindowMs / 1000 } });
  });

  app.patch('/api/me', async c => {
    const user = c.get('user'), body = await readBody(c);
    const name = text(body.name, 50, '이름');
    await store.upsert('profiles', { id: user.id, display_name: name, created_at: iso(now()) }, 'id');
    return c.json({ ok: true, name });
  });

  app.delete('/api/account', async c => {
    const user = c.get('user');
    // Tombstone the user's sessions so a late board resend cannot resurrect them.
    const mine = await store.select('toilet_sessions', { where: [['user_id', 'eq', user.id]] });
    if (mine.length) await store.insert('deleted_sessions', mine.map(r => ({ id: r.id, device_id: r.device_id })), { ignoreDuplicates: true });
    await store.deleteUser(user.id); // FK cascades remove profile, memberships, sessions, meals
    return c.json({ ok: true });
  });

  app.post('/api/devices/join', async c => {
    const user = c.get('user'), body = await readBody(c);
    limit(`pair:${user.id}`, 10, 15 * 60_000);
    check(body.device_id === config.deviceId, '기기 ID를 확인해 주세요.');
    if (!config.pairingCode) fail(503, 'PAIRING_NOT_CONFIGURED', '변기 연결 코드를 서버에 먼저 설정해 주세요.');
    if (!safeEqual(body.code, config.pairingCode)) fail(403, 'INVALID_PAIRING_CODE', '연결 코드가 맞지 않아요.');
    await store.insert('device_members', { device_id: body.device_id, user_id: user.id }, { ignoreDuplicates: true });
    return c.json({ devices: await devicesOf(user.id) });
  });

  // NFC tag tap: the app opens /checkin?device=<id> and reports "this user is at this toilet now".
  app.post('/api/devices/:id/checkins', async c => {
    const user = c.get('user'), device = await memberOf(c.req.param('id'), user.id);
    await store.upsert('checkins', { device_id: device.id, user_id: user.id, checked_at: iso(now()) }, 'device_id,user_id');
    return c.json({ ok: true });
  });

  app.get('/api/devices/:id/context', async c => {
    const user = c.get('user'), device = await memberOf(c.req.param('id'), user.id), t = now();
    const base = [['device_id', 'eq', device.id], ['user_id', 'is', null], ['measurement_status', 'eq', 'completed'], ['clock_status', 'eq', 'synced']];
    const candidates = (await store.select('toilet_sessions', { order: ['ended_at', 'desc'], where: [...base,
      ['ended_at', 'gte', iso(t - config.claimWindowMs)], ['ended_at', 'lte', iso(t)], ['completed_at', 'lte', iso(t)]] }))
      .map(r => ({ id: r.id, started_at: r.started_at, ended_at: r.ended_at, sitting_sec: r.sitting_sec }));
    const expired = (await store.select('toilet_sessions', { where: [...base, ['ended_at', 'lt', iso(t - config.claimWindowMs)]], limit: 1000 })).length;
    const [measuring] = await store.select('toilet_sessions', { order: ['received_at', 'desc'], limit: 1,
      where: [['device_id', 'eq', device.id], ['measurement_status', 'eq', 'measuring'], ['received_at', 'gte', iso(t - DAY)]] });
    const offline = !device.last_seen_at || t - Date.parse(device.last_seen_at) > config.offlineAfterMs;
    const startedOk = measuring?.started_at && measuring.clock_status === 'synced' && Date.parse(measuring.started_at) <= t;
    return c.json({ device: { id: device.id, name: device.name }, state: offline ? 'offline' : measuring ? 'measuring' : 'idle',
      active_started_at: startedOk ? measuring.started_at : null, candidates, expired_count: expired, server_now: iso(t) });
  });

  app.post('/api/sessions/:id/claim', async c => {
    const user = c.get('user'), body = await readBody(c), id = c.req.param('id'), t = now();
    check(ID.test(id));
    const shape = shapeInput(body);
    const [row] = await store.select('toilet_sessions', { where: [['id', 'eq', id]] });
    if (!row) fail(404, 'SESSION_NOT_FOUND', '기록을 찾을 수 없어요.');
    await memberOf(row.device_id, user.id);
    if (row.user_id === user.id) return c.json({ record: publicRecord(row) }); // idempotent retry
    if (row.user_id !== null) fail(409, 'ALREADY_CLAIMED', '이미 연결된 기록이에요. 다른 사용 시각을 확인해 주세요.');
    if (row.measurement_status !== 'completed') fail(409, 'SESSION_NOT_COMPLETE', '측정이 완료된 후 저장할 수 있어요.');
    if (row.clock_status !== 'synced' || !row.ended_at || !row.completed_at || Date.parse(row.ended_at) > t || Date.parse(row.completed_at) > t)
      fail(409, 'SESSION_TIME_INVALID', '사용 시각을 확인할 수 없어 연결하지 않았어요.');
    if (t - Date.parse(row.ended_at) > config.claimWindowMs) fail(410, 'CLAIM_EXPIRED', `종료 후 ${config.claimWindowMs / 60_000}분이 지나 연결할 수 없어요.`);
    // Atomic: only succeeds while the row is still unowned.
    const won = await store.update('toilet_sessions', [['id', 'eq', id], ['user_id', 'is', null]], { user_id: user.id, ...shape, claimed_at: iso(t) });
    if (won.length !== 1) fail(409, 'ALREADY_CLAIMED', '이미 연결된 기록이에요.');
    return c.json({ record: publicRecord(won[0]) });
  });

  app.get('/api/records', async c => {
    const rows = await store.select('toilet_sessions', { where: [['user_id', 'eq', c.get('user').id]], order: ['ended_at', 'desc'] });
    return c.json({ records: rows.map(publicRecord) });
  });

  app.patch('/api/records/:id', async c => {
    const user = c.get('user'), body = await readBody(c), id = c.req.param('id');
    const [row] = await store.select('toilet_sessions', { where: [['id', 'eq', id], ['user_id', 'eq', user.id]] });
    if (!row) fail(404, 'RECORD_NOT_FOUND', '내 기록을 찾을 수 없어요.');
    if (now() - Date.parse(row.ended_at) > DAY) fail(403, 'EDIT_EXPIRED', '사용 종료 후 24시간 이내에만 수정할 수 있어요.');
    const [u] = await store.update('toilet_sessions', [['id', 'eq', id], ['user_id', 'eq', user.id]], shapeInput(body));
    return c.json({ record: publicRecord(u) });
  });

  app.delete('/api/records/:id', async c => {
    const user = c.get('user'), id = c.req.param('id');
    const [row] = await store.select('toilet_sessions', { where: [['id', 'eq', id], ['user_id', 'eq', user.id]] });
    if (!row) fail(404, 'RECORD_NOT_FOUND', '내 기록을 찾을 수 없어요.');
    await store.insert('deleted_sessions', { id: row.id, device_id: row.device_id }, { ignoreDuplicates: true });
    await store.remove('toilet_sessions', [['id', 'eq', id], ['user_id', 'eq', user.id]]);
    return c.json({ ok: true });
  });

  // ---- meals ----
  app.post('/api/meals/analyze', async c => {
    const user = c.get('user'), body = await readBody(c);
    limit(`ai:${user.id}`, 10, 60_000);
    return c.json(await analyzeFoodPhoto(config, body.image));
  });

  app.get('/api/meals', async c => {
    const rows = await store.select('meals', { where: [['user_id', 'eq', c.get('user').id]], order: ['eaten_at', 'desc'] });
    return c.json({ meals: rows.map(publicMeal) });
  });

  app.post('/api/meals', async c => {
    const user = c.get('user'), body = await readBody(c);
    const foods = foodInput(body.foods), eaten = dateField(body.eaten_at);
    check(Date.parse(eaten) <= now() + 60_000, '미래 식사는 기록할 수 없어요.');
    check(typeof body.keep_photo === 'boolean' && ['ai', 'manual'].includes(body.source));
    if (body.photo !== null && body.photo !== undefined) imageInput(body.photo);
    const photo = body.keep_photo ? body.photo ?? null : null;
    const [m] = await store.insert('meals', { id: randomUUID(), user_id: user.id, foods, eaten_at: eaten, photo, source: body.source, created_at: iso(now()) });
    return c.json({ meal: publicMeal(m) });
  });

  const ownMeal = async (c, id) => {
    check(UUID.test(id));
    const [m] = await store.select('meals', { where: [['id', 'eq', id], ['user_id', 'eq', c.get('user').id]] });
    if (!m) fail(404, 'MEAL_NOT_FOUND', '내 식사 기록을 찾을 수 없어요.');
    return m;
  };
  app.patch('/api/meals/:id', async c => {
    const m = await ownMeal(c, c.req.param('id')), body = await readBody(c);
    const foods = foodInput(body.foods), eaten = dateField(body.eaten_at);
    check(Date.parse(eaten) <= now() + 60_000, '미래 식사는 기록할 수 없어요.');
    const [u] = await store.update('meals', [['id', 'eq', m.id], ['user_id', 'eq', m.user_id]], { foods, eaten_at: eaten });
    return c.json({ meal: publicMeal(u) });
  });
  app.delete('/api/meals/:id', async c => {
    const m = await ownMeal(c, c.req.param('id'));
    await store.remove('meals', [['id', 'eq', m.id], ['user_id', 'eq', m.user_id]]);
    return c.json({ ok: true });
  });

  // ---- insights (rule based, no diagnosis) ----
  app.get('/api/insights', async c => {
    const uid = c.get('user').id, t = now();
    const start = Date.parse(`${kstDate(t)}T00:00:00+09:00`) - 6 * DAY;
    const records = await store.select('toilet_sessions', { order: ['ended_at', 'asc'],
      where: [['user_id', 'eq', uid], ['ended_at', 'gte', iso(start)], ['ended_at', 'lte', iso(t)]] });
    const meals = await store.select('meals', { where: [['user_id', 'eq', uid], ['eaten_at', 'gte', iso(start)], ['eaten_at', 'lte', iso(t)]] });
    const bowel = records.filter(r => ['stool', 'both'].includes(r.excretion_type));
    const days = new Set(records.map(r => kstDate(Date.parse(r.ended_at)))).size;
    const secs = bowel.filter(r => r.time_source === 'sensor' && r.sitting_sec !== null).map(r => r.sitting_sec);
    const average = secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null;
    const fiberMeals = meals.filter(m => m.foods.some(f => f.tags.some(tag => /식이섬유|fiber/i.test(tag)))).length;
    const chart = Array.from({ length: 7 }, (_, i) => { const d = kstDate(start + i * DAY); return { date: d, count: bowel.filter(r => kstDate(Date.parse(r.ended_at)) === d).length }; });
    const alerts = records.filter(r => ALERT_STOOL.includes(r.stool_color)).map(r => ({ id: `color-${r.id}`, title: '색을 직접 확인해 주세요',
      description: '센서 색 추정은 정확하지 않을 수 있어요. 실제 검은색·붉은색·회백색 변이 보이면 의료진에게 상담해 주세요. 진단이 아니에요.' }));
    const items = days < 3
      ? [{ title: '기록이 더 모이면 알려드릴게요', description: '서로 다른 3일 이상 기록하면 최근 7일의 변화를 함께 볼 수 있어요.', basis: `최근 7일 중 ${days}일 기록` }]
      : [{ title: '기록에서 보이는 배변 횟수', description: `최근 7일에 배변을 ${bowel.length}회 기록했어요. 기록이 없는 날은 배변이 없었다는 뜻이 아니에요.`, basis: `대변·둘 다 ${bowel.length}회, 소변만·모름 제외` },
        ...(average !== null ? [{ title: '앉아 있던 시간을 돌아봐요', description: `평균 사용 시간은 ${Math.floor(average / 60)}분 ${average % 60}초예요.`, basis: `센서 시간 ${secs.length}건 · 미측정 제외` }] : []),
        { title: '음식 태그와 변 모양', description: `식이섬유 태그 식사를 ${fiberMeals}회 기록했어요. 변 모양과의 관련성이나 원인은 단정할 수 없어요.`, basis: `최근 7일 식사 ${meals.length}회 중 식이섬유 태그 ${fiberMeals}회` }];
    return c.json({ days, record_count: bowel.length, meal_count: meals.length, average_sitting_sec: average,
      average_sample_count: secs.length, items: items.slice(0, 3), alerts, chart, source: 'rules' });
  });

  // Personal AI analysis of the last 7 days (+ the 21 days before). Falls back to a rules summary.
  app.post('/api/insights/analyze', async c => {
    const uid = c.get('user').id, t = now();
    limit(`insight:${uid}`, 5, 60_000);
    const from = Date.parse(`${kstDate(t)}T00:00:00+09:00`) - 27 * DAY;
    const records = await store.select('toilet_sessions', { order: ['ended_at', 'asc'],
      where: [['user_id', 'eq', uid], ['ended_at', 'gte', iso(from)], ['ended_at', 'lte', iso(t)]] });
    const meals = await store.select('meals', { where: [['user_id', 'eq', uid], ['eaten_at', 'gte', iso(from)], ['eaten_at', 'lte', iso(t)]] });
    return c.json(await personalAnalysis(config, records, meals, t));
  });

  return app;
}
