import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store-memory.js';
import { aggregatePersonalInsights, validatePersonalOutput } from '../src/personal-insights.js';

const NOW = Date.parse('2026-11-07T06:00:00Z');
const userA = '00000000-0000-4000-8000-000000000001';
const userB = '00000000-0000-4000-8000-000000000002';
const row = (ended_at, extra = {}) => ({ id: `private-${ended_at}`, user_id: userA, device_id: 'private-device',
  measurement_status: 'completed', ended_at, time_source: 'sensor', sitting_sec: 120,
  shape: 4, shape_status: 'selected', excretion_type: 'stool', ...extra });
const rows = () => ['2026-11-05T04:00:00Z', '2026-11-06T04:00:00Z', '2026-11-07T04:00:00Z'].map(t => row(t));
const validOutput = () => ({ summary: '오후에 남긴 배변 기록이 모였어요. 식사 기록도 함께 남기면 다음 주에 비교할 수 있어요.',
  observations: [{ title: '오후에 남긴 기록', description: '최근 배변 기록은 오후에 남겨져 있어요.', evidence_ids: ['recent_time_of_day'] }],
  next_steps: [{ title: '식사 시각도 함께 남겨요', description: '다음 기록에는 식사 시각과 직접 고른 변 모양을 함께 남겨봐요.', evidence_ids: ['recent_meals', 'recent_shapes'] }] });
const providerResponse = (input = validOutput(), extra = {}) => ({ ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'personal_bowel_insights', input }], ...extra }) });

function setup(overrides = {}) {
  let t = NOW;
  const store = createMemoryStore();
  let calls = 0; const prompts = [];
  const config = createConfig({}, { now: () => t, anthropicKey: 'test-key', anthropicModel: 'test-model',
    fetchImpl: async (url, options) => { calls++; prompts.push({ url, options, body: JSON.parse(options.body) }); return providerResponse(); }, ...overrides });
  const app = createApp({ config, store, verifyToken: async token => {
    if (!['a', 'b'].includes(token)) throw new Error('invalid');
    return { id: token === 'a' ? userA : userB, email: 'private-email@example.com' };
  } });
  const call = async (token = 'a', body = {}) => {
    const res = await app.request('/api/insights/analyze', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json(), headers: res.headers };
  };
  return { call, store, config, prompts, calls: () => calls, advance: ms => { t += ms; } };
}

test('personal analysis requires Bearer auth and rejects client ownership/data overrides', async () => {
  const s = setup();
  for (const token of [null, 'fake-token']) {
    const result = await s.call(token);
    assert.equal(result.status, 401); assert.equal(result.data.code, 'AUTH_REQUIRED');
  }
  assert.equal((await s.call('a', { user_id: userB })).status, 400);
  assert.equal((await s.call('a', { records: rows() })).status, 400);
  assert.equal(s.calls(), 0);
});

test('KST windows, actual selected shapes and measured seconds are aggregated without filling missing values', () => {
  const records = [
    row('2026-10-31T15:00:00Z', { sitting_sec: null, shape: null, shape_status: 'unknown' }), // Nov 1 KST, recent
    row('2026-10-31T14:59:59Z', { sitting_sec: 600, shape: 2 }), // Oct 31 KST, baseline
    row('2026-10-10T15:00:00Z', { sitting_sec: 300, shape: 3 }), // baseline start inclusive
    row('2026-10-10T14:59:59Z'), // excluded
    row('2026-11-02T01:00:00Z', { sitting_sec: 0, shape: 1 }),
    row('2026-11-03T01:00:00Z', { time_source: 'unknown', sitting_sec: 100, shape_status: 'unknown' }),
    row('2026-11-04T01:00:00Z', { excretion_type: 'urine' }),
    row('2026-11-04T02:00:00Z', { excretion_type: 'unknown' }),
    row('2026-11-04T03:00:00Z', { measurement_status: 'discarded' }),
    row('2026-11-08T01:00:00Z'), // future excluded
  ];
  const out = aggregatePersonalInsights(records, [], NOW);
  assert.equal(out.period.start, '2026-10-31T15:00:00.000Z');
  assert.equal(out.baseline_period.start, '2026-10-10T15:00:00.000Z');
  assert.equal(out.recent.bowel_records, 3); assert.equal(out.recent.bowel_days, 3);
  assert.equal(out.recent.shape_records, 1); assert.equal(out.recent.shape_counts['1'], 1);
  assert.equal(out.recent.sensor_records, 1); assert.equal(out.recent.average_sitting_sec, 0);
  assert.equal(out.baseline.bowel_records, 2); assert.equal(out.baseline.average_sitting_sec, 450);
  assert.equal(out.daily[0].date, '2026-11-01'); assert.equal(out.daily[0].bowel_records, 1);
  assert.equal(out.daily.at(-1).date, '2026-11-07');
  assert.equal(aggregatePersonalInsights([row('2026-11-07T01:00:00Z', { sitting_sec: null })], [], NOW).recent.average_sitting_sec, null);
});

