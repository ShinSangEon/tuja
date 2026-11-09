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
import re
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


def export_codes(c, path: str) -> int:
    """PC 쪽 1단계: 좌표 → 법정동코드(카카오)만 계산해 signals.bjdong_cd 에 저장하고 코드 목록을 파일로 쓴다. 정부 서버 접속 없음."""
    import json
    c.execute(SCHEMA)
    kakao = os.getenv("KAKAO_REST_KEY", "")
    for r in c.execute("select id, lat, lng, bjdong_cd from signals where lat is not null and not archived and bjdong_cd is null").fetchall():
        try:
            code = bjdong_code(r["lat"], r["lng"], kakao)
        except Exception as e:  # noqa: BLE001
            log.warning("bjdong %s: %s", r["id"], e); code = None
        if code:
            c.execute("update signals set bjdong_cd = %s where id = %s", (code, r["id"]))
    codes = sorted({r["bjdong_cd"] for r in c.execute("select distinct bjdong_cd from signals where bjdong_cd is not null and not archived")})
    json.dump(codes, open(path, "w"), ensure_ascii=False)
    log.info("bjdong codes exported: %d → %s", len(codes), path)
    return len(codes)


def fetch_to_file(codes_path: str, out_path: str, days: int = 365, pause: float = 1.0) -> int:
    """2단계 (회사 IP 밖에서 실행): 코드 목록을 읽어 건축HUB 를 순차·저속 호출하고 결과를 파일로."""
    import json, time
    codes = json.load(open(codes_path))
    since = date.today() - timedelta(days=days)
    rows = []
    for code in codes:
        try:
            rows += fetch_bjdong(code[:5], code[5:], since, max_pages=3)
        except Exception as e:  # noqa: BLE001
            log.warning("permits %s failed: %s", code, e)
        time.sleep(pause)
    json.dump(rows, open(out_path, "w"), ensure_ascii=False, default=str)
    log.info("permits fetched: %d rows from %d dongs → %s", len(rows), len(codes), out_path)
    return len(rows)


def load_file(c, path: str) -> int:
    """3단계 (PC): 결과 파일을 DB 에 넣고 대지위치를 카카오로 지오코딩."""
    import json, geocode
    c.execute(SCHEMA)
    rows = json.load(open(path))
    cache: dict = {}
    for p in rows:
        if p.get("plat_plc") and not p.get("lat"):
            try:
                pt = geocode.geocode_address(p["plat_plc"], cache)
            except Exception:  # noqa: BLE001
                pt = None
            if pt:
                p["lat"], p["lng"] = pt
    n = upsert(c, rows)
    log.info("permits loaded: %d", n)
    return n


def refresh_for_signals(c, days: int = 365) -> int:
    """좌표가 있는 신호마다 법정동을 정하고(signals.bjdong_cd 캐시), 법정동별로 최근 N일 공장 인허가를 가져온다."""
    if not enabled():
        log.info("permits: DATA_GO_KR_KEY 없음 → 건너뜀")
        return 0
    if os.getenv("ALLOW_GOV_API") != "1":
        log.error("permits: 회사 PC 에서 정부 API 직접 호출 금지 (2026-11-06 IP 차단 사고). "
                  "대신 run.py permits-codes → (외부에서) permits-fetch → permits-load 순으로 실행")
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


# ── 건축허가 ↔ 신호 연동 ─────────────────────────────────
_STRIP = re.compile(r"\(주\)|㈜|주식회사|\s|\(.*?\)")
_NOISE = re.compile(r"(신축공사|증축공사|신축|증축|공사|공장동|공장|사옥|물류센터|물류창고|창고|제\d+공장|\d+공장|제\d+동|\d+동|[A-Z]-?\d*동|부지|현장|신관|본관|생산동|연구동|사무동)+$")
_STAGE_RANK = {"disclosure": 0, "mou": 1, "permit": 2, "construction": 3, "completed": 4}


def _core(name: str | None) -> str:
    return _STRIP.sub("", name or "")


