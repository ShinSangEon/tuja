"""네이버 뉴스 검색 API — 키워드 묶음으로 증설·신설·설비투자 기사 수집.

2026년 기준 검색 API 는 개발자센터(developers.naver.com)에서 종료되고 **NAVER API Hub(네이버 클라우드 플랫폼)** 로 이관됨.
  - 엔드포인트: https://naverapihub.apigw.ntruss.com/search/v1/news  (GET, 일 25,000건)
  - 헤더: X-NCP-APIGW-API-KEY-ID (Client ID) / X-NCP-APIGW-API-KEY (Client Secret)
  - 응답 형식(items[].title/originallink/link/description/pubDate)은 예전과 동일
예전 개발자센터 키가 아직 살아 있으면 .env 에 NAVER_LEGACY=1 로 구형 엔드포인트 사용.
본문은 API가 안 주므로 링크를 열어 본문을 가져온다(기사 전문은 추출에만 쓰고 90일 후 purge).
"""
from __future__ import annotations

import html
import logging
import re
from datetime import date, datetime
from email.utils import parsedate_to_datetime

import requests
from bs4 import BeautifulSoup

from config import (NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, NAVER_MAX_PER_KEYWORD, NEWS_KEYWORDS,
                    TIER2_PRESS)

log = logging.getLogger(__name__)
import os
NAVER_LEGACY = os.getenv("NAVER_LEGACY", "") == "1"
NAVER_BASE = "https://openapi.naver.com/v1/search/news.json" if NAVER_LEGACY else "https://naverapihub.apigw.ntruss.com/search/v1/news"
NAVER_HEADERS = (
    {"X-Naver-Client-Id": NAVER_CLIENT_ID, "X-Naver-Client-Secret": NAVER_CLIENT_SECRET}
    if NAVER_LEGACY
    else {"X-NCP-APIGW-API-KEY-ID": NAVER_CLIENT_ID, "X-NCP-APIGW-API-KEY": NAVER_CLIENT_SECRET}
)
UA = {"User-Agent": "Mozilla/5.0 (compatible; GENEQ-InvestRadar/0.1)"}
_TAG = re.compile(r"<[^>]+>")


def _clean(s: str) -> str:
    return html.unescape(_TAG.sub("", s or "")).strip()


def search(keyword: str, display: int = 30) -> list[dict]:
    r = requests.get(
        NAVER_BASE,
        headers=NAVER_HEADERS,
        params={"query": keyword, "display": min(display, 100), "sort": "date", "format": "json"},
        timeout=20,
    )
    r.raise_for_status()
    return r.json().get("items", [])


def _source_name(link: str, originallink: str) -> str:
    """매체명 추정: 도메인 → 알려진 매체 매핑. 못 찾으면 도메인 그대로."""
    host = re.sub(r"^https?://(www\.)?", "", originallink or link).split("/")[0]
    for name in TIER2_PRESS:
        if name.lower() in host.lower():
            return name
    mapping = {
        "yna.co.kr": "연합뉴스", "newsis.com": "뉴시스", "news1.kr": "뉴스1", "hankyung.com": "한국경제",
        "mk.co.kr": "매일경제", "sedaily.com": "서울경제", "mt.co.kr": "머니투데이", "asiae.co.kr": "아시아경제",
        "edaily.co.kr": "이데일리", "etnews.com": "전자신문", "biz.chosun.com": "조선비즈", "fnnews.com": "파이낸셜뉴스",
        "heraldcorp.com": "헤럴드경제", "knn.co.kr": "KNN", "busan.com": "부산일보", "knnews.co.kr": "경남신문",
        "gnnews.co.kr": "경남일보", "imaeil.com": "매일신문", "yeongnam.com": "영남일보",
    }
    for dom, name in mapping.items():
        if dom in host:
            return name
    return host


def _tier(source_name: str) -> int:
    return 2 if source_name in TIER2_PRESS else 3


def fetch_article_body(url: str, max_chars: int = 6000) -> str:
    try:
        r = requests.get(url, headers=UA, timeout=15)
        r.raise_for_status()
    except Exception as e:
        log.debug("body fetch failed %s: %s", url, e)
        return ""
    soup = BeautifulSoup(r.text, "html.parser")
    for t in soup(["script", "style", "nav", "header", "footer", "aside"]):
        t.decompose()
    # 네이버 뉴스 본문 / 일반 article / 폴백 body
    node = soup.select_one("#dic_area, #newsct_article, article, .article_body, #articleBody, .news_body") or soup.body
    text = node.get_text("\n", strip=True) if node else ""
    return re.sub(r"\n{2,}", "\n", text)[:max_chars]


def fetch(since: date, keywords: list[str] | None = None, with_body: bool = True) -> list[dict]:
    seen, docs = set(), []
    for kw in keywords or NEWS_KEYWORDS:
        try:
            items = search(kw, NAVER_MAX_PER_KEYWORD)
        except Exception as e:
            log.warning("naver search failed for %r: %s", kw, e)
            continue
        for it in items:
            link = it.get("originallink") or it.get("link")
            if not link or link in seen:
                continue
            try:
                pub = parsedate_to_datetime(it["pubDate"])
            except Exception:
                pub = datetime.now()
            if pub.date() < since:
                continue
            seen.add(link)
            src = _source_name(it.get("link", ""), it.get("originallink", ""))
            docs.append(
                {
                    "source_type": "naver_news",
                    "source_name": src,
                    "source_tier": _tier(src),
                    "url": link,
                    "title": _clean(it.get("title")),
                    "body": (fetch_article_body(link) if with_body else "") or _clean(it.get("description")),
                    "published_at": pub,
                    "meta": {"keyword": kw, "naver_link": it.get("link"), "description": _clean(it.get("description"))},
                }
            )
    log.info("naver_news: %d articles since %s", len(docs), since)
    return docs


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from datetime import timedelta
    for d in fetch(date.today() - timedelta(days=3), keywords=NEWS_KEYWORDS[:2], with_body=False):
        print(d["published_at"].date(), d["source_name"], d["title"])
