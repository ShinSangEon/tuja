"""건축HUB 건축인허가정보 (국토교통부, 공공데이터포털 15136267) — 착공 임박 신호.

API 특성 (가이드 1.0 + 실측):
  - getApBasisOulnInfo 는 sigunguCd + bjdongCd(법정동) 가 **필수**. 시군구 전체 조회 불가 → 신호 좌표의 법정동 단위로 조회한다.
  - startDate/endDate 는 허가일이 아니라 레코드 생성·갱신일(crtnDay) 기준. 허가일(archPmsDay) 필터는 클라이언트에서.
  - 주용도(mainPurpsCdNm)·건축구분(archGbCdNm)이 빈 레코드가 많다(가설·부속). 공장 판정은 아래 _is_factory.
흐름: signals(lat,lng) → 카카오 coord2regioncode 로 법정동코드(10자리) → 법정동마다 최근 N일 레코드 → 공장·창고 신·증축만 permits 에 저장 → 대지위치 지오코딩.
키: DATA_GO_KR_KEY. 없으면 조용히 건너뛴다.
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta

import requests

log = logging.getLogger(__name__)
KEY = os.getenv("DATA_GO_KR_KEY", "")
URL = "https://apis.data.go.kr/1613000/ArchPmsHubService/getApBasisOulnInfo"
KAKAO_REGION = "https://dapi.kakao.com/v2/local/geo/coord2regioncode.json"
FACTORY_WORDS = ("공장", "창고", "제조")
MIN_TOT_AREA = 300.0  # ㎡ — 경비실·가설건축물 제외

SCHEMA = """
create table if not exists permits (
  id text primary key,                 -- mgmPmsrgstPk
  sigungu_cd text not null, bjdong_cd text not null,
  plat_plc text,                       -- 대지위치
  bld_nm text, main_purps text, arch_gb text,
  tot_area numeric, arch_area numeric, plat_area numeric,
  jimok text, jiyuk text,
  pms_day text, stcns_sched_day text, real_stcns_day text, use_apr_day text, crtn_day text,
  lat double precision, lng double precision,
  fetched_at timestamptz not null default now()
);
create index if not exists permits_bjdong_idx on permits (sigungu_cd, bjdong_cd, pms_day desc);
alter table signals add column if not exists bjdong_cd text;
"""


def enabled() -> bool:
    return bool(KEY)


def _s(v) -> str:
    return (v or "").strip() if isinstance(v, str) else ("" if v is None else str(v))


def _is_factory(it: dict) -> bool:
    if not _s(it.get("archGbCdNm")):
        return False  # 건축구분 없는 건 = 가설·부속·정정 → 제외
    purps = _s(it.get("mainPurpsCdNm")) + _s(it.get("etcPurps"))
    jimok = _s(it.get("jimokCdNm"))
    try:
        tot = float(it.get("totArea") or 0)
    except (TypeError, ValueError):
        tot = 0.0
    if tot < MIN_TOT_AREA:
        return False
    return any(w in purps for w in FACTORY_WORDS) or (jimok == "공장용지" and not purps)


def bjdong_code(lat: float, lng: float, kakao_key: str) -> str | None:
    """좌표 → 법정동코드 10자리 (앞 5 시군구, 뒤 5 법정동)."""
    r = requests.get(KAKAO_REGION, headers={"Authorization": f"KakaoAK {kakao_key}"}, params={"x": lng, "y": lat}, timeout=10)
    if r.status_code != 200:
        return None
    for d in r.json().get("documents") or []:
        if d.get("region_type") == "B" and d.get("code"):
            return d["code"]
    return None


def fetch_bjdong(sigungu_cd: str, bjdong_cd: str, since: date, max_pages: int = 5) -> list[dict]:
    out = []
    for page in range(1, max_pages + 1):
        r = requests.get(URL, params={"serviceKey": KEY, "sigunguCd": sigungu_cd, "bjdongCd": bjdong_cd,
                                      "startDate": since.strftime("%Y%m%d"), "endDate": date.today().strftime("%Y%m%d"),
                                      "numOfRows": 100, "pageNo": page, "_type": "json"}, timeout=30)
        r.raise_for_status()
        body = r.json().get("response", {}).get("body", {})
        items = body.get("items", {}).get("item", []) if isinstance(body.get("items"), dict) else []
        if isinstance(items, dict):
            items = [items]
        for it in items:
            if not _is_factory(it) or _s(it.get("archPmsDay")) < since.strftime("%Y%m%d"):
                continue
            out.append({
                "id": str(it.get("mgmPmsrgstPk")), "sigungu_cd": sigungu_cd, "bjdong_cd": bjdong_cd,
                "plat_plc": _s(it.get("platPlc")), "bld_nm": _s(it.get("bldNm")) or None,
                "main_purps": _s(it.get("mainPurpsCdNm")) or None, "arch_gb": _s(it.get("archGbCdNm")) or None,
                "tot_area": it.get("totArea"), "arch_area": it.get("archArea"), "plat_area": it.get("platArea"),
                "jimok": _s(it.get("jimokCdNm")) or None, "jiyuk": _s(it.get("jiyukCdNm")) or None,
                "pms_day": _s(it.get("archPmsDay")) or None, "stcns_sched_day": _s(it.get("stcnsSchedDay")) or None,
                "real_stcns_day": _s(it.get("realStcnsDay")) or None, "use_apr_day": _s(it.get("useAprDay")) or None,
                "crtn_day": _s(it.get("crtnDay")) or None,
            })
        if len(items) < 100:
            break
    return out


def upsert(c, rows: list[dict]) -> int:
    n = 0
    for r in rows:
        cols = list(r.keys())
        sets = ", ".join(f"{k} = excluded.{k}" for k in cols if k != "id")
        c.execute(f"insert into permits ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))}) "
                  f"on conflict (id) do update set {sets}, fetched_at = now()", [r[k] for k in cols])
        n += 1
    return n


def refresh_for_signals(c, days: int = 365) -> int:
    """좌표가 있는 신호마다 법정동을 정하고(signals.bjdong_cd 캐시), 법정동별로 최근 N일 공장 인허가를 가져온다."""
    if not enabled():
        log.info("permits: DATA_GO_KR_KEY 없음 → 건너뜀")
        return 0
    import geocode
    c.execute(SCHEMA)
    kakao = os.getenv("KAKAO_REST_KEY", "")
    rows = c.execute("select id, lat, lng, bjdong_cd from signals where lat is not null and not archived").fetchall()
    for r in rows:
        if r["bjdong_cd"]:
            continue
        try:
            code = bjdong_code(r["lat"], r["lng"], kakao)
        except Exception as e:  # noqa: BLE001
            log.warning("bjdong %s: %s", r["id"], e)
            code = None
        if code:
            c.execute("update signals set bjdong_cd = %s where id = %s", (code, r["id"]))
    codes = {r["bjdong_cd"] for r in c.execute("select distinct bjdong_cd from signals where bjdong_cd is not null and not archived")}
    since = date.today() - timedelta(days=days)
    total = 0
    cache: dict = {}
    for code in sorted(codes):
        try:
            got = fetch_bjdong(code[:5], code[5:], since)
        except Exception as e:  # noqa: BLE001
            log.warning("permits %s failed: %s", code, e)
            continue
        for p in got:
            if p.get("plat_plc"):
                try:
                    pt = geocode.geocode_address(p["plat_plc"], cache)
                except Exception:  # noqa: BLE001
                    pt = None
                if pt:
                    p["lat"], p["lng"] = pt
        total += upsert(c, got)
        log.info("permits %s: %d", code, len(got))
    return total