def company_from_bld(bld_nm: str) -> str | None:
    """건물명에서 회사명 추정: '(주)대동 차량시설검사장 증축공사' → '대동'. 지명·주소형('논공읍 북리 1-48')은 None."""
    s = (bld_nm or "").strip()
    if re.search(r"승강기|주차장|주차타워|경비실|수위실|화장실|폐수처리|위험물|옥외|담장|대문", s):
        return None  # 부속시설 허가 — 생산 증설 아님
    # '공장((주)미누스토리)' / '공장(코스맥스(주))' 처럼 괄호 안에 회사명이 있는 경우 먼저
    for g in re.findall(r"\(((?:[^()]|\(주\))+)\)", s):
        if "(주)" in g or "㈜" in g or "주식회사" in g:
            s = g.strip()
            break
    s = re.sub(r"^([가-힣]+(읍|면|동|리|구)\s+)*(\d[\d-]*\s+)+", "", s)  # 앞의 '청북읍 고렴리 1127 ' 같은 주소 토큰 제거
    if not s or re.match(r"^[가-힣]+(읍|면|동|리|구)\s", s) or re.search(r"\d+-\d+", s):
        return None
    toks = re.split(r"\s+", s)
    if "(주)" in s or "주식회사" in s or "㈜" in s:
        i = next(k for k, tk in enumerate(toks) if "(주)" in tk or "주식회사" in tk or "㈜" in tk)
        tok = toks[i]
        if tok in ("(주)", "주식회사", "㈜"):  # '(주) 대동' / '도레이첨단소재 주식회사' 처럼 떨어진 경우
            tok = tok + (toks[i + 1] if i + 1 < len(toks) and i == 0 else toks[i - 1] if i > 0 else "")
        elif tok.startswith(("(주)", "㈜")) and len(tok) <= 3 and i + 1 < len(toks):
            tok += toks[i + 1]
        else:
            m = re.match(r"^(.+?)(\(주\)|㈜|주식회사)", tok)
            if m and m.group(1):  # '현대모비스(주)창원공장' → 법인 표기 뒤는 지명·시설명
                tok = m.group(1)
        s = tok
    else:
        s = toks[0]
    s = _NOISE.sub("", _STRIP.sub("", s))
    s = re.sub(r"(사무|검사장|승강기|주차장|기숙사|식당)$", "", s)
    if s in {"품질관리", "공장시설", "사무", "창고", "공장", "시설"}:
        return None
    return s if len(s) >= 2 and not re.fullmatch(r"[\d\W]+", s) else None


