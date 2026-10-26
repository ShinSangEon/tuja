"""지자체·중앙부처 보도자료 수집 (tier 1).

sources.yaml 에 소스를 등록한다. 두 가지 방식:
  - type: rss  → RSS/Atom 피드 (가장 안정적. 지자체 다수가 제공)
  - type: html → 목록 페이지 + CSS 선택자 (RSS 없을 때)
키워드(include) 중 하나가 제목에 있어야 수집한다.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urljoin

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


def _body(url: str, selector: str | None, max_chars: int = 6000) -> str:
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


def _from_rss(src: dict, since: date) -> list[dict]:
    feed = feedparser.parse(src["url"])
    out = []
    for e in feed.entries:
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
        if src.get("aggregator"):  # 구글 뉴스 RSS: 실제 매체명으로 등급 매기고, 본문은 피드 요약만 (링크가 JS 리다이렉트)
            name = (getattr(e, "source", None) or {}).get("title") or name
            title = re.sub(r"\s*-\s*[^-]+$", "", title)  # 제목 끝 " - 매체명" 제거
            tier = 2 if name in TIER2_PRESS else 3
            body = re.sub(r"<[^>]+>", " ", e.get("summary") or "")
        out.append(
            {
                "source_type": "press" if not src.get("aggregator") else "naver_news",
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
    r = requests.get(src["url"], headers=UA, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    for row in soup.select(src["item_selector"]):
        a = row.select_one(src.get("link_selector", "a"))
        if not a or not a.get("href"):
            continue
        title = a.get_text(" ", strip=True)
        if not _matches(title, src.get("include", DEFAULT_INCLUDE)):
            continue
        link = urljoin(src["url"], a["href"])
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
                "source_name": src["name"],
                "source_tier": src.get("tier", 1),
                "url": link,
                "title": title,
                "body": _body(link, src.get("body_selector")),
                "published_at": pub,
                "meta": {"source_key": src.get("key")},
            }
        )
    return out


def fetch(since: date) -> list[dict]:
    docs = []
    for src in load_sources():
        try:
            got = _from_rss(src, since) if src.get("type") == "rss" else _from_html(src, since)
            log.info("press[%s]: %d", src["name"], len(got))
            docs.extend(got)
        except Exception as e:
            log.warning("press[%s] failed: %s", src.get("name"), e)
    return docs
