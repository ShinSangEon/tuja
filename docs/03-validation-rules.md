# 03. 교차검증·중복 병합·신뢰등급 규칙

코드: `collector/validate.py`. 아래 규칙은 코드와 1:1로 대응한다.

## R1. 소스 등급 (source tier)

| tier | 소스 | 이유 |
|---|---|---|
| 1 | DART 공시 | 법적 책임이 따르는 1차 자료 |
| 1 | 지자체·중앙부처 공식 보도자료 (go.kr 도메인) | 투자협약 당사자 발표 |
| 2 | 경제지·전국지 (`config.py TIER2_PRESS`) | 기자 취재, 오보 가능 |
| 3 | 그 외 매체, 블로그, 커뮤니티 | 재탕·추측 많음 |

## R2. 신호 등급 (grade)

```
A : tier1 소스 1건 이상
B : tier2 이상 소스가 서로 다른 매체 2건 이상 (같은 통신사 기사 재전송은 1건으로 침)
C : 그 외 (단일 tier2/3 소스)
```
- 대시보드 기본 필터는 A+B. C는 "미확인 포함" 체크 시 표시.
- **영업 배정(Phase 2)은 A/B만.** C는 사람이 확인 후 등급 수동 승격 가능.

## R3. 노이즈 필터 (추출 전·후)

추출 **전** (키워드 수준, `config.py NEGATIVE_KEYWORDS`):
- 제외: `주가`, `목표주가`, `펀드`, `투자의견`, `해외 공장` 단독, `인수`(M&A만일 때), `채용`
- 단, 제외어가 있어도 `증설|신설|착공|준공|투자협약`이 같이 있으면 통과

추출 **후** (AI 판단):
- `is_relevant=false` → 보관만, signal 생성 안 함
- `location.sido` 없음 + `precision=unknown` → signal은 만들되 지도 미표시 (`geocode_status='unlocated'`)
- `confidence < 0.5` → grade 한 단계 강등

## R4. 동일 프로젝트 판정 (dedupe key)

두 추출 결과가 아래를 **모두** 만족하면 같은 signal로 병합:
1. `company.name_norm`이 같거나, `corp_code`가 같거나, 편집거리 ≤ 2 (한글 2자 이내 차이)
2. `location.sido` 같고 (`sigungu`가 둘 다 있으면) `sigungu`도 같음
3. `event.type` 같음 (단 `expansion` ↔ `equipment`는 같은 것으로 봄)
4. 문서 발행일 차이 ≤ 180일

> 같은 회사가 같은 지역에 두 개 프로젝트를 동시에 하는 경우는 드물고, 있어도 금액으로 구분된다. 금액이 3배 이상 차이나면 별개로 둔다.

## R5. 병합 시 필드 우선순위

| 필드 | 규칙 |
|---|---|
| 금액 | tier1 값 > 복수 tier2가 일치하는 값 > 가장 최근 값. 불일치면 `amount_conflict=true` 플래그 + 가장 보수적(작은) 값 채택 |
| 단계 | 가장 **진행된** 단계 (disclosure < mou < permit < construction < completed) |
| 지역 | precision이 더 높은 쪽 (address > complex > sigungu > sido) |
| 요약 | tier1 문서 기준, 없으면 최신 |
| 관련도 | 재계산 (병합된 정보로) |
| 출처 | 전부 `signal_sources`에 연결 — 지도 팝업에서 출처 N건 모두 링크 |

## R6. 엔티티 정규화

- 제거: `(주)`, `㈜`, `주식회사`, `유한회사`, `Co., Ltd.`, `Inc.`, 공백, 중점
- 별칭 테이블 `company_aliases` (예: LG엔솔 / LG에너지솔루션 / LGES). 운영하며 채운다.
- 상장사는 DART corp_code가 마스터 키. `python run.py --refresh-corpcodes`로 DART 고유번호 전체 목록 갱신.

## R7. 지오코딩 우선순위

```
address_raw 있음  → 카카오 로컬 API (주소→좌표). 실패 시 ↓
industrial_complex 있음 → 산단 마스터(industrial_complexes 테이블) 좌표
sigungu 있음     → 시군구 중심점 (regions 테이블)
sido만 있음      → 시도 중심점, precision='sido' (지도에선 흐린 핀)
```
- 지오코딩 결과는 `signals.geocode_status` (ok / fallback_complex / fallback_region / unlocated)
- 카카오 API는 **같은 주소를 두 번 부르지 않는다** (geocode_cache 테이블).

## R8. 수명 관리

- `completed` 후 12개월 → `archived=true` (지도 기본 숨김). 단, 준공 공장은 "교체 수요" 리스트로 별도 보기 가능.
- 어떤 소스에서도 18개월간 재언급 없는 `disclosure/mou` 건 → `stale=true` 표시 (취소됐을 가능성).

## R9. 사람 개입 지점

| 상황 | 처리 |
|---|---|
| grade C인데 영업적으로 중요해 보임 | 대시보드에서 수동 승격 (`manual_grade`) |
| 같은 회사 두 건이 잘못 병합됨 | `signals.split_from` 으로 분리 (Phase 2 UI) |
| 금액 충돌 | `amount_conflict` 필터로 모아보고 사람이 확정 |
