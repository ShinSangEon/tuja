"""보도자료·뉴스 수집 (sources.yaml).

  - type: rss  → RSS/Atom 피드. aggregator: google | bing 이면 뉴스 검색 피드로 취급(매체명을 피드에서 뽑아 tier 매김)
  - type: html → 목록 페이지 + CSS 선택자
구글뉴스 링크는 리다이렉트라 본문을 못 가져오므로, 제목으로 Bing 에서 원문 URL 을 찾아 본문을 채운다(resolve_via_bing).
Bing 뉴스 RSS 는 원문 URL 을 그대로 준다.
키워드(include) 중 하나가 제목에 있어야 수집한다.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, quote, urljoin, urlparse

import feedparser
import requests
import yaml
from bs4 import BeautifulSoup

from config import TIER2_PRESS

log = logging.getLogger(__name__)
UA = {"User-Agent": "Mozilla/5.0 (compatible; GENEQ-InvestRadar/0.1)"}
DEFAULT_INCLUDE = ["투자협약", "투자 협약", "증설", "신설", "공장", "착공", "준공", "입주", "MOU", "투자유치"]


def load_sources(path: str | Path = Path(__file__).parent.parent / "sources.yaml") -> list[dict]:
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return [s for s in data.get("sources", []) if s.get("enabled", True)]


def _matches(title: str, include: list[str]) -> bool:
    return any(k.lower() in title.lower() for k in include)


# 정부·공공 도메인은 직접 접속 금지 (2026-11-06 회사 공인 IP 가 정부 사이트에서 차단된 사고 이후).
# 보도자료는 구글·Bing 뉴스 RSS 의 제목·요약으로만 받는다.
NO_FETCH_HOSTS = (".go.kr", ".or.kr", "korea.kr")


def is_gov_host(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return any(host.endswith(s) or host == s.lstrip(".") for s in NO_FETCH_HOSTS)


def _body(url: str, selector: str | None, max_chars: int = 6000) -> str:
    if is_gov_host(url):
        return ""
    try:
        r = requests.get(url, headers=UA, timeout=15)
        r.raise_for_status()
    except Exception as e:
        log.debug("press body failed %s: %s", url, e)
        return ""
    soup = BeautifulSoup(r.text, "html.parser")
    for t in soup(["script", "style", "nav", "header", "footer"]):
        t.decompose()
    node = (soup.select_one(selector) if selector else None) or soup.select_one("article, .board_view, .bbs_content, .content") or soup.body
    text = node.get_text("\n", strip=True) if node else ""
    return re.sub(r"\n{2,}", "\n", text)[:max_chars]


_bing_cache: dict[str, str | None] = {}


def _bing_rss(query: str, timeout: int = 15):
    u = f"https://www.bing.com/news/search?q={quote(query)}&format=rss&setlang=ko&cc=KR&mkt=ko-KR"
    r = requests.get(u, headers=UA, timeout=timeout)
    r.raise_for_status()
    return feedparser.parse(r.content).entries


def _unwrap_bing(link: str) -> str:
    if "bing.com/news/apiclick" in link:
        return parse_qs(urlparse(link).query).get("url", [link])[0]
    return link


def _title_key(t: str) -> str:
    return re.sub(r"[^가-힣a-z0-9]", "", (t or "").lower())[:40]


def resolve_via_bing(title: str) -> str | None:
    """구글뉴스 제목 → Bing 뉴스 검색 → 같은 제목의 원문 URL. 실패 시 None."""
    key = _title_key(title)
    if key in _bing_cache:
        return _bing_cache[key]
    url = None
    try:
        hits = [_unwrap_bing(e.link) for e in _bing_rss(title[:80]) if _title_key(e.get("title", ""))[:25] == key[:25]]
        hits.sort(key=lambda u: "msn.com" in u)  # MSN 미러는 본문이 JS 라 원문 우선
        url = hits[0] if hits else None
    except Exception as ex:  # noqa: BLE001
        log.debug("bing resolve failed %r: %s", title[:30], ex)
    _bing_cache[key] = url
    return url


def _from_rss(src: dict, since: date) -> list[dict]:
    if src.get("aggregator") == "bing":
        entries = _bing_rss(src["query"]) if src.get("query") else feedparser.parse(requests.get(src["url"], headers=UA, timeout=15).content).entries
    else:
        entries = feedparser.parse(src["url"]).entries
    out = []
    for e in entries:
        title = (e.get("title") or "").strip()
        if not _matches(title, src.get("include", DEFAULT_INCLUDE)):
            continue
        pub = None
        if e.get("published_parsed"):
            pub = datetime(*e.published_parsed[:6])
        if pub and pub.date() < since:
            continue
        link = e.get("link")
        if not link:
            continue
        name, tier, body = src["name"], src.get("tier", 1), None
        agg = src.get("aggregator")
        if agg == "bing":  # Bing 뉴스 RSS: 원문 URL 그대로. 매체명은 도메인으로
            link = _unwrap_bing(link)
            host = urlparse(link).netloc.replace("www.", "")
            name = next((n for n in TIER2_PRESS if n.lower() in host.lower()), None) or _host_name(host)
            title = re.sub(r"\s*-\s*[^-]+$", "", title) if " - " in title else title
            tier = 2 if name in TIER2_PRESS else 3
            body = None  # 아래에서 원문 fetch
        elif agg:  # 구글 뉴스 RSS: 매체명은 피드에서. 본문은 나중에 Bing 으로 원문 찾아 채움 (fill_bodies)
            name = (getattr(e, "source", None) or {}).get("title") or name
            title = re.sub(r"\s*-\s*[^-]+$", "", title)  # 제목 끝 " - 매체명" 제거
            src_url = (getattr(e, "source", None) or {}).get("href") or ""
            if src.get("tier") == 1 or is_gov_host(src_url) or "정책브리핑" in name:
                tier, name = 1, (name if "정책브리핑" in name or name.endswith("부") else name)
            else:
                tier = 2 if name in TIER2_PRESS else 3
            body = re.sub(r"<[^>]+>", " ", e.get("summary") or "")
        out.append(
            {
                "source_type": "press" if not agg else "naver_news",
                "source_name": name,
                "source_tier": tier,
                "url": link,
                "title": title,
                "body": body if body is not None else (_body(link, src.get("body_selector")) or (e.get("summary") or "")),
                "published_at": pub,
                "meta": {"source_key": src.get("key")},
            }
        )
    return out


def _from_html(src: dict, since: date) -> list[dict]:
    r = requests.get(src["url"], headers=UA, timeout=10)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    for row in soup.select(src["item_selector"]):
        a = row.select_one(src.get("link_selector", "a"))
        if not a or not a.get("href"):
            continue
        title = a.get_text(" ", strip=True).split(" ... ")[0].strip()  # korea.kr: 제목 ... 본문요약 형식
        if not _matches(title, src.get("include", DEFAULT_INCLUDE)):
            continue
        link = urljoin(src["url"], a["href"])
        name = src["name"]
        if src.get("key", "").startswith("gov_koreakr"):  # 행 끝 "2026-11-03 산업통상부" → 부처명을 매체명으로
            m_org = re.search(r"\d{4}-\d{2}-\d{2}\s+(\S+)\s*$", row.get_text(" ", strip=True))
            if m_org:
                name = m_org.group(1)
        pub = None
        if src.get("date_selector"):
            d = row.select_one(src["date_selector"])
            if d:
                m = re.search(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", d.get_text())
                if m:
                    pub = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if pub and pub.date() < since:
            continue
        out.append(
            {
                "source_type": "press",
                "source_name": name,
                "source_tier": src.get("tier", 1),
                "url": link,
                "title": title,
                "body": _body(link, src.get("body_selector")),
                "published_at": pub,
                "meta": {"source_key": src.get("key")},
            }
        )
    return out


_HOST_NAMES = {"yna.co.kr": "연합뉴스", "newsis.com": "뉴시스", "news1.kr": "뉴스1", "hankyung.com": "한국경제", "mk.co.kr": "매일경제",
    "sedaily.com": "서울경제", "mt.co.kr": "머니투데이", "asiae.co.kr": "아시아경제", "edaily.co.kr": "이데일리", "etnews.com": "전자신문",
    "biz.chosun.com": "조선비즈", "fnnews.com": "파이낸셜뉴스", "heraldcorp.com": "헤럴드경제", "ajunews.com": "아주경제", "newspim.com": "뉴스핌",
    "busan.com": "부산일보", "kookje.co.kr": "국제신문", "knnews.co.kr": "경남신문", "idomin.com": "경남도민일보", "gnnews.co.kr": "경남일보",
    "imaeil.com": "매일신문", "yeongnam.com": "영남일보", "kyongbuk.co.kr": "경북일보", "ksilbo.co.kr": "경상일보", "msn.com": "MSN"}


def _host_name(host: str) -> str:
    for dom, n in _HOST_NAMES.items():
        if dom in host:
            return n
    return host


def fill_bodies(docs: list[dict], max_resolve: int = 120, workers: int = 8) -> None:
    """구글뉴스 문서: Bing 으로 원문 URL 찾아 url 교체 + 본문 채움. Bing 문서: 본문만."""
    todo = [d for d in docs if d["source_type"] == "naver_news" and (not d.get("body") or len(d["body"]) < 300)]
    goog = [d for d in todo if "news.google.com" in d["url"]][:max_resolve]
    direct = [d for d in todo if "news.google.com" not in d["url"]]

    def _g(d):
        u = resolve_via_bing(d["title"])
        if u:
            d["meta"]["google_url"] = d["url"]; d["url"] = u
            d["body"] = (d.get("body") or "") if is_gov_host(u) else (_body(u, None) or d.get("body") or "")
            d["meta"]["body_from"] = "bing-resolved" + ("-nofetch" if is_gov_host(u) else "")

    def _d(d):
        d["body"] = _body(d["url"], None) or d.get("body") or ""

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(_g, goog)); list(ex.map(_d, direct))
    ok = sum(1 for d in goog if d["meta"].get("body_from"))
    log.info("fill_bodies: google %d/%d resolved, direct %d fetched", ok, len(goog), len(direct))


def fetch(since: date, group: str | None = None) -> list[dict]:
    """group: 'news'(구글·Bing) | 'paper'(지방지 RSS) | 'gov'(산업부·정책브리핑 HTML) | None(전부)"""
    docs, seen = [], set()
    srcs = []
    for src in load_sources():
        if src.get("key", "").startswith("gov_") and not src.get("aggregator"):
            continue  # 정부 사이트 직접 수집은 영구 비활성 (IP 차단 사고)
        kind = "gov" if src.get("key", "").startswith("gov_") else ("news" if src.get("aggregator") else "paper")
        if not group or kind == group:
            srcs.append(src)

    def _one(src):
        try:
            got = _from_rss(src, since) if src.get("type") == "rss" else _from_html(src, since)
            log.info("press[%s]: %d", src.get("key", src["name"]), len(got))
            return got
        except Exception as e:  # noqa: BLE001
            log.warning("press[%s] failed: %s", src.get("key"), str(e)[:120])
            return []

    with ThreadPoolExecutor(8) as ex:  # 피드 86개를 순차로 받으면 1분 넘게 걸린다
        for got in ex.map(_one, srcs):
            for d in got:
                if d["url"] not in seen:
                    seen.add(d["url"]); docs.append(d)
    fill_bodies(docs)
    # 원문 URL 로 바뀐 뒤 중복 제거 (구글·Bing 에서 같은 기사)
    out, seen2 = [], set()
    for d in docs:
        if d["url"] in seen2:
            continue
        seen2.add(d["url"]); out.append(d)
    return out
