# 02. AI 추출 스키마 & 산정 기준

문서 1건(공시/보도자료/기사)마다 아래 JSON 1건. Claude 세션에서 `out/pending.md` 를 읽고 작성한다 (`out/extracted.json`, 배열). 각 객체 맨 앞에 `"doc_id"` 가 추가된다. 지시문 원문은 `collector/extract.py INSTRUCTIONS`.

```jsonc
{
  "is_relevant": true,                 // 국내 물리적 설비투자(공장 신설·증설·개조·설비)인가. false면 이하 무시
  "irrelevant_reason": null,           // "해외 공장", "금융투자", "단순 실적 기사" 등

  "company": {
    "name_raw": "(주)샘플배터리",        // 문서에 나온 그대로
    "name_norm": "샘플배터리",           // (주)·주식회사·㈜ 제거, 공백 정리
    "group": "샘플그룹",                 // 알 수 있으면
    "listed": true,                      // 상장 여부 (DART면 true)
    "corp_code": "00123456"              // DART 고유번호 (있으면)
  },

  "event": {
    "type": "expansion",                 // new_plant | expansion | retrofit | equipment | relocation | other
    "stage": "disclosure",               // disclosure | mou | permit | construction | completed
    "summary": "경남 양산 2공장에 2,200억 투자해 2차전지 양극재 라인 증설. 2027년 6월 가동 목표.",
    "purpose": "양극재 생산능력 2배 확대"
  },

  "investment": {
    "amount_krw": 220000000000,          // 원 단위 정수. 모르면 null
    "amount_disclosed": true,            // 문서에 명시됐나 (false면 AI 추정)
    "period_start": "2026-11",           // YYYY-MM, 모르면 null
    "period_end": "2027-06",
    "floor_area_m2": null                // 연면적 (있으면)
  },

  "location": {
    "sido": "경상남도",                   // 17개 시도 정식 명칭
    "sigungu": "양산시",
    "industrial_complex": "양산일반산업단지",  // 산단명 (있으면)
    "address_raw": "경남 양산시 ○○로 123",  // 문서에 나온 주소 (있으면)
    "precision": "address"               // address | complex | sigungu | sido | unknown
  },

  "industry": {
    "sector": "이차전지",                 // 아래 업종 목록에서
    "process_hint": "양극재 소성·코팅 라인"  // 압축공기·건조 수요 판단 근거가 되는 공정
  },

  "utility_need": {                      // 0~3 (0 없음, 1 낮음, 2 있음, 3 핵심)
    "compressed_air": 3,
    "dryer": 3,                          // 흡착식/냉동식 드라이어, 노점 요구
    "hmi_control": 2,
    "rationale": "양극재 라인은 분체 이송·클린 공정으로 무급유 압축기와 저노점 흡착식 드라이어 필수"
  },

  "confidence": 0.9                      // 0~1. 추출 전체의 자신감
}
```

## 파생 필드 (코드가 계산, AI가 계산하지 않음)

### 규모 등급 `size_class`
| 등급 | 기준 (투자금액) | 보조 기준 (금액 없을 때) |
|---|---|---|
| `S` 소규모 | 50억 미만 | 연면적 3,000㎡ 미만, "라인 1개", "설비 교체" |
| `M` 중규모 | 50억 ~ 500억 | 연면적 3,000~20,000㎡ |
| `L` 대규모 | 500억 이상 | 연면적 20,000㎡ 이상, "공장 신설", 지자체 투자협약 |
| `U` 미상 | 금액·면적 모두 없음 | 지도에 회색 핀 |

> 기준값은 `collector/config.py`의 `SIZE_THRESHOLDS`에서 바꾼다. 대표이사님과 합의 후 조정.

### 관련도 점수 `relevance_score` (0~100)
```
score = 업종 가중치(0~40)
      + utility_need 합계 × 5 (0~45)
      + 단계 가중치 (disclosure/mou 15, permit 10, construction 5, completed 0)
```
- 업종 가중치 (`config.py INDUSTRY_WEIGHTS`): 이차전지·반도체·디스플레이 40, 제약·바이오·식품 35, 자동차부품·조선·항공·방산 30, 화학·철강·기계 25, 전자부품 20, 물류·데이터센터 5, 기타 10.
- 70 이상 = 🔴 즉시 영업 검토, 40~69 = 🟠 모니터링, 40 미만 = ⚪ 보관.

### 신뢰 등급 `grade` (A/B/C) — 03-validation-rules.md 참고

## 업종 목록 (`sector`)
이차전지, 반도체, 디스플레이, 제약·바이오, 식품·음료, 자동차·부품, 조선·해양, 항공·방산, 화학·소재, 철강·금속, 기계·장비, 전자부품, 섬유, 물류·창고, 데이터센터, 에너지(수소·태양광 등), 기타

## 설비 유형 `event.type`
| 값 | 뜻 | ES사업부 관점 |
|---|---|---|
| `new_plant` | 신공장 | 유틸리티 전체 신규 — 가장 큰 건 |
| `expansion` | 증설 | 압축공기 용량 증대, 드라이어 추가 |
| `retrofit` | 개조·리모델링·스마트공장 | HMI/제어 교체, 노후 압축기 교체 |
| `equipment` | 설비투자(건물 변화 없음) | 공정 설비 ↔ 유틸리티 연동 |
| `relocation` | 이전 | 신공장과 동일 |
