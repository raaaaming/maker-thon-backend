# maker-ton-backend

변기 센서 보드 + 앱을 위한 백엔드. **Vercel 서버리스(Hono) + Supabase(Auth·Postgres)**.

```
휴대폰 앱 ──(Supabase 로그인 토큰)──▶ Vercel API ──▶ Supabase DB
센서 보드 ──(기기 인증키)────────────▶ Vercel API ──▶ Supabase DB
```

- 로그인은 Supabase Auth가 처리하고, 이 서버는 요청의 `Authorization: Bearer <access_token>`을 **JWKS로 검증**합니다.
- DB 접근은 서버 전용 **secret key**로만 하며, 모든 쿼리가 `user_id`로 범위를 제한합니다. (RLS는 추가 안전장치)
- 음식 사진 분석 API 키는 서버에만 있습니다.

## 설치·배포

1. **Supabase SQL Editor**에서 `supabase/schema.sql` 실행 (테이블·RLS·가입 시 프로필 자동 생성).
2. **Vercel**에 이 저장소를 import 하고 환경변수 설정 (`.env.example` 참고):
   `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_SECRET_KEY`, `DEVICE_TOKEN`, `PAIRING_CODE`, `ALLOWED_ORIGINS`
3. 배포 후 `GET /api/health` → `{"ok":true}` 확인.

로컬: `npm i && cp .env.example .env && npm start`, 테스트: `npm test`.

## API

공통: 오류는 `{ "error": "한국어 메시지", "code": "..." }`.

### 앱 (Bearer 사용자 토큰)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/me` | 프로필·연결된 기기·설정 |
| PATCH | `/api/me` | `{name}` 이름 변경 |
| DELETE | `/api/account` | 계정과 모든 기록 삭제 |
| POST | `/api/devices/join` | `{device_id, code}` 연결 코드로 변기 연결 |
| POST | `/api/devices/:id/checkins` | NFC 태그를 찍어 앱을 열 때 호출 (연결된 변기만) |
| GET | `/api/devices/:id/context` | 기기 상태(`offline/idle/measuring`)와 저장 가능한 측정 후보 |
| POST | `/api/sessions/:id/claim` | `{shape, shape_status, excretion_type}` 측정을 내 기록으로 저장 (종료 후 10분 이내) |
| GET | `/api/records` | 내 배변 기록 |
| PATCH/DELETE | `/api/records/:id` | 수정(24시간 이내)/삭제 |
| GET/POST | `/api/meals` | 식사 기록 목록/추가 `{foods, eaten_at, keep_photo, source, photo?}` |
| PATCH/DELETE | `/api/meals/:id` | 식사 수정/삭제 |
| POST | `/api/meals/analyze` | `{image: "data:image/jpeg;base64,..."}` 음식 사진 AI 분석 |
| GET | `/api/insights` | 최근 7일 요약 |

### 보드 (Bearer `DEVICE_TOKEN`)
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/session` | **UNO Q 보드(`device/main.py`)의 세션 업로드**. 봉투 `{schema_version:1, device_id, session_id, packet}` 를 그대로 받아 변환·저장 |
| POST | `/api/device/events` | 일반 측정 이벤트(시작/완료/폐기) — 아래 정규화 형식 |
| POST | `/api/device/heartbeat` | `{device_id, state?, sensors?, ...}` 25초마다 전송 (75초 넘게 없으면 앱에 offline, `OFFLINE_AFTER_SEC`) |

### UNO Q 보드 설정 (`main.py`)
보드 환경변수 또는 설정: `BH_API_URL`(이 백엔드의 Vercel 주소), `BH_DEVICE_TOKEN`(= 서버 `DEVICE_TOKEN`). `device_id`는 `toilet-01`이어야 해요.
`/api/session` 변환 규칙:
- `timestamp`=시작, `+seated_s`=종료, `+recorded_s`=확정. `mode`가 `tof`면 시간 출처는 센서, `timed`(책상 시험)면 사용 시간 없음.
- 보드는 시계 동기 여부를 보내지 않아서, 확정 시각이 서버 시각보다 미래이거나 `CLAIM_WINDOW_MIN`보다 오래전이면 `unknown`(앱에서 저장 불가)으로 둡니다. 보드 시계를 NTP로 맞춰 두세요.
- 분광 추정 색 → `stool_color`(센서는 대변/소변을 구분하지 못해 대변 색으로만 저장). 포화·주변광 불안정·광원 약함이면 `uncertain`으로 두고 색을 비워 색 알림이 뜨지 않게 해요. 흰 기준이 없으면 `unmeasured`.
- 가스·분광 특징 등 패킷 전체는 `toilet_sessions.analysis`(jsonb)에 보관하고 앱 API로는 내보내지 않아요.

`/api/device/events` 본문 예 (시간은 시간대 포함 ISO):

```json
{
  "device_id": "toilet-01",
  "session_id": "고유ID",
  "measurement_status": "completed",
  "time_source": "sensor",
  "clock_status": "synced",
  "started_at": "2026-11-06T06:00:00Z",
  "ended_at": "2026-11-06T06:03:00Z",
  "completed_at": "2026-11-06T06:03:05Z",
  "sitting_sec": 180,
  "stool_color": "brown",
  "urine_color": "pale_yellow",
  "color_status": "measured",
  "spectral_raw": [0.1, 0.2],
  "env": { "temp_c": 24.5 }
}
```

- 시작 시 `measuring`(종료 시각 없이), 끝나면 같은 `session_id`로 `completed`를 보냅니다. 확정된 기록은 바뀌지 않습니다.
- `sitting_sec`가 20초 미만이면 자동으로 폐기됩니다.
- 대변 색: `brown dark_brown yellow green black red pale gray white` · 소변 색: `clear pale_yellow yellow dark_yellow brown`

## 보안 메모
- `SUPABASE_SECRET_KEY`는 서버 환경변수에만 두고 브라우저·앱·보드에 넣지 마세요.
- 이 서비스는 건강 관련 기록을 다룹니다. 색 안내는 진단이 아니라는 문구를 유지하세요.
- 요청 제한은 서버 인스턴스별 best-effort입니다. 트래픽이 커지면 Vercel Firewall 등을 추가하세요.
