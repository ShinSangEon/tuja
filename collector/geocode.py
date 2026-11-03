"""지오코딩 — 카카오 로컬 API (주소→좌표) + 산단 마스터 + 시군구 폴백 (R7).

무료 쿼터: 주소변환 일 100,000건. 캐시로 같은 질의는 1회만.
"""
from __future__ import annotations

import logging
import re

import requests

from config import KAKAO_REST_KEY

log = logging.getLogger(__name__)
ADDR_URL = "https://dapi.kakao.com/v2/local/search/address.json"
KW_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"

# 시도 중심점 (폴백 최후 단계). 시군구 중심점은 regions 테이블 또는 seed_regions.json.
SIDO_CENTER = {
    "서울특별시": (37.5665, 126.9780), "부산광역시": (35.1796, 129.0756), "대구광역시": (35.8714, 128.6014),
    "인천광역시": (37.4563, 126.7052), "광주광역시": (35.1595, 126.8526), "대전광역시": (36.3504, 127.3845),
    "울산광역시": (35.5384, 129.3114), "세종특별자치시": (36.4800, 127.2890), "경기도": (37.4138, 127.5183),
    "강원특별자치도": (37.8228, 128.1555), "충청북도": (36.6357, 127.4914), "충청남도": (36.5184, 126.8000),
    "전북특별자치도": (35.7175, 127.1530), "전라남도": (34.8679, 126.9910), "경상북도": (36.4919, 128.8889),
    "경상남도": (35.4606, 128.2132), "제주특별자치도": (33.4996, 126.5312),
}


def _kakao(url: str, query: str) -> tuple[float, float] | None:
    if not KAKAO_REST_KEY:
        return None
    r = requests.get(url, headers={"Authorization": f"KakaoAK {KAKAO_REST_KEY}"}, params={"query": query, "size": 1}, timeout=10)
    if r.status_code != 200:
        log.warning("kakao %s %s: %s", url.rsplit("/", 1)[-1], r.status_code, r.text[:120])
        return None
    docs = r.json().get("documents") or []
    if not docs:
        return None
    return float(docs[0]["y"]), float(docs[0]["x"])


def clean_address(addr: str) -> str:
    """'외 1필지', '(창성동)', '1층', '제101호' 같은 꼬리를 떼면 카카오 매칭률이 오른다."""
    a = re.sub(r"\s*\(.*?\)", "", addr)
    a = re.sub(r"\s*(외|및)\s*\d+\s*필지.*$", "", a)
    a = re.sub(r",.*$", "", a)
    a = re.sub(r"\s+\d+층.*$|\s+제?\d+호.*$|\s+\d+동\s*\d*호?.*$|\s+[A-Z]동\s*\d+호.*$", "", a)
    return re.sub(r"\s+", " ", a).strip()


def geocode_address(addr: str, cache: dict | None = None) -> tuple[float, float] | None:
    key = re.sub(r"\s+", " ", addr).strip()
    if cache is not None and cache.get(key):
        return cache[key]
    k2 = clean_address(key)
    if cache is not None and k2 != key and cache.get(k2):
        return cache[k2]
    res = None if (cache is not None and key in cache) else (_kakao(ADDR_URL, key) or _kakao(KW_URL, key))
    if not res and k2 and k2 != key:
        res = cache[k2] if (cache is not None and k2 in cache) else (_kakao(ADDR_URL, k2) or _kakao(KW_URL, k2))
        if cache is not None:
            cache[k2] = res
    if cache is not None:
        cache[key] = res
    return res


def geocode_complex(name: str, complexes: dict[str, tuple[float, float]] | None, cache: dict | None = None) -> tuple[float, float] | None:
    norm = re.sub(r"\s+|일반산업단지|국가산업단지|산업단지|산단|농공단지", "", name)
    if complexes:
        for k, v in complexes.items():
            if norm and (norm in k or k in norm):
                return v
    # 마스터에 없으면 카카오 키워드 검색으로 한 번
    return geocode_address(name, cache)


def geocode_signal(sig: dict, complexes: dict | None = None, regions: dict | None = None, cache: dict | None = None) -> dict:
    """sig 에 lat/lng/geocode_status 채워서 반환."""
    sig = dict(sig)
    pt, status = None, "unlocated"
    if sig.get("address_raw"):
        pt = geocode_address(sig["address_raw"], cache)
        status = "ok" if pt else status
    if not pt and sig.get("industrial_complex"):
        pt = geocode_complex(sig["industrial_complex"], complexes, cache)
        status = "fallback_complex" if pt else status
    if not pt and sig.get("sido"):
        key = (sig["sido"], sig.get("sigungu"))
        if regions and key in regions:
            pt, status = regions[key], "fallback_region"
        elif sig.get("sigungu"):
            pt = geocode_address(f"{sig['sido']} {sig['sigungu']}", cache)
            status = "fallback_region" if pt else status
        if not pt and sig["sido"] in SIDO_CENTER:
            pt, status = SIDO_CENTER[sig["sido"]], "fallback_region"
    if pt:
        sig["lat"], sig["lng"] = pt
    sig["geocode_status"] = status
    return sig


def sigungu_code(query: str) -> str | None:
    """'경상남도 창원시' → 법정동코드 앞 5자리(시군구 코드). 카카오 주소검색 b_code 사용. 건축HUB 조회용."""
    if not KAKAO_REST_KEY:
        return None
    r = requests.get(ADDR_URL, headers={"Authorization": f"KakaoAK {KAKAO_REST_KEY}"}, params={"query": query, "size": 1}, timeout=10)
    if r.status_code != 200:
        return None
    docs = r.json().get("documents") or []
    b = (docs[0].get("address") or {}).get("b_code") if docs else None
    return b[:5] if b else None
