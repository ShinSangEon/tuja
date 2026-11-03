"""회사 카드 — DART 에서 상장사 프로필을 모아 companies 테이블에 저장.

  기본정보  company.json      대표, 설립일, 주소, 홈페이지, 업종코드
  재무 3년  fnlttSinglAcnt    매출·영업이익·순이익·자산·유형자산 (연결 우선, 없으면 별도)
  종업원    empSttus          합계
  사업보고서 document.xml     「사업의 개요」 앞부분 + 「원재료 및 생산설비」 섹션 원문(생산능력·가동률·설비 장부가)

signals.corp_code 가 있는 회사(또는 company_norm 이 corp_codes 와 일치하는 회사)만 대상. 30일 지난 것만 갱신.
"""
from __future__ import annotations

import io
import json
import logging
import re
import zipfile
from datetime import date

import requests

from config import DART_API_KEY

log = logging.getLogger(__name__)
BASE = "https://opendart.fss.or.kr/api"
ACCOUNTS = {"매출액": "revenue", "영업이익": "op_income", "당기순이익": "net_income", "자산총계": "assets", "유형자산": "tangible", "자본총계": "equity"}


def _get(path: str, **params) -> dict:
    r = requests.get(f"{BASE}/{path}", params={"crtfc_key": DART_API_KEY, **params}, timeout=60)
    r.raise_for_status()
    return r.json()