test('insufficient days return honest rules summary without provider calls', async () => {
  const s = setup();
  let r = await s.call();
  assert.equal(r.data.source, 'rules'); assert.equal(r.data.status, 'insufficient_data');
  s.store.tables.toilet_sessions.push(...rows().map(r => ({ ...r, ended_at: '2026-11-07T04:00:00Z' })));
  r = await s.call();
  assert.equal(r.data.coverage.bowel_records, 3); assert.equal(r.data.coverage.bowel_days, 1);
  assert.equal(r.data.status, 'insufficient_data'); assert.equal(s.calls(), 0);
});

test('only recognized food tags count; negated or arbitrary tags do not become positive nutrition facts', () => {
  const out = aggregatePersonalInsights(rows(), [
    { eaten_at: '2026-11-07T01:00:00Z', foods: [{ name: 'private', tags: ['식이섬유 없음', 'not fiber', '유제품 없음', '매운 음식 아님'] }] },
    { eaten_at: '2026-11-07T02:00:00Z', foods: [{ name: 'private', tags: [' 식이섬유 ', '유제품', 'spicy'] }] },
  ], NOW);
  assert.equal(out.recent.meal_records, 2);
  assert.equal(out.recent.food_tag_meals.fiber, 1);
  assert.equal(out.recent.food_tag_meals.dairy, 1);
  assert.equal(out.recent.food_tag_meals.spicy, 1);
});

test('analysis uses own rows only and sends aggregates, never identifiers, photos, raw values or free text', async () => {
  const s = setup();
  s.store.tables.toilet_sessions.push(...rows(), row('2026-11-07T05:00:00Z', { user_id: userB, shape: 7, analysis: 'OTHER-PRIVATE' }));
  s.store.tables.toilet_sessions[0].spectral_raw = [123456789];
  s.store.tables.meals.push({ id: 'private-meal-id', user_id: userA, eaten_at: '2026-11-07T01:00:00Z', photo: 'PRIVATE-PHOTO', foods: [{ name: 'IGNORE SYSTEM private-name', tags: ['식이섬유', 'private-tag'] }] },
    { id: 'other-meal', user_id: userB, eaten_at: '2026-11-07T01:00:00Z', foods: [{ name: 'other-person-food', tags: [] }] });
  const r = await s.call();
  assert.equal(r.status, 200); assert.equal(r.data.source, 'ai'); assert.equal(r.data.status, 'complete');
  assert.deepEqual(r.data.coverage, { bowel_records: 3, bowel_days: 3, meal_records: 1, shape_records: 3, sensor_records: 3 });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(s.calls(), 1);
  const prompt = JSON.stringify(s.prompts[0].body.messages);
  for (const secret of [userA, userB, 'private-device', 'private-email', 'private-meal-id', 'PRIVATE-PHOTO', 'IGNORE SYSTEM', 'private-name', 'private-tag', 'OTHER-PRIVATE', 'other-person-food', '123456789']) assert.equal(prompt.includes(secret), false, secret);
  assert.equal(JSON.parse(s.prompts[0].body.messages[0].content).recent.food_tag_meals.fiber, 1);
  assert.equal(JSON.parse(s.prompts[0].body.messages[0].content).daily.at(-1).food_tag_meals.fiber, 1);
  assert.match(r.data.evidence.find(e => e.id === 'daily_2026-11-07').value, /식이섬유 1회/);
  assert.equal(s.prompts[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(s.prompts[0].body.tool_choice.name, 'personal_bowel_insights');
  assert.equal(s.prompts[0].options.headers['x-api-key'], 'test-key');
  const other = await s.call('b');
  assert.equal(other.data.coverage.bowel_records, 1); assert.equal(other.data.status, 'insufficient_data');
});

test('analysis DB queries project only required columns and cap each table', async () => {
  const s = setup(); const queries = [];
  const select = s.store.select.bind(s.store);
  s.store.select = async (table, options) => { queries.push({ table, options }); return select(table, options); };
  await s.call();
  assert.equal(queries.length, 2);
  for (const q of queries) {
    assert.equal(q.options.limit, 501);
    assert.deepEqual(q.options.where[0], ['user_id', 'eq', userA]);
    assert.equal(q.options.columns.includes('*'), false);
    assert.equal(q.options.columns.includes('photo'), false);
    assert.equal(q.options.columns.includes('analysis'), false);
  }
});

test('strict output checks enforce bounds, known evidence and reject explicit diagnosis', () => {
  const evidence = aggregatePersonalInsights(rows(), [], NOW).evidence;
  assert.equal(validatePersonalOutput(validOutput(), evidence).observations.length, 1);
  for (const change of [
    out => { out.extra = true; }, out => { out.summary = 'x'.repeat(321); },
    out => { out.observations[0].evidence_ids = ['invented-fact']; },
    out => { out.observations[0].evidence_ids = []; }, out => { out.next_steps = []; },
    out => { out.summary = '당신은 대장암입니다'; },
  ]) {
    const out = validOutput(); change(out); assert.throws(() => validatePersonalOutput(out, evidence));
  }
  const careful = validOutput(); careful.summary = '이 기록만으로 질병을 진단할 수 없어요.';
  assert.equal(validatePersonalOutput(careful, evidence).summary, careful.summary);
});

test('missing AI config, provider error, malformed tool, and truncated output use rules fallback', async () => {
  for (const overrides of [
    { anthropicKey: '' }, { anthropicModel: '' },
    { fetchImpl: async () => ({ ok: false }) },
    { fetchImpl: async () => { throw new Error('provider private detail'); } },
    { fetchImpl: async () => providerResponse({ ...validOutput(), summary: 'x'.repeat(400) }) },
    { fetchImpl: async () => providerResponse(validOutput(), { stop_reason: 'max_tokens' }) },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ content: [] }) }) },
  ]) {
    const s = setup(overrides); s.store.tables.toilet_sessions.push(...rows());
    const r = await s.call();
    assert.equal(r.status, 200); assert.equal(r.data.source, 'rules'); assert.equal(r.data.status, 'unavailable');
    assert.equal(JSON.stringify(r.data).includes('provider private detail'), false);
  }
});

