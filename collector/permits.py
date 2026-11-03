"""건축HUB 건축인허가정보 (국토교통부, 공공데이터포털 15136267) — 착공 임박 신호.

getApBasisOulnInfo: 시군구코드+법정동코드 단위 조회. 전국을 다 훑을 수는 없으니
  (1) signals 가 있는 시군구에서 최근 N일 허가분 중 주용도가 '공장' 인 건을 가져와 permits 테이블에 저장
  (2) 신호 상세에 "이 지역 최근 공장 인허가" 로 표시하고, 같은 회사면 stage 를 permit 으로 끌어올리는 후보가 된다
키: DATA_GO_KR_KEY (공공데이터포털 활용신청 후 발급). 없으면 조용히 건너뛴다.
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta

import requests

log = logging.getLogger(__name__)
KEY = os.getenv("DATA_GO_KR_KEY", "")
URL = "https://apis.data.go.kr/1613000/ArchPmsHubService/getApBasisOulnInfo"

SCHEMA = """
create table if not exists permits (
  id text primary key,                 -- mgmPmsrgstPk
  sigungu_cd text, bjdong_cd text,
  plat_plc text,                       -- 대지위치
  bld_nm text, main_purps text, etc_purps text,
  tot_area numeric, arch_area numeric,
  pms_day text, stcns_sched_day text, real_stcns_day text, use_apr_day text,
  arch_gb text,                        -- 신축/증축 등
  lat double precision, lng double precision,
  fetched_at timestamptz not null default now()
);
create index if not exists permits_sigungu_idx on permits (sigungu_cd, pms_day desc);
"""


def enabled() -> bool:
    return bool(KEY)


def fetch_sigungu(sigungu_cd: str, since: date, max_pages: int = 10) -> list[dict]:
    """시군구 단위 전체(법정동 미지정)는 API 가 허용하지 않을 수 있어 법정동 코드별로 돌려야 할 수 있다 — 우선 시군구만 시도."""
    out = []
    for page in range(1, max_pages + 1):
        r = requests.get(URL, params={"serviceKey": KEY, "sigunguCd": sigungu_cd, "startDate": since.strftime("%Y%m%d"),
                                      "endDate": date.today().strftime("%Y%m%d"), "numOfRows": 100, "pageNo": page, "_type": "json"}, timeout=30)
        r.raise_for_status()
        body = r.json().get("response", {}).get("body", {})
        items = body.get("items", {}).get("item", []) if isinstance(body.get("items"), dict) else []
        if isinstance(items, dict):
            items = [items]
        for it in items:
            if "공장" not in (it.get("mainPurpsCdNm") or "") and "공장" not in (it.get("etcPurps") or ""):
                continue
            out.append({
                "id": str(it.get("mgmPmsrgstPk")), "sigungu_cd": sigungu_cd, "bjdong_cd": it.get("bjdongCd"),
                "plat_plc": it.get("platPlc"), "bld_nm": it.get("bldNm"), "main_purps": it.get("mainPurpsCdNm"), "etc_purps": it.get("etcPurps"),
                "tot_area": it.get("totArea"), "arch_area": it.get("archArea"), "pms_day": it.get("pmsDay"), "stcns_sched_day": it.get("stcnsSchedDay"),
                "real_stcns_day": it.get("realStcnsDay"), "use_apr_day": it.get("useAprDay"), "arch_gb": it.get("archGbCdNm"),
            })
        if len(items) < 100:
            break
    return out


def upsert(c, rows: list[dict]) -> int:
    c.execute(SCHEMA)
    n = 0
    for r in rows:
        cols = list(r.keys())
        c.execute(f"insert into permits ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))}) on conflict (id) do update set fetched_at = now()", [r[k] for k in cols])
        n += 1
    return n


def refresh_for_signals(c, days: int = 120) -> int:
    """signals 가 있는 시군구(법정동코드 앞 5자리)마다 최근 공장 인허가를 수집. regions 테이블에 시군구 코드가 없으므로 카카오 로컬 API 결과의 b_code 를 활용해야 하나,
    1차로는 signals.address_raw/sigungu 로 카카오에서 b_code 를 얻어 사용."""
    if not enabled():
        log.info("permits: DATA_GO_KR_KEY 없음 → 건너뜀")
        return 0
    import geocode
    rows = c.execute("select distinct sido, sigungu from signals where sigungu is not null and not archived").fetchall()
    total = 0
    for r in rows:
        code = geocode.sigungu_code(f"{r['sido']} {r['sigungu']}")
        if not code:
            continue
        try:
            got = fetch_sigungu(code, date.today() - timedelta(days=days))
            total += upsert(c, got)
            log.info("permits %s %s: %d", r["sigungu"], code, len(got))
        except Exception as e:  # noqa: BLE001
            log.warning("permits %s failed: %s", r["sigungu"], e)
    return total
