# GENEQ 투자 레이더 (ES사업부 영업 타겟 발굴 시스템)

> "어느 회사가, 어디에, 얼마를 들여, 공장을 신설/증설/개조한다더라 — 압축기·드라이어·HMI 가 필요하겠더라"를
> 공시·보도자료·뉴스에서 긁어 → Claude 세션에서 구조화 → 교차검증 → 카카오맵 위에 띄운다.
> 목적: 설비 발주 6~18개월 전에 잡아서 영업팀에 넘기기.

## 운영 형태 (2026-10-26 결정)

- **추출은 Claude API 가 아니라 이 세션에서 수동.** 하루 한 번 "레이더 업데이트" → `docs/06-daily-update.md`
- **계정은 전부 GENEQ 명의로 새로**: Neon(GENEQ 구글 계정), Vercel(GENEQ 계정), 카카오 개발자(GENEQ 비즈 앱)
- DB 는 접속·업데이트 때만 깨어남 (Neon scale-to-zero). 대시보드는 Basic Auth 뒤
- 비용: Vercel Pro 월 $20 외 0원 → `docs/04-costs.md`

## 구조

```
collector/ (Python)
  ├─ run.py collect        DART·네이버뉴스·보도자료 수집 → Neon raw_documents → out/pending.md
  │     (Claude 세션이 pending.md 읽고 out/extracted.json 작성)
  ├─ run.py ingest         extracted.json → 교차검증·병합·지오코딩 → Neon signals
  ├─ sources/              dart.py / naver_news.py / press.py (+ sources.yaml)
  ├─ extract.py            사전필터 + Claude 지시문(INSTRUCTIONS) + extracted.json 검증
  ├─ validate.py           교차검증·중복 병합·신뢰등급(A/B/C)·규모(S/M/L)·관련도 점수
  └─ geocode.py            카카오 로컬 API + 산단 마스터 + 시군구 폴백
db/schema.sql              Neon 에 1회 실행
web/ (Next.js 16, JS)      Vercel 에 Root Directory=web 으로 배포
  ├─ app/page.js           대시보드 (카카오맵·필터·상세 패널)
  ├─ app/api/signals/      Neon v_signals_map 조회 (pg), DB 없으면 public/sample-signals.json
  ├─ proxy.js              Basic Auth (ADMIN_USERNAME / ADMIN_PASSWORD)
  └─ components/, lib/
.github/workflows/collect.yml       선택: collect 만 매일 자동 실행
docs/                      설계·스키마·검증규칙·비용·운영·매일 업데이트
```

## 설치 순서 (반나절)

1. **계정 3개** (GENEQ 구글 계정으로): neon.tech 가입 → 프로젝트 생성 → SQL Editor 에 `db/schema.sql` / vercel.com 가입 / developers.kakao.com 앱 생성·비즈 전환·카카오맵 활성화.
2. **대시보드**: 이 저장소를 GitHub 에 올리고 Vercel 에서 Root Directory=`web` 으로 배포. 환경변수 `NEXT_PUBLIC_KAKAO_MAP_KEY`, `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`. 배포 도메인을 카카오 앱 Web 플랫폼에 등록.
   → 이 시점에 **샘플 13건**으로 뜬다 (대표이사 시연 가능). 로컬은 `cd web && npm install && npm run dev`.
3. **collector**: `cd collector && cp .env.example .env` 에 DART·네이버·카카오 REST·Neon URL → `pip install -r requirements.txt`.
4. 첫 실행: `python run.py collect --since 2026-10-20` → 세션에서 추출 → `python run.py ingest out/extracted.json` → 대시보드 새로고침하면 샘플 배지가 사라지고 실데이터.

## 문서

- [docs/01-design.md](docs/01-design.md) — 설계 원칙, 소스, 단계 모델, 로드맵
- [docs/02-schema.md](docs/02-schema.md) — 추출 JSON 스키마, 규모·관련도 기준
- [docs/03-validation-rules.md](docs/03-validation-rules.md) — 교차검증·병합·등급 규칙 (코드와 1:1)
- [docs/04-costs.md](docs/04-costs.md) — 비용 (추가 0원) 과 주의 2가지
- [docs/05-ops.md](docs/05-ops.md) — 키 발급, 대시보드 배포, 품질 지표, 장애
- [docs/06-daily-update.md](docs/06-daily-update.md) — **매일 "레이더 업데이트" 절차**

## 상태

- [x] 설계·규칙·비용 문서
- [x] Neon 스키마
- [x] 수집기 (DART / 네이버뉴스 / 보도자료 템플릿) + 사전필터 + pending.md 생성
- [x] 세션 추출용 지시문 + extracted.json 검증 + ingest (병합·지오코딩·DB) — 파일 모드로 테스트 완료
- [x] Next.js 대시보드 + Basic Auth (빌드·인증·API 필터 테스트 완료)
- [ ] GENEQ 계정 3개 생성 → Neon schema.sql, Vercel 배포, 카카오 키
- [ ] 실제 키로 첫 collect → 추출 품질 검수 20건
- [ ] 지자체 보도자료 소스 등록 (sources.yaml)
- [ ] 영업 액션 레이어 (담당자·접촉 상태·네트워크 메모) — Phase 2
