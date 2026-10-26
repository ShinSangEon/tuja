"""교차검증·중복 병합·등급 산정 (docs/03-validation-rules.md 와 1:1).

입력: extractions (payload + 문서 메타)  →  출력: signal 레코드 (dict) + 연결된 문서 id 목록
DB 없이도 동작하도록 순수 함수로 작성. DB 적재는 db.py 가 담당.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from config import (AMOUNT_SPLIT_RATIO, AREA_THRESHOLDS, DEDUPE_WINDOW_DAYS, INDUSTRY_WEIGHTS,
                    SIZE_THRESHOLDS, STAGE_ORDER, STAGE_WEIGHTS)

# ── R6 엔티티 정규화 ─────────────────────────────────────
_STRIP = re.compile(r"\(주\)|㈜|주식회사|유한회사|유한책임회사|co\.?,?\s*ltd\.?|inc\.?|corp\.?|corporation|\s+|·|ㆍ", re.I)


def normalize_company(name: str | None, aliases: dict[str, str] | None = None) -> str:
    if not name:
        return ""
    n = _STRIP.sub("", name).lower().strip()
    if aliases and n in aliases:
        return aliases[n]
    return n


def _edit_distance(a: str, b: str) -> int:
    if abs(len(a) - len(b)) > 2:
        return 99
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ── 규모 등급 ───────────────────────────────────────────
def size_class(amount_krw: int | None, floor_area_m2: float | None, event_type: str | None, stage: str | None) -> str:
    if amount_krw:
        if amount_krw < SIZE_THRESHOLDS["S_MAX"]:
            return "S"
        if amount_krw < SIZE_THRESHOLDS["M_MAX"]:
            return "M"
        return "L"
    if floor_area_m2:
        if floor_area_m2 < AREA_THRESHOLDS["S_MAX"]:
            return "S"
        if floor_area_m2 < AREA_THRESHOLDS["M_MAX"]:
            return "M"
        return "L"
    if event_type == "new_plant" or stage == "mou":
        return "L"
    return "U"


# ── 관련도 점수 ─────────────────────────────────────────
def relevance_score(sector: str | None, need: dict | None, stage: str | None) -> int:
    s = INDUSTRY_WEIGHTS.get(sector or "기타", INDUSTRY_WEIGHTS["기타"])
    need = need or {}
    s += 5 * (int(need.get("compressed_air") or 0) + int(need.get("dryer") or 0) + int(need.get("hmi_control") or 0))
    s += STAGE_WEIGHTS.get(stage or "", 0)
    return max(0, min(100, s))


# ── R2 등급 ─────────────────────────────────────────────
def grade(sources: list[dict], confidence: float | None) -> str:
    """sources: [{'tier': int, 'source_name': str}]"""
    g = "C"
    if any(s["tier"] == 1 for s in sources):
        g = "A"
    else:
        distinct_t2 = {s["source_name"] for s in sources if s["tier"] <= 2}
        if len(distinct_t2) >= 2:
            g = "B"
    if confidence is not None and confidence < 0.5:
        g = {"A": "B", "B": "C", "C": "C"}[g]
    return g


# ── R4 동일 프로젝트 판정 ───────────────────────────────
def _same_type(a: str, b: str) -> bool:
    eq = {"expansion", "equipment"}
    return a == b or (a in eq and b in eq)


def is_same_project(x: dict, y: dict) -> bool:
    cx, cy = x["company_norm"], y["company_norm"]
    same_company = (
        cx == cy
        or (x.get("corp_code") and x.get("corp_code") == y.get("corp_code"))
        or _edit_distance(cx, cy) <= 2
    )
    if not same_company:
        return False
    if x.get("sido") != y.get("sido"):
        return False
    if x.get("sigungu") and y.get("sigungu") and x["sigungu"] != y["sigungu"]:
        return False
    if not _same_type(x["event_type"], y["event_type"]):
        return False
    dx, dy = x.get("published_at"), y.get("published_at")
    if dx and dy and abs((dx - dy).days) > DEDUPE_WINDOW_DAYS:
        return False
    ax, ay = x.get("amount_krw"), y.get("amount_krw")
    if ax and ay and max(ax, ay) / max(min(ax, ay), 1) >= AMOUNT_SPLIT_RATIO:
        return False
    return True


# ── 추출 결과 → 후보 레코드 ─────────────────────────────
def candidate_from_extraction(payload: dict, doc: dict, aliases: dict[str, str] | None = None) -> dict | None:
    if not payload or not payload.get("is_relevant"):
        return None
    c, e, inv, loc, ind, need = (payload.get(k) or {} for k in ("company", "event", "investment", "location", "industry", "utility_need"))
    name_raw = c.get("name_raw") or doc.get("meta", {}).get("corp_name") or ""
    if not name_raw:
        return None
    pub = doc.get("published_at")
    if isinstance(pub, str):
        pub = datetime.fromisoformat(pub)
    return {
        "company_name": name_raw,
        "company_norm": normalize_company(c.get("name_norm") or name_raw, aliases),
        "corp_code": c.get("corp_code") or doc.get("meta", {}).get("corp_code"),
        "company_group": c.get("group"),
        "listed": c.get("listed"),
        "event_type": e.get("type") or "other",
        "stage": e.get("stage") if e.get("stage") in STAGE_ORDER else "mou",
        "summary": e.get("summary"),
        "purpose": e.get("purpose"),
        "amount_krw": inv.get("amount_krw"),
        "amount_disclosed": bool(inv.get("amount_disclosed")),
        "period_start": inv.get("period_start"),
        "period_end": inv.get("period_end"),
        "floor_area_m2": inv.get("floor_area_m2"),
        "sido": loc.get("sido"),
        "sigungu": loc.get("sigungu"),
        "industrial_complex": loc.get("industrial_complex"),
        "address_raw": loc.get("address_raw"),
        "location_precision": loc.get("precision") or "unknown",
        "sector": ind.get("sector"),
        "process_hint": ind.get("process_hint"),
        "need_compressed_air": int(need.get("compressed_air") or 0),
        "need_dryer": int(need.get("dryer") or 0),
        "need_hmi": int(need.get("hmi_control") or 0),
        "need_rationale": need.get("rationale"),
        "confidence": payload.get("confidence"),
        "published_at": pub,
        "_sources": [{"tier": doc.get("source_tier", 3), "source_name": doc.get("source_name"), "document_id": doc.get("id"), "url": doc.get("url")}],
    }


# ── R5 병합 ─────────────────────────────────────────────
_PREC = {"address": 4, "complex": 3, "sigungu": 2, "sido": 1, "unknown": 0}


def merge(base: dict, new: dict) -> dict:
    out = dict(base)
    out["_sources"] = base["_sources"] + [s for s in new["_sources"] if s not in base["_sources"]]
    bt, nt = min(s["tier"] for s in base["_sources"]), min(s["tier"] for s in new["_sources"])
    # 금액
    ba, na = base.get("amount_krw"), new.get("amount_krw")
    if ba and na and ba != na:
        if nt < bt:
            out["amount_krw"] = na
        elif nt == bt:
            out["amount_krw"] = min(ba, na)
            out["amount_conflict"] = True
    elif na and not ba:
        out["amount_krw"] = na
        out["amount_disclosed"] = new.get("amount_disclosed", False)
    # 단계: 더 진행된 쪽
    if STAGE_ORDER.index(new["stage"]) > STAGE_ORDER.index(base["stage"]):
        out["stage"] = new["stage"]
    # 지역: precision 높은 쪽
    if _PREC.get(new["location_precision"], 0) > _PREC.get(base["location_precision"], 0):
        for k in ("sido", "sigungu", "industrial_complex", "address_raw", "location_precision"):
            out[k] = new[k]
    # 요약: tier 높은 쪽, 같으면 최신
    if nt < bt or (nt == bt and (new.get("published_at") or datetime.min) > (base.get("published_at") or datetime.min)):
        for k in ("summary", "purpose", "company_name"):
            if new.get(k):
                out[k] = new[k]
    # 빈 값 채우기
    for k in ("corp_code", "company_group", "listed", "period_start", "period_end", "floor_area_m2", "sector", "process_hint", "need_rationale"):
        if not out.get(k) and new.get(k):
            out[k] = new[k]
    for k in ("need_compressed_air", "need_dryer", "need_hmi"):
        out[k] = max(out.get(k) or 0, new.get(k) or 0)
    out["confidence"] = max(out.get("confidence") or 0, new.get("confidence") or 0)
    out["published_at"] = max(filter(None, [out.get("published_at"), new.get("published_at")]), default=None)
    return out


def finalize(sig: dict) -> dict:
    """파생 필드 계산."""
    sig["size_class"] = size_class(sig.get("amount_krw"), sig.get("floor_area_m2"), sig.get("event_type"), sig.get("stage"))
    sig["relevance_score"] = relevance_score(
        sig.get("sector"),
        {"compressed_air": sig.get("need_compressed_air"), "dryer": sig.get("need_dryer"), "hmi_control": sig.get("need_hmi")},
        sig.get("stage"),
    )
    sig["grade"] = grade(sig["_sources"], sig.get("confidence"))
    sig["source_count"] = len(sig["_sources"])
    sig.setdefault("amount_conflict", False)
    return sig


def consolidate(candidates: list[dict], existing: list[dict] | None = None) -> list[dict]:
    """후보들을 기존 signal(있으면)과 합쳐 최종 목록으로. existing 항목은 '_id' 를 가진다."""
    pool: list[dict] = [dict(e) for e in (existing or [])]
    for c in sorted(candidates, key=lambda x: x.get("published_at") or datetime.min):
        for i, p in enumerate(pool):
            if is_same_project(p, c):
                pool[i] = merge(p, c)
                break
        else:
            pool.append(c)
    return [finalize(p) for p in pool]
