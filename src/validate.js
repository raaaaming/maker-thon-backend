export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export function check(ok, message = '입력 값을 확인해 주세요.', code = 'INVALID_INPUT') {
  if (!ok) fail(400, code, message);
}

export const DAY = 86_400_000;
export const IMAGE_LIMIT = 2 * 1024 * 1024;
export const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function text(value, max, label, min = 1) {
  check(typeof value === 'string' && value.trim().length >= min && value.trim().length <= max, `${label}을 확인해 주세요.`);
  return value.trim();
}

// Accepts ISO-8601 with an explicit offset; returns normalized UTC ISO or null.
export function dateField(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value), '시간은 시간대가 포함된 ISO 형식이어야 해요.');
  const ms = Date.parse(value);
  check(Number.isFinite(ms) && ms >= Date.UTC(2020, 0, 1) && ms <= Date.UTC(2100, 0, 1), '시간 값을 확인해 주세요.');
  return new Date(ms).toISOString();
}

export function shapeInput(body) {
  const { shape, shape_status, excretion_type } = body;
  check(['stool', 'urine', 'both', 'unknown'].includes(excretion_type));
  check(['selected', 'unknown', 'not_applicable'].includes(shape_status));
  if (excretion_type === 'urine') check(shape === null && shape_status === 'not_applicable', '소변만 기록할 때는 모양이 해당 없음이어야 해요.');
  else if (shape_status === 'selected') check(Number.isInteger(shape) && shape >= 1 && shape <= 7 && excretion_type !== 'unknown', '변 모양을 1~7 중에서 골라 주세요.');
  else check(shape === null && shape_status === 'unknown', '모양을 모르면 모름으로 저장해 주세요.');
  return { shape, shape_status, excretion_type };
}

export function foodInput(foods, allowEmpty = false) {
  check(Array.isArray(foods) && foods.length <= 30 && (allowEmpty || foods.length > 0), '음식을 하나 이상 추가해 주세요.');
  return foods.map(food => {
    check(food && typeof food === 'object' && !Array.isArray(food));
    check(Array.isArray(food.tags) && food.tags.length <= 10);
    return { name: text(food.name, 80, '음식 이름'), tags: [...new Set(food.tags.map(t => text(t, 40, '음식 태그')))] };
  });
}

export function imageInput(image) {
  check(typeof image === 'string' && image.length <= Math.ceil(IMAGE_LIMIT / 3) * 4 + 100, '사진은 2MB 이하로 줄여 주세요.', 'IMAGE_TOO_LARGE');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  check(m && m[2].length % 4 === 0, 'JPEG, PNG, WebP 사진을 선택해 주세요.', 'INVALID_IMAGE');
  const bytes = Buffer.from(m[2], 'base64');
  check(bytes.length > 12 && bytes.length <= IMAGE_LIMIT, '사진은 2MB 이하로 줄여 주세요.', 'IMAGE_TOO_LARGE');
  const ok = m[1] === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : m[1] === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  check(ok, '사진 파일 형식을 확인해 주세요.', 'INVALID_IMAGE');
  return { media_type: m[1], data: m[2] };
}

const STOOL = ['brown', 'dark_brown', 'yellow', 'green', 'black', 'red', 'pale', 'gray', 'white'];
const URINE = ['clear', 'pale_yellow', 'yellow', 'dark_yellow', 'brown'];
export const ALERT_STOOL = ['black', 'red', 'pale', 'gray', 'white'];

// Board measurement event -> normalized session row (without received_at).
export function deviceEventInput(body, deviceId) {
  check(body.device_id === deviceId, '등록된 기기 ID를 사용해 주세요.');
  check(typeof body.session_id === 'string' && ID.test(body.session_id), '세션 ID를 확인해 주세요.');
  check(['measuring', 'completed', 'discarded'].includes(body.measurement_status));
  check(['sensor', 'unknown'].includes(body.time_source));
  check(['synced', 'unknown'].includes(body.clock_status));
  const started = dateField(body.started_at, { nullable: true });
  const ended = dateField(body.ended_at, { nullable: true });
  const completed = dateField(body.completed_at, { nullable: true });
  const sec = body.sitting_sec ?? null;
  check(sec === null || (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 && sec <= DAY / 1000));
  if (body.measurement_status === 'completed') check(ended && completed, '완료 기록에는 종료 시각과 확정 시각이 필요해요.');
  if (body.measurement_status === 'measuring') check(!ended && !completed, '진행 중 기록에 종료 시각을 넣을 수 없어요.');
  if (started && ended) check(started <= ended, '시작·종료 시각의 순서를 확인해 주세요.');
  if (ended && completed) check(ended <= completed, '종료·확정 시각의 순서를 확인해 주세요.');
  if (sec !== null) {
    check(body.time_source === 'sensor' && started, '시작을 관측하지 않은 시간은 미측정으로 보내 주세요.');
    if (ended) check(sec <= (Date.parse(ended) - Date.parse(started)) / 1000 + 1, '사용 시간에 종료 대기 시간을 포함할 수 없어요.');
  }
  if (body.time_source === 'unknown') check(sec === null);
  check(body.stool_color == null || STOOL.includes(body.stool_color));
  check(body.urine_color == null || URINE.includes(body.urine_color));
  check(['measured', 'classified', 'unclassified', 'uncertain', 'unmeasured', 'failed', 'mixed'].includes(body.color_status));
  check(body.spectral_raw == null || (Array.isArray(body.spectral_raw) && body.spectral_raw.length <= 32
    && body.spectral_raw.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)));
  check(body.env == null || (typeof body.env === 'object' && !Array.isArray(body.env) && Object.keys(body.env).length <= 20
    && Object.values(body.env).every(n => n === null || (typeof n === 'number' && Number.isFinite(n)))));
  return {
    id: body.session_id, device_id: deviceId,
    // Sessions shorter than 20 seconds are treated as accidental triggers.
    measurement_status: body.measurement_status === 'completed' && sec !== null && sec < 20 ? 'discarded' : body.measurement_status,
    started_at: started, ended_at: ended, completed_at: completed, sitting_sec: sec,
    time_source: body.time_source, clock_status: body.clock_status,
    stool_color: body.stool_color ?? null, urine_color: body.urine_color ?? null, color_status: body.color_status,
    spectral_raw: body.spectral_raw ?? null, env: body.env ?? null,
  };
}
