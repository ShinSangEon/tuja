"""추출 단계 — Claude API 를 쓰지 않는다.

흐름:
  run.py collect  → 사전필터 통과 문서를 out/pending.md (사람/Claude 가 읽는 형식) + out/pending.jsonl 로 내보냄
  Claude 세션에서 pending.md 를 읽고 docs/02-schema.md 형식의 JSON 배열을 out/extracted.json 으로 작성
  run.py ingest out/extracted.json → 검증·병합·지오코딩·DB

이 파일은 (1) 키워드 사전필터 (2) Claude 에게 줄 지시문 템플릿 (3) extracted.json 검증 만 담당한다.
"""
from __future__ import annotations

import json
from pathlib import Path

from config import MAX_BODY_CHARS, NEGATIVE_KEYWORDS, POSITIVE_KEYWORDS, STRONG_POSITIVE

REQUIRED_TOP = {"doc_id", "is_relevant"}
STAGES = {"disclosure", "mou", "permit", "construction", "completed"}
TYPES = {"new_plant", "expansion", "retrofit", "equipment", "relocation", "other"}


# ── 1) 사전필터 (API 호출 없음) ─────────────────────────
def prefilter(title: str, body: str, source_type: str) -> bool:
    if source_type in ("dart", "press"):
        return True  # 1차 소스는 전부 추출 대상
    text = f"{title}\n{body[:1500]}"
    if not any(k in text for k in POSITIVE_KEYWORDS):
        return False
    if any(k in text for k in NEGATIVE_KEYWORDS) and not any(k in text for k in STRONG_POSITIVE):
        return False
    return True


# ── 2) Claude 에게 줄 지시문 ────────────────────────────
INSTRUCTIONS = """# 추출 지시문 (GENEQ 투자 레이더)

아래 문서들을 읽고, **국내 공장 신설/증설/개조/설비투자** 건만 골라 JSON 배열로 `out/extracted.json` 에 저장하세요.
문서마다 객체 1개. 관련 없는 문서도 `{"doc_id": "...", "is_relevant": false, "irrelevant_reason": "해외 공장"}` 처럼 넣어서 **모든 doc_id 가 빠짐없이** 들어가야 합니다.

규칙
- 문서에 없는 값은 null. 추측 금지. 단 utility_need 와 sector 는 업종·공정 상식으로 추정하고 rationale 에 근거를 쓴다.
- amount_krw 는 원 단위 정수 (2,200억 → 220000000000). "약"이 붙어도 숫자가 있으면 amount_disclosed=true.
- sido 는 17개 시도 정식 명칭 (경남→경상남도, 충남→충청남도, 전북→전북특별자치도, 강원→강원특별자치도).
- precision: 도로명/번지 주소 있으면 address, 산단명만 complex, 시군구까지 sigungu, 시도만 sido, 없으면 unknown.
- event.type: new_plant | expansion | retrofit(개조·스마트공장·노후설비 교체) | equipment(건물 변화 없는 설비투자) | relocation | other
- event.stage: disclosure(공시·이사회 결의) | mou(투자협약·발표) | permit(인허가·입주계약) | construction(착공) | completed(준공·가동)
- sector: 이차전지, 반도체, 디스플레이, 제약·바이오, 식품·음료, 자동차·부품, 조선·해양, 항공·방산, 화학·소재, 철강·금속, 기계·장비, 전자부품, 섬유, 물류·창고, 데이터센터, 에너지, 기타
- utility_need 0(없음)~3(핵심). 분체·도장·클린룸·식품·제약·반도체·배터리 = 압축공기·저노점 드라이어 높음. 자동화·스마트공장 = hmi_control 높음.
- 문서에 투자 건이 여럿이면 가장 큰 건 하나.
- 해외 공장, 주식·펀드 투자, 단순 실적·전망, 채용, M&A 만 다루는 글, 정책 일반론 → is_relevant=false.

객체 형식
{"doc_id":"<문서 id 그대로>","is_relevant":true,"irrelevant_reason":null,
 "company":{"name_raw":"(주)샘플","name_norm":"샘플","group":null,"listed":true,"corp_code":null},
 "event":{"type":"expansion","stage":"disclosure","summary":"한 문장 요약","purpose":null},
 "investment":{"amount_krw":220000000000,"amount_disclosed":true,"period_start":"2026-11","period_end":"2027-06","floor_area_m2":null},
 "location":{"sido":"경상남도","sigungu":"양산시","industrial_complex":null,"address_raw":null,"precision":"sigungu"},
 "industry":{"sector":"이차전지","process_hint":"양극재 코팅 라인"},
 "utility_need":{"compressed_air":3,"dryer":3,"hmi_control":2,"rationale":"근거"},
 "confidence":0.9}
"""


def write_pending(docs: list[dict], out_dir: Path) -> tuple[Path, Path]:
    """사전필터 통과 문서 → pending.md (읽기용) + pending.jsonl (기계용)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    md, jl = out_dir / "pending.md", out_dir / "pending.jsonl"
    lines = [INSTRUCTIONS, f"\n---\n# 문서 {len(docs)}건\n"]
    with open(jl, "w", encoding="utf-8") as f:
        for d in docs:
            body = (d.get("body") or "")[:MAX_BODY_CHARS]
            meta = d.get("meta") or {}
            hint = {k: meta.get(k) for k in ("corp_code", "corp_name", "stock_code") if meta.get(k)}
            lines.append(f"\n## doc_id: {d['id']}\n- 소스: {d.get('source_name')} (tier {d.get('source_tier')}) · {d.get('published_at')}\n- 제목: {d.get('title')}\n- URL: {d.get('url')}")
            if hint:
                lines.append(f"- 메타: {json.dumps(hint, ensure_ascii=False)}")
            lines.append(f"\n{body}\n")
            f.write(json.dumps({"id": d["id"], "title": d.get("title"), "body": body, "meta": meta, "url": d.get("url"),
                                "source_name": d.get("source_name"), "source_tier": d.get("source_tier"),
                                "published_at": str(d.get("published_at") or "")}, ensure_ascii=False) + "\n")
    md.write_text("\n".join(lines), encoding="utf-8")
    return md, jl


# ── 3) extracted.json 검증 ──────────────────────────────
def load_extracted(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "results" in data:
        data = data["results"]
    if not isinstance(data, list):
        raise ValueError("extracted.json 은 JSON 배열이어야 합니다")
    out, errors = [], []
    for i, r in enumerate(data):
        missing = REQUIRED_TOP - set(r)
        if missing:
            errors.append(f"[{i}] 필드 누락: {missing}")
            continue
        if r.get("is_relevant"):
            ev = r.get("event") or {}
            if ev.get("type") not in TYPES:
                errors.append(f"[{i}] event.type 이상: {ev.get('type')}")
                ev["type"] = "other"
            if ev.get("stage") not in STAGES:
                errors.append(f"[{i}] event.stage 이상: {ev.get('stage')}")
                ev["stage"] = "mou"
            r["event"] = ev
            if not (r.get("company") or {}).get("name_raw"):
                errors.append(f"[{i}] company.name_raw 없음 → 제외")
                continue
        out.append(r)
    if errors:
        print("extracted.json 경고:\n  " + "\n  ".join(errors))
    return out
