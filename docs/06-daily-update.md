# 06. 매일 업데이트 — "버튼 한 번" 절차

Claude API 를 쓰지 않는다. 추출은 **이 Claude 세션에서** 한다. 주인님이 하루 한 번 "레이더 업데이트" 라고 하면 아래가 돈다.

## 흐름 (2026-11 기준)

```
① collect    PC:  python run.py collect --since <3일전> --sources news     (~1분, 구글·Bing 뉴스 RSS)
                  python run.py collect --since <3일전> --sources paper    (지방지 RSS 15개)
                  python run.py collect --since <7일전> --sources gov      (정책브리핑 — 구글 뉴스 site: 검색 경유, 정부 서버 직접 접속 없음)
                  python run.py collect --since <7일전> --sources dart     (DART 신규시설투자·유형자산취득)
             → Neon raw_documents 적재 → out/pending.md (관련 가능성 있는 문서만, 본문 3,000자)
② extract    Claude 가 pending.md 를 읽고 문서마다 JSON → out/extracted-N.json (번호 올려가며 보관)
③ ingest     python run.py ingest out/extracted-N.json   → 검증·병합·지오코딩(등록공장 좌표 우선) → signals
④ rebuild    python run.py rebuild                       → 전체 추출을 다시 병합 (별칭 등록·규칙 수정 후 필수)
⑤ companies  python run.py companies                     → 신규 상장사 DART 재무·종업원·생산설비 카드 갱신
⑥ permits    (PC)   python run.py permits-codes            → 좌표→법정동코드(카카오), out/bjdong.json
             (외부) python run.py permits-fetch            → 건축HUB 호출은 반드시 회사 IP 밖(Claude 샌드박스·Actions)에서, 1초 간격
             (PC)   python run.py permits-load             → 결과 적재 + 지오코딩
             ※ 2026-11-06 회사 공인 IP 가 정부 사이트에서 차단된 사고 이후, PC 에서는 .go.kr/.or.kr 에 어떤 요청도 보내지 않는다 (press.py NO_FETCH_HOSTS, permits ALLOW_GOV_API 가드)
⑦ 확인       https://tuja-72tc.vercel.app  /  /report (주간 보고)
```

한 소스 그룹이 180초를 넘기지 않도록 분리돼 있다. 같은 투자 건이 "사명 미확인" 으로 먼저 잡혔다가 나중에 사명이 밝혀지면
`python run.py alias 제천투자협약기업 바이오파마코리아` 로 별칭을 등록하고 rebuild 하면 하나로 합쳐진다.

## 세션에서 실제로 하는 말

> **주인님:** 레이더 업데이트
>
> **Claude:** (PC 연결돼 있으면) `collector/` 폴더에서 `python run.py collect --since 3일전` 실행 → `out/pending.md` 읽음 → 문서 N건 중 관련 M건 추출해 `out/extracted.json` 작성 → `python run.py ingest out/extracted.json` 실행 → "신규 3건, 갱신 2건, 금액충돌 1건(○○)" 보고.

**PC 가 연결돼 있어야 한다** (Claude 데스크톱 앱에서 이 대화를 열고 `collector/` 폴더를 "+ → Add folder" 로 추가). Claude 의 클라우드 샌드박스는 DART·네이버·카카오 도메인에 직접 접속하지 못한다 (claude.ai 설정 → Capabilities 에서 `opendart.fss.or.kr`, `openapi.naver.com`, `dapi.kakao.com` 을 허용 도메인에 넣으면 클라우드에서도 가능).

## 대안 A — collect 만 GitHub Actions 로 (키를 PC 에 안 두고 싶을 때)

`.github/workflows/collect.yml` 이 매일 07:30 KST 에 collect 를 돌려 `out/pending.md` 를 artifact 로 올린다. 세션에서 "레이더 업데이트" 하면 Claude 가 그 파일을 받아 추출·ingest 한다. ingest 는 Neon 접속이 필요하니 PC 또는 Actions `workflow_dispatch` 로.

## 대안 B — 전부 수동 (PC 연결 없이)

1. PC 터미널: `python run.py collect --since 2026-10-23`
2. `out/pending.md` 를 Claude 대화에 첨부 → "추출해줘"
3. Claude 가 준 JSON 을 `out/extracted.json` 으로 저장
4. `python run.py ingest out/extracted.json`

## 추출할 때 Claude 가 지키는 것

`out/pending.md` 맨 위에 지시문이 박혀 있다 (`collector/extract.py INSTRUCTIONS`). 요지:
- 모든 doc_id 를 빠짐없이 — 관련 없으면 `is_relevant:false` 와 사유
- 추측 금지, 없으면 null. utility_need·sector 만 공정 상식으로 추정하고 근거 기재
- 금액은 원 단위 정수, 시도는 정식 명칭
- 한 문서에 투자 건이 여럿이면 가장 큰 것 하나

`run.py ingest` 는 형식을 검증하고 틀린 값은 경고 후 보정한다 (예: stage 오타 → mou).

## 하루 분량 감

- DART 신규시설투자: 하루 0~5건
- 구글·Bing 뉴스 RSS 92개 쿼리 + 지방지 15개 → 사전필터 후 하루 40~150건 (중복 기사 많음)
- 보도자료 (등록 수에 비례): 0~10건

→ pending.md 는 보통 50~150건. 같은 건을 다룬 기사가 많아 실제 투자 건은 20~40개. 너무 많으면 `--since` 를 줄인다.

## 주 1회

- `python run.py status` 로 등급·규모·지오코딩 분포 확인
- 대시보드에서 "금액 충돌" 배지 달린 건 사람이 확정
- `sources.yaml` 에 지자체 1~2곳 추가 (A등급 비율을 올리는 가장 싼 방법)