def link_signals(c, log_activity: bool = True) -> dict:
    """1) 허가 건물명에 레이더 회사명이 보이면 단계를 인허가/착공으로 승격(기존 단계가 더 앞설 때만)
       2) 레이더에 없는 1만㎡ 이상 공장 허가는 raw_documents+extractions 로 등록 → rebuild/ingest 가 신호로 만든다."""
    import json
    from psycopg.types.json import Jsonb
    promoted, created = 0, 0
    sigs = c.execute("select id, company_name, company_norm, stage, bjdong_cd, sido from signals where not archived and bjdong_cd is not null").fetchall()
    perms = c.execute("select * from permits where bld_nm is not null").fetchall()
    by_dong: dict = {}
    for p in perms:
        by_dong.setdefault(p["sigungu_cd"] + p["bjdong_cd"], []).append(p)
    matched_permit_ids = set()
    for s in sigs:
        core = _core(s["company_name"])
        if len(core) < 2:
            continue
        hits = [p for p in by_dong.get(s["bjdong_cd"], []) if core.lower() in _core(p["bld_nm"]).lower()]
        if not hits:
            continue
        matched_permit_ids.update(p["id"] for p in hits)
        best = max(hits, key=lambda p: (bool(p["real_stcns_day"]), p["pms_day"] or ""))
        target = "completed" if best["use_apr_day"] else "construction" if best["real_stcns_day"] else "permit"
        if _STAGE_RANK.get(target, 0) > _STAGE_RANK.get(s["stage"], 0) and s["stage"] != "completed":
            c.execute("update signals set stage = %s where id = %s", (target, s["id"]))
            if log_activity:
                labels = {"permit": "인허가", "construction": "착공", "completed": "준공"}
                c.execute("insert into signal_activities (signal_id, actor, kind, content) values (%s,'시스템','system',%s)",
                          (s["id"], f"건축허가 원장 확인({best['bld_nm']}, {best['arch_gb'] or ''} {int(best['tot_area'] or 0):,}㎡, 허가 {best['pms_day']}) → 단계 {labels[target]}"))
            promoted += 1
    # 2) 대형 허가 자동 등록
    known = {s["company_norm"] for s in c.execute("select company_norm from signals")}
    aliases = {r["alias_norm"]: r["canonical_norm"] for r in c.execute("select alias_norm, canonical_norm from company_aliases")}
    from validate import normalize_company
    for p in perms:
        if p["id"] in matched_permit_ids or not p["tot_area"] or float(p["tot_area"]) < 10000 or p["use_apr_day"]:
            continue
        if (p["arch_gb"] or "") not in ("신축", "증축", "개축"):
            continue
        name = company_from_bld(p["bld_nm"])
        if not name:
            continue
        norm = normalize_company(name, aliases)
        if norm in known or any(norm in k or k in norm for k in known if len(k) >= 3 and len(norm) >= 3):
            continue
        url = f"permit://{p['id']}"
        if c.execute("select 1 from raw_documents where url = %s", (url,)).fetchone():
            continue
        from factories import split_region
        sido, sigungu = split_region(p["plat_plc"] or "")
        stage = "construction" if p["real_stcns_day"] else "permit"
        etype = "new_plant" if p["arch_gb"] == "신축" else "expansion"
        title = f"[건축허가] {p['bld_nm']} — {p['arch_gb']} {int(float(p['tot_area'])):,}㎡"
        body = (f"건축HUB 건축인허가 원장. 대지위치 {p['plat_plc']}. 건물명 {p['bld_nm']}. 구분 {p['arch_gb']}, 주용도 {p['main_purps'] or '미기재'}, "
                f"연면적 {int(float(p['tot_area'])):,}㎡, 대지면적 {int(float(p['plat_area'] or 0)):,}㎡, 용도지역 {p['jiyuk'] or '-'}. "
                f"허가일 {p['pms_day']}, 착공예정 {p['stcns_sched_day'] or '-'}, 실착공 {p['real_stcns_day'] or '-'}.")
        pub = None
        try:
            pub = date(int(p["pms_day"][:4]), int(p["pms_day"][4:6]), int(p["pms_day"][6:8]))
        except Exception:  # noqa: BLE001
            pass
        did = c.execute("""insert into raw_documents (source_type, source_name, source_tier, url, title, body, published_at, meta, prefilter_pass, extracted)
                           values ('permit','건축HUB',1,%s,%s,%s,%s,%s,true,true) returning id""",
                        (url, title, body, pub, Jsonb({"permit_id": p["id"], "bjdong": p["sigungu_cd"] + p["bjdong_cd"]}))).fetchone()["id"]
        payload = {
            "doc_id": str(did), "is_relevant": True,
            "company": {"name_raw": name, "name_norm": norm, "group": None, "listed": None, "corp_code": None},
            "event": {"type": etype, "stage": stage, "summary": f"건축허가 원장에서 포착: {p['bld_nm']} {p['arch_gb']} 연면적 {int(float(p['tot_area'])):,}㎡ (허가 {p['pms_day'][:4]}.{p['pms_day'][4:6]}.{p['pms_day'][6:]}{', 착공 ' + p['real_stcns_day'] if p['real_stcns_day'] else ''}). 뉴스 미보도 — 현장·용도 확인 필요", "purpose": None},
            "investment": {"amount_krw": None, "amount_disclosed": False, "period_start": None, "period_end": None, "floor_area_m2": float(p["tot_area"])},
            "location": {"sido": sido, "sigungu": sigungu, "industrial_complex": None, "address_raw": p["plat_plc"], "precision": "address"},
            "industry": {"sector": "기타", "process_hint": p["main_purps"]},
            "utility_need": {"compressed_air": 2, "dryer": 1, "hmi_control": 1, "rationale": "업종 미확인 — 공장 신·증축 일반 수요"},
            "confidence": 0.6, "_lat": p["lat"], "_lng": p["lng"],
        }
        c.execute("insert into extractions (document_id, model, is_relevant, payload, confidence) values (%s,'permit-registry',true,%s,0.6)", (did, Jsonb(payload)))
        created += 1
    log.info("permits→signals: stage promoted %d, new permit-signals %d", promoted, created)
    return {"promoted": promoted, "created": created}
