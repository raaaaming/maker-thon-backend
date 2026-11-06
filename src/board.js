import { check, ID } from './validate.js';

// Converts the board's upload envelope (device/main.py "Uploader") into the
// event shape that deviceEventInput() validates, plus the full packet to keep.
//
// Envelope: { schema_version: 1, device_id, session_id, packet: { timestamp, session:{mode,seated_s,recorded_s},
//             optical_sensor_data, gas_sensor_data, ai_inference_result }, gas_series? }

// Sensor color name (Korean, from estimate_color) -> app stool color enum.
// The sensor cannot tell stool from urine, so the estimate is stored as stool_color only.
export function stoolColorFromName(name) {
  if (typeof name !== 'string') return null;
  const dark = name.startsWith('짙은 ');
  const base = name.replace(/^(짙은|밝은) /, '');
  if (base.startsWith('검정')) return 'black';
  if (base.startsWith('회백색')) return 'pale';
  if (base === '흰색') return 'white';
  if (base.endsWith('회색')) return 'gray';
  if (base === '붉은색') return 'red';
  if (base === '적갈색') return 'dark_brown';
  if (base === '갈색') return dark ? 'dark_brown' : 'brown';
  if (base === '황갈색') return 'brown';
  if (['주황색', '노란색', '연두빛 노란색'].includes(base)) return 'yellow';
  if (['올리브색', '녹색'].includes(base)) return 'green';
  return null; // 청색, 보라·분홍색 등
}

const POOR_QUALITY = ['spectrum_saturated', 'ambient_light_unstable', 'low_led_signal'];
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export function boardSessionToEvent(body, { deviceId, now, claimWindowMs }) {
  check(body.schema_version === 1, '지원하지 않는 전송 형식이에요.');
  check(body.device_id === deviceId, '등록된 기기 ID를 사용해 주세요.');
  check(typeof body.session_id === 'string' && ID.test(body.session_id), '세션 ID를 확인해 주세요.');
  const p = body.packet;
  check(isObj(p) && isObj(p.session) && typeof p.timestamp === 'string', '측정 패킷을 확인해 주세요.');
  const start = Date.parse(p.timestamp);
  const seated = num(p.session.seated_s), recorded = num(p.session.recorded_s);
  check(Number.isFinite(start) && seated !== null && recorded !== null && seated >= 0, '측정 시간을 확인해 주세요.');
  const total = Math.max(recorded, seated);
  const ended = start + seated * 1000, completed = start + total * 1000;

  // The board does not report whether its clock is synced. Treat it as synced only if the
  // completion time is plausible against the server clock (not in the future, not stale).
  const lag = now - completed;
  const clock_status = lag >= -60_000 && lag <= claimWindowMs ? 'synced' : 'unknown';
  // Desk-test ("timed") sessions do not observe a real sitting period.
  const sensorTimed = p.session.mode === 'tof';

  const opt = isObj(p.optical_sensor_data) ? p.optical_sensor_data : {};
  const flags = Array.isArray(opt.flags) ? opt.flags.filter(f => typeof f === 'string') : [];
  const after = isObj(opt.features) && isObj(opt.features.after) ? opt.features.after : null;
  const mapped = stoolColorFromName(after?.estimated_color?.name);
  const poor = flags.some(f => POOR_QUALITY.includes(f));
  let color_status, stool_color = null;
  if (flags.includes('R1_missing')) color_status = 'failed';
  else if (!after?.estimated_color) color_status = 'unmeasured'; // e.g. no white reference
  else if (poor || !mapped) color_status = 'uncertain';          // never raise color alerts from poor data
  else { color_status = 'classified'; stool_color = mapped; }

  const net = isObj(opt.spectrum_net_counts) ? Object.values(opt.spectrum_net_counts) : [];
  const spectral = net.map(num).filter(v => v !== null).map(v => Math.max(0, v));
  const amb = isObj(p.gas_sensor_data?.ambient) ? p.gas_sensor_data.ambient : {};
  const env = { temp_c: num(amb.temperature_c), humidity_pct: num(amb.humidity_pct) };

  return {
    event: {
      device_id: deviceId, session_id: body.session_id, measurement_status: 'completed',
      time_source: sensorTimed ? 'sensor' : 'unknown', clock_status,
      started_at: new Date(start).toISOString(), ended_at: new Date(ended).toISOString(), completed_at: new Date(completed).toISOString(),
      sitting_sec: sensorTimed ? seated : null,
      stool_color, urine_color: null, color_status,
      spectral_raw: spectral.length ? spectral : null,
      env: env.temp_c === null && env.humidity_pct === null ? null : env,
    },
    analysis: p, // full packet (gas features, spectrum, flags) kept for later analysis
  };
}
