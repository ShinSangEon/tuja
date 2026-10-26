# 05. 운영 — 키 발급 순서·스케줄·체크리스트

## 키 발급 (반나절 안에 끝남)

| 순서 | 어디서 | 뭘 | 걸리는 시간 | 환경변수 |
|---|---|---|---|---|
| 1 | opendart.fss.or.kr → 인증키 신청 | OpenDART API 키 (40자) | 즉시 (사업자는 1~2일) | `DART_API_KEY` |
| 2 | developers.kakao.com (**GENEQ 계정**) → 앱 생성 → 비즈 앱 전환(사업자등록번호) → 카카오맵 활성화 | JavaScript 키 (지도), REST API 키 (지오코딩). 플랫폼 Web 에 Vercel 배포 도메인 + `http://localhost:3000` 등록 | 심사 1~3일 | `NEXT_PUBLIC_KAKAO_MAP_KEY`, `KAKAO_REST_KEY` |
| 3 | developers.naver.com (또는 ncloud NAVER API HUB) → 앱 등록 → 검색 API | Client ID / Secret | 즉시 | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` |
| 4 | neon.tech (**GENEQ 구글 계정으로 가입**) → 새 프로젝트 `geneq-radar` → SQL Editor 에 `db/schema.sql` 실행 | 연결 문자열 (`?sslmode=require`) | 5분 | `DATABASE_URL` (collector `.env` 와 Vercel 둘 다) |
| 5 | data.go.kr → 회원가입 → "건축허가 정보" 활용신청 | 서비스키 (Phase 1) | 즉시~1일 | `DATA_GO_KR_KEY` |

## 대시보드 배포 (Vercel, GENEQ 계정)

1. GitHub 에 이 저장소 푸시 (GENEQ 조직 또는 개인 계정 — Vercel 이 읽을 수 있으면 됨).
2. vercel.com 에 **GENEQ 계정**으로 가입 → New Project → 저장소 선택 → **Root Directory 를 `web`** 으로 지정.
3. 환경변수 4개: `NEXT_PUBLIC_KAKAO_MAP_KEY`, `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`.
4. 배포 후 나온 도메인(`xxx.vercel.app`)을 카카오 앱 플랫폼 Web 에 등록. 도메인 안 맞으면 지도가 401 로 빈 화면.
5. 접속하면 브라우저가 아이디/비번을 묻는다 (Basic Auth, `web/proxy.js`). DB 가 비어 있으면 샘플 13건 + "샘플 데이터" 배지.

로컬 확인: `cd web && cp .env.example .env.local && npm install && npm run dev` → `http://localhost:3000` (ADMIN_* 비우면 인증 없이 열림).

## 업데이트 주기

- 매일 1회, 세션에서 "레이더 업데이트" → `docs/06-daily-update.md`.
- 선택: `.github/workflows/collect.yml` 로 collect 만 07:30 KST 자동 실행 (추출·ingest 는 여전히 세션에서).

## 첫 주 체크리스트

- [ ] 첫 `collect` → 세션 추출 → `ingest` 를 한 번 같이 돌리고 **signals 20건을 눈으로 검수** — 회사명·지역·금액. 틀린 패턴은 `extract.py INSTRUCTIONS` 에 예시로 추가.
- [ ] 대표이사님께 `size_class` 기준(50억/500억)과 업종 가중치 확인.
- [ ] 지자체 보도자료 소스 등록: 경남·경북·부산·울산·대구·충남·충북·경기·전남·전북 순. `collector/sources.yaml` 참고.
- [ ] `company_aliases`에 자주 틀리는 회사명 등록 (LG엔솔 등).
- [ ] 산단 마스터: 공공데이터포털 "한국산업단지공단_전국산업단지현황" CSV 받아 `python run.py load-complexes 파일.csv`.

## 품질 지표 (매주 한 번 보기)

```sql
-- (search_path 는 radar) 등급 분포
select grade, count(*) from signals where created_at > now() - interval '7 days' group by 1;
-- 지오코딩 실패
select geocode_status, count(*) from signals group by 1;
-- 금액 충돌 (사람 확인 필요)
select id, company_name, sido, amount_krw from signals where amount_conflict;
-- AI가 걸러낸 사유 상위
select irrelevant_reason, count(*) from extractions where not is_relevant group by 1 order by 2 desc limit 20;
```

## 장애 시

| 증상 | 원인 | 조치 |
|---|---|---|
| 지도가 안 뜸, 콘솔에 401 | 카카오 앱 플랫폼에 도메인 미등록 / JS키 아님 | 앱 설정 → 플랫폼 → Web → 사이트 도메인 |
| 지오코딩 전부 fallback | REST 키를 JS 키 자리에 넣음 | `KAKAO_REST_KEY` 확인 |
| DART 013 에러 | 조회 결과 없음 (정상) / 020 쿼터 초과 | 날짜 범위 줄이기 |
| 네이버 429 | 일 한도 초과 | 키워드 수 줄이기, `NAVER_MAX_PER_KEYWORD` 낮추기 |
| `ingest` 가 "doc not pending" 경고 | 이미 ingest 된 문서를 다시 넣음 / doc_id 오타 | 무시해도 됨. 재추출하려면 DB 에서 `update raw_documents set extracted=false where id=...` |
| Neon 접속 timeout | 콜드 스타트 (수 초) | 한 번 더 실행. `?sslmode=require` 확인 |
