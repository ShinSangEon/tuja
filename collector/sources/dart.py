"""OpenDART — 「신규시설투자등」 공시 수집.

흐름: list.json(주요사항보고 B) → report_nm 에 '신규시설투자' 포함 건 → document.xml(zip) → 텍스트 추출.
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
KEYWORDS = ("신규시설투자", "시설투자", "유형자산 취득")  # report_nm 필터


def _list_page(bgn: str, end: str, page: int) -> dict:
    r = requests.get(
        f"{BASE}/list.json",
        params={
            "crtfc_key": DART_API_KEY,
            "bgn_de": bgn,
            "end_de": end,
            "pblntf_ty": "B",      # 주요사항보고
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
    out, page = [], 1
    while True:
        data = _list_page(bgn, end, page)
        status = data.get("status")
        if status == "013":  # 조회 결과 없음
            break
        if status != "000":
            raise RuntimeError(f"DART list error {status}: {data.get('message')}")
        for item in data.get("list", []):
            if any(k in item["report_nm"] for k in KEYWORDS):
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
    anchors = ["투자구분", "투자금액", "투자기간", "투자목적", "투자효과", "투자대상", "소재지", "위치"]
    idx = min((text.find(a) for a in anchors if text.find(a) >= 0), default=0)
    start = max(0, idx - 500)
    return text[start : start + max_chars]


def fetch(since: date, include_body: bool = True) -> list[dict]:
    docs = []
    for item in list_disclosures(since):
        rcept_no = item["rcept_no"]
        url = f"https://dart.fss.or.kr/dsaf001/main.do?rcptNo={rcept_no}"
        body = ""
        if include_body:
            try:
                body = _focus(fetch_document_text(rcept_no))
            except Exception as e:  # 한 건 실패가 전체를 막지 않게
                log.warning("DART doc %s failed: %s", rcept_no, e)
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
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        xml = z.read("CORPCODE.xml").decode("utf-8")
    rows = []
    for m in re.finditer(
        r"<corp_code>(\d+)</corp_code>\s*<corp_name>(.*?)</corp_name>\s*<stock_code>(.*?)</stock_code>",
        xml,
        flags=re.S,
    ):
        rows.append({"corp_code": m.group(1), "corp_name": m.group(2).strip(), "stock_code": m.group(3).strip()})
    return rows


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    for d in fetch(date.today() - timedelta(days=14), include_body=False)[:10]:
        print(d["published_at"].date(), d["title"], d["url"])
