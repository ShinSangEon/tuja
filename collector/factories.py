"""전국 등록공장 현황 (한국산업단지공단, 공공데이터포털 15105482) → factories 테이블.

컬럼: 순번, 회사명, 단지명, 생산품, 공장주소 (cp949 CSV, 약 22만 행)
쓰임:
  1) 회사 카드에 "기존 공장 N곳" + 지도에 연한 핀
  2) 신규 투자 건 지오코딩 정밀화: 같은 회사 공장이 같은 시군구/산단에 있으면 그 좌표 사용 (precision='factory')
좌표는 전체를 다 찍지 않고(22만 건, 카카오 일 10만 한도) 타겟 회사 것만 그때그때 geocode 해서 캐시.
"""
from __future__ import annotations

import csv
import logging
import re

from validate import normalize_company

log = logging.getLogger(__name__)

SCHEMA = """
create table if not exists factories (
  id int primary key,
  company_raw text not null,
  company_norm text not null,
  complex text,
  complex_norm text,
  products text,
  address text,
  sido text, sigungu text,
  lat double precision, lng double precision,
  geocode_status text default 'pending'
);
create index if not exists factories_norm_idx on factories (company_norm);
create index if not exists factories_sigungu_idx on factories (sido, sigungu);
"""
SIDO_MAP = {"서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시", "인천": "인천광역시", "광주": "광주광역시", "대전": "대전광역시", "울산": "울산광역시",
            "세종": "세종특별자치시", "경기": "경기도", "강원": "강원특별자치도", "충북": "충청북도", "충남": "충청남도", "전북": "전북특별자치도",
            "전남": "전라남도", "경북": "경상북도", "경남": "경상남도", "제주": "제주특별자치도"}


def split_region(addr: str) -> tuple[str | None, str | None]:
    if not addr:
        return None, None
    toks = addr.replace(",", " ").split()
    if not toks:
        return None, None
    sido = toks[0]
    for k, v in SIDO_MAP.items():
        if sido == v or sido.startswith(v[:3]) or sido == k or sido == k + "도" or sido == k + "시":
            sido = v
            break
    sigungu = None
    if len(toks) > 1 and re.search(r"(시|군|구)$", toks[1]):
        sigungu = toks[1]
        # 세종시/창원시 마산합포구 같은 2단계 → 시 단위만
    return sido, sigungu


def norm_complex(name: str | None) -> str | None:
    if not name or not name.strip():
        return None
    return re.sub(r"\s+|일반산업단지|국가산업단지|산업단지|산단|농공단지|지방산업단지", "", name)


def load_csv(c, path: str) -> int:
    c.execute(SCHEMA)
    c.execute("delete from factories")
    n = 0
    with open(path, encoding="cp949", errors="replace", newline="") as fh, c.cursor().copy(
        "copy factories (id, company_raw, company_norm, complex, complex_norm, products, address, sido, sigungu) from stdin") as cp:
        r = csv.reader(fh)
        next(r)
        for row in r:
            if len(row) < 5:
                continue
            idx, name, cx, prod, addr = row[:5]
            cx = cx.strip() or None
            sido, sgg = split_region(addr.strip())
            cp.write_row((int(idx), name.strip(), normalize_company(name), cx, norm_complex(cx), (prod or "").strip()[:500], addr.strip()[:300], sido, sgg))
            n += 1
    log.info("factories loaded: %d", n)
    return n


def for_company(c, company_norm: str, corp_name: str | None = None) -> list[dict]:
    norms = {company_norm}
    if corp_name:
        norms.add(normalize_company(corp_name))
    return c.execute("select * from factories where company_norm = any(%s) order by id", (list(norms),)).fetchall()


def match_for_signal(c, sig: dict) -> dict | None:
    """신호와 같은 회사 공장 중 같은 산단 > 같은 시군구 > 같은 시도 순으로 하나. corp_code 가 있으면 DART 정식 상호로도 찾는다."""
    corp_name = None
    if sig.get("corp_code"):
        r = c.execute("select corp_name from corp_codes where corp_code = %s", (sig["corp_code"],)).fetchone()
        corp_name = r["corp_name"] if r else None
    rows = for_company(c, sig["company_norm"], corp_name)
    if not rows:
        return None
    cxn = norm_complex(sig.get("industrial_complex"))
    if cxn:
        for r in rows:
            if r["complex_norm"] and (cxn in r["complex_norm"] or r["complex_norm"] in cxn):
                return r
    if sig.get("sigungu"):
        for r in rows:
            if r["sigungu"] and r["sigungu"][:2] == sig["sigungu"][:2]:
                return r
    # 신공장·이전은 새 자리라서 산단/시군구가 맞을 때만. 증설·설비·개조는 기존 공장에서 일어나므로 같은 시도에 공장이 하나뿐이면 그것.
    if sig.get("event_type") in ("expansion", "equipment", "retrofit") and sig.get("sido") and not sig.get("sigungu"):
        same = [r for r in rows if r["sido"] == sig["sido"]]
        if len(same) == 1:
            return same[0]
    return None


def ensure_geocoded(c, rows: list[dict], geocode_address, cache: dict) -> None:
    """lat 없는 공장은 주소로 geocode 해서 저장 (타겟 회사 것만 호출되므로 건수 적음)."""
    for r in rows:
        if r.get("lat") or not r.get("address") or r.get("geocode_status") == "fail2":
            continue
        pt = geocode_address(r["address"], cache)
        if pt:
            r["lat"], r["lng"] = pt
            c.execute("update factories set lat=%s, lng=%s, geocode_status='ok' where id=%s", (pt[0], pt[1], r["id"]))
        else:  # 1차 실패는 'fail' (주소 정리 후 한 번 더), 2차 실패는 'fail2'
            c.execute("update factories set geocode_status = case when geocode_status='fail' then 'fail2' else 'fail' end where id=%s", (r["id"],))
