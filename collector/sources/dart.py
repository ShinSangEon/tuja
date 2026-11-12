"""OpenDART — 「신규시설투자등」 공시 수집.

흐름: list.json 을 거래소공시(I: 신규시설투자등) + 주요사항보고(B: 유형자산양수·비유동자산취득) 로 조회
      → report_nm 키워드 필터 → document.xml(zip) → 텍스트 추출.
무료, 일 10,000건. https://opendart.fss.or.kr
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import date, datetime, timedelta

import requests

from config import DART_API_KEY

log = logging.getLogger(__name__)
BASE = "https://opendart.fss.or.kr/api"
# (공시유형, report_nm 키워드)
QUERIES = (
    ("I", ("신규시설투자",)),                      # 거래소공시: 신규시설투자등
    ("B", ("유형자산양수", "비유동자산취득")),      # 주요사항보고: 공장·부지·설비 매입
    ("B", ("유상증자결정", "전환사채권발행결정", "신주인수권부사채권발행결정", "교환사채권발행결정")),  # 자금조달 — 아래에서 '시설자금' 있는 건만 남김
)
FUNDING_REPORTS = ("유상증자", "전환사채", "신주인수권부사채", "교환사채")
_FACILITY_RE = re.compile(r"시설자금\s*\(원\)?\s*([0-9,]+)")


def facility_funding(text: str) -> int | None:
    """자금조달 공시 본문에서 '시설자금 (원) 12,000,000,000' 금액. 없거나 '-'/0 이면 None."""
    m = _FACILITY_RE.search(text or "")
    if not m:
        return None
    try:
        v = int(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return v or None


def _list_page(bgn: str, end: str, page: int, pblntf_ty: str = "I") -> dict:
    r = requests.get(
        f"{BASE}/list.json",
        params={
            "crtfc_key": DART_API_KEY,
            "bgn_de": bgn,
            "end_de": end,
            "pblntf_ty": pblntf_ty,
            "page_no": page,
            "page_count": 100,
            "last_reprt_at": "Y",  # 정정 시 최종본만
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def list_disclosures(since: date, until: date | None = None) -> list[dict]:
    """기간 내 신규시설투자 관련 공시 메타 목록."""
    until = until or date.today()
    bgn, end = since.strftime("%Y%m%d"), until.strftime("%Y%m%d")
    out, seen = [], set()
    for ty, keywords in QUERIES:
        page = 1
        while True:
            data = _list_page(bgn, end, page, ty)
            status = data.get("status")
            if status == "013":  # 조회 결과 없음
                break
            if status != "000":
                raise RuntimeError(f"DART list error {status}: {data.get('message')}")
            for item in data.get("list", []):
                if item["rcept_no"] in seen:
                    continue
                if any(k in item["report_nm"] for k in keywords):
                    seen.add(item["rcept_no"])
                    out.append(item)
            if page >= int(data.get("total_page", 1)):
                break
            page += 1
    log.info("DART: %d disclosures matched %s~%s", len(out), bgn, end)
    return out


_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"[ \t\r\f\v]+")


def fetch_document_text(rcept_no: str) -> str:
    """document.xml 은 zip — 안의 xml 을 풀어 태그 제거 후 텍스트로."""
    r = requests.get(
        f"{BASE}/document.xml",
        params={"crtfc_key": DART_API_KEY, "rcept_no": rcept_no},
        timeout=60,
    )
    r.raise_for_status()
    if r.headers.get("content-type", "").startswith("application/json"):
        raise RuntimeError(f"DART document error: {r.text[:200]}")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = [n for n in z.namelist() if n.lower().endswith((".xml", ".html", ".htm"))]
        if not names:
            return ""
        raw = z.read(names[0])
    text = raw.decode("utf-8", errors="ignore")
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    text = re.sub(r"</(TR|P|DIV|BR|TD)>", "\n", text, flags=re.I)
    text = _TAG.sub(" ", text)
    text = _WS.sub(" ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def _focus(text: str, max_chars: int = 6000) -> str:
    """투자 관련 표(투자구분·투자금액·투자기간·투자목적·투자대상/지역)가 있는 부분 위주로 자른다."""
    anchors = ["투자구분", "투자금액", "투자기간", "투자목적", "투자효과", "투자대상", "소재지", "위치", "자금조달의 목적", "시설자금"]
    idx = min((text.find(a) for a in anchors if text.find(a) >= 0), default=0)
    start = max(0, idx - 500)
    return text[start : start + max_chars]


def fetch(since: date, include_body: bool = True) -> list[dict]:
    docs = []
    for item in list_disclosures(since):
        rcept_no = item["rcept_no"]
        url = f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcept_no}"
        body = ""
        is_funding = any(k in item["report_nm"] for k in FUNDING_REPORTS)
        if include_body or is_funding:
            try:
                full = fetch_document_text(rcept_no)
            except Exception as e:  # 한 건 실패가 전체를 막지 않게
                log.warning("DART doc %s failed: %s", rcept_no, e)
                full = ""
            if is_funding:
                amt = facility_funding(full)
                if not amt:
                    continue  # 운영자금·채무상환만 있는 조달은 제외
                item = {**item, "report_nm": f"{item['report_nm']} (시설자금 {amt // 100000000:,}억)"}
            body = _focus(full)
        published = datetime.strptime(item["rcept_dt"], "%Y%m%d")
        docs.append(
            {
                "source_type": "dart",
                "source_name": "DART",
                "source_tier": 1,
                "url": url,
                "title": f"[{item['corp_name']}] {item['report_nm']}",
                "body": body,
                "published_at": published,
                "meta": {
                    "rcept_no": rcept_no,
                    "corp_code": item["corp_code"],
                    "corp_name": item["corp_name"],
                    "stock_code": item.get("stock_code"),
                    "corp_cls": item.get("corp_cls"),
                },
            }
        )
    return docs


def download_corp_codes() -> list[dict]:
    """전체 기업 고유번호 (corpCode.xml zip). company_aliases / 엔티티 매칭용."""
    r = requests.get(f"{BASE}/corpCode.xml", params={"crtfc_key": DART_API_KEY}, timeout=120)
    r.raise_for_status()
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        raw = z.read("CORPCODE.xml")
    rows = []
    for el in ET.fromstring(raw).iter("list"):  # corp_eng_name 등 필드가 추가돼도 안전
        rows.append({"corp_code": (el.findtext("corp_code") or "").strip(), "corp_name": (el.findtext("corp_name") or "").strip(),
                     "stock_code": (el.findtext("stock_code") or "").strip()})
    return rows


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    for d in fetch(date.today() - timedelta(days=14), include_body=False)[:10]:
        print(d["published_at"].date(), d["title"], d["url"])