def _num(s) -> int | None:
    try:
        return int(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return None


def profile(corp_code: str) -> dict:
    j = _get("company.json", corp_code=corp_code)
    if j.get("status") != "000":
        return {}
    return {"ceo": j.get("ceo_nm"), "established": j.get("est_dt"), "address": j.get("adres"), "homepage": j.get("hm_url"),
            "phone": j.get("phn_no"), "induty_code": j.get("induty_code"), "corp_name": j.get("corp_name"), "stock_code": j.get("stock_code")}


def financials(corp_code: str, year: int) -> tuple[list[dict], int]:
    """최근 사업보고서 1건으로 3개년. 반환 (rows, 기준연도). 올해 보고서가 없으면 작년 것."""
    for y in (year, year - 1):
        j = _get("fnlttSinglAcnt.json", corp_code=corp_code, bsns_year=str(y), reprt_code="11011")
        if j.get("status") == "000" and j.get("list"):
            rows = j["list"]
            fs = "CFS" if any(r["fs_div"] == "CFS" for r in rows) else "OFS"
            out = {y: {"year": y}, y - 1: {"year": y - 1}, y - 2: {"year": y - 2}}
            for r in rows:
                if r["fs_div"] != fs or r["account_nm"] not in ACCOUNTS:
                    continue
                k = ACCOUNTS[r["account_nm"]]
                out[y][k] = _num(r.get("thstrm_amount")); out[y - 1][k] = _num(r.get("frmtrm_amount")); out[y - 2][k] = _num(r.get("bfefrmtrm_amount"))
            return [out[y - 2], out[y - 1], out[y]], y
    return [], year


def employees(corp_code: str, year: int) -> int | None:
    for y in (year, year - 1):
        j = _get("empSttus.json", corp_code=corp_code, bsns_year=str(y), reprt_code="11011")
        if j.get("status") == "000" and j.get("list"):
            tot = 0
            for r in j["list"]:
                n = _num(r.get("sm"))
                if n:
                    tot += n
            return tot or None
    return None


def latest_annual_report(corp_code: str, year: int) -> dict | None:
    j = _get("list.json", corp_code=corp_code, bgn_de=f"{year - 1}0101", end_de=date.today().strftime("%Y%m%d"), pblntf_ty="A", page_count=50, last_reprt_at="Y")
    reps = [i for i in j.get("list", []) if i["report_nm"].strip().startswith("사업보고서")]
    return reps[0] if reps else None


_TAG = re.compile(r"<[^>]+>")


def report_text(rcept_no: str) -> str:
    r = requests.get(f"{BASE}/document.xml", params={"crtfc_key": DART_API_KEY, "rcept_no": rcept_no}, timeout=180)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        main = max(z.namelist(), key=lambda n: z.getinfo(n).file_size)
        xml = z.read(main).decode("utf-8", errors="ignore")
    t = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", xml, flags=re.S | re.I)
    t = re.sub(r"</(TR|P|DIV|TD)>", "\n", t, flags=re.I)
    t = _TAG.sub(" ", t)
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n", t)
    return t


def _section(t: str, start_pat: str, end_pats: list[str], max_chars: int) -> str:
    m = re.search(start_pat, t)
    if not m:
        return ""
    s = m.start()
    e = len(t)
    for p in end_pats:
        m2 = re.search(p, t[s + 50:])
        if m2:
            e = min(e, s + 50 + m2.start())
    return t[s:e][:max_chars].strip()


def sections(t: str) -> dict:
    overview = _section(t, r"\n\s*1\.\s*사업의 개요", [r"\n\s*2\.\s*주요\s*제품", r"\n\s*2\.\s*[가-힣]{2}"], 2500)
    facility = _section(t, r"\n\s*3\.\s*원재료\s*및\s*생산설비", [r"\n\s*4\.\s*매출", r"\n\s*4\.\s*[가-힣]{2}", r"\n\s*(III|Ⅲ)\.\s"], 16000)
    if not facility:
        facility = _section(t, r"생산설비의\s*현황|생산능력\s*및\s*생산실적|\n[^\n]{0,8}생산능력", [r"\n\s*4\.\s*매출", r"\n\s*\d\.\s*매출", r"\n\s*(III|Ⅲ)\.\s"], 12000)
    return {"overview": overview, "facility": facility}


def build(corp_code: str) -> dict:
    year = date.today().year
    p = profile(corp_code)
    fin, fy = financials(corp_code, year)
    emp = employees(corp_code, year)
    rep = latest_annual_report(corp_code, year)
    secs = {"overview": "", "facility": ""}
    if rep:
        try:
            secs = sections(report_text(rep["rcept_no"]))
        except Exception as e:  # noqa: BLE001
            log.warning("report text failed %s: %s", rep["rcept_no"], e)
    return {**p, "corp_code": corp_code, "fin_year": fy, "financials": fin, "employees": emp,
            "report_rcept_no": rep["rcept_no"] if rep else None, "report_name": rep["report_nm"].strip() if rep else None,
            "overview": secs["overview"], "facility_text": secs["facility"]}


SCHEMA = """
create table if not exists companies (
  corp_code text primary key,
  corp_name text, stock_code text, ceo text, established text, address text, homepage text, phone text, induty_code text,
  employees int, fin_year int, financials jsonb default '[]'::jsonb,
  report_rcept_no text, report_name text, overview text, facility_text text,
  facility_summary text,            -- 사람/세션이 요약해 넣는 칸 (공장별 위치·capa·가동률 한 줄씩)
  hq_lat double precision, hq_lng double precision,
  updated_at timestamptz not null default now()
);
"""


def upsert(c, row: dict):
    c.execute(SCHEMA)
    cols = ["corp_code", "corp_name", "stock_code", "ceo", "established", "address", "homepage", "phone", "induty_code", "employees", "fin_year",
            "financials", "report_rcept_no", "report_name", "overview", "facility_text"]
    vals = [json.dumps(row.get(k), ensure_ascii=False) if k == "financials" else row.get(k) for k in cols]
    sets = ", ".join(f"{k} = excluded.{k}" for k in cols if k != "corp_code") + ", updated_at = now()"
    c.execute(f"insert into companies ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))}) on conflict (corp_code) do update set {sets}", vals)


def targets(c, max_age_days: int = 30) -> list[str]:
    """갱신 대상 corp_code: signals 에 연결된 상장사 중 companies 가 없거나 오래된 것."""
    c.execute(SCHEMA)
    c.execute("""update signals s set corp_code = cc.corp_code from corp_codes cc
                 where s.corp_code is null and s.company_norm = cc.name_norm""")
    rows = c.execute("""select distinct s.corp_code from signals s left join companies co on co.corp_code = s.corp_code
                        where s.corp_code is not null and not s.archived
                          and (co.corp_code is null or co.updated_at < now() - (%s || ' days')::interval)""", (str(max_age_days),)).fetchall()
    return [r["corp_code"] for r in rows]