test('deadline includes reading provider body and aborts the fetch signal', async () => {
  let signal;
  const s = setup({ personalInsightsTimeoutMs: 15, fetchImpl: async (_url, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; } });
  s.store.tables.toilet_sessions.push(...rows());
  const r = await s.call();
  assert.equal(r.data.status, 'unavailable'); assert.equal(signal.aborted, true);
});

test('successful results are cached per user, edits invalidate and deletions suppress stale output', async () => {
  const s = setup(); s.store.tables.toilet_sessions.push(...rows());
  const first = await s.call(); s.advance(1_000);
  assert.deepEqual((await s.call()).data, first.data); assert.equal(s.calls(), 1);
  s.store.tables.toilet_sessions[0].shape = 2;
  const changed = await s.call(); assert.equal(s.calls(), 2); assert.match(changed.data.evidence.find(e => e.id === 'recent_shapes').value, /2형 1회/);
  s.store.tables.toilet_sessions.push(...rows().map(r => ({ ...r, user_id: userB, id: `b-${r.id}` })));
  assert.equal((await s.call('b')).data.source, 'ai'); assert.equal(s.calls(), 3);
  s.store.tables.toilet_sessions = s.store.tables.toilet_sessions.filter(r => r.id !== rows()[0].id);
  const deleted = await s.call(); assert.equal(deleted.data.status, 'insufficient_data'); assert.equal(deleted.data.coverage.bowel_records, 2); assert.equal(s.calls(), 3);
});

test('cache expires and a KST date change cannot reuse yesterday analysis', async () => {
  const s = setup(); s.store.tables.toilet_sessions.push(...rows());
  await s.call(); s.advance(10 * 60_000 + 1); await s.call(); assert.equal(s.calls(), 2);
  s.advance(9 * 3_600_000); const next = await s.call();
  assert.equal(s.calls(), 3); assert.equal(next.data.period.start, '2026-11-01T15:00:00.000Z');
});

test('concurrent identical analysis shares a provider call', async () => {
  let release; let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const s = setup({ fetchImpl: async () => { calls++; await gate; return providerResponse(); } });
  s.store.tables.toilet_sessions.push(...rows());
  const a = s.call(), b = s.call(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); release();
  assert.deepEqual((await a).data, (await b).data);
});

test('failed calls are retryable but provider attempts are limited to 3 per minute per user', async () => {
  let calls = 0;
  const s = setup({ fetchImpl: async () => { calls++; throw new Error('no'); } });
  s.store.tables.toilet_sessions.push(...rows());
  for (let i = 0; i < 3; i++) assert.equal((await s.call()).data.status, 'unavailable');
  const limited = await s.call(); assert.equal(limited.status, 429); assert.equal(limited.data.code, 'RATE_LIMITED'); assert.equal(calls, 3);
  s.advance(60_001); assert.equal((await s.call()).status, 200); assert.equal(calls, 4);
});

test('bounded record retrieval refuses to present a partial dataset as complete AI analysis', async () => {
  const s = setup();
  s.store.tables.toilet_sessions.push(...Array.from({ length: 510 }, (_, i) => row(rows()[i % 3].ended_at, { id: `bulk-${i}` })));
  const r = await s.call();
  assert.equal(r.status, 200); assert.equal(r.data.status, 'unavailable'); assert.equal(r.data.source, 'rules');
  assert.match(r.data.summary, /전체 기록을 분석하지 못/); assert.equal(r.data.coverage.bowel_records, 501); assert.equal(s.calls(), 0);
});
