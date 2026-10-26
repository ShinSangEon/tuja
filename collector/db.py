"""PostgreSQL 적재 (psycopg3) — Neon (GENEQ 계정 전용 프로젝트). DATABASE_URL 없으면 run.py 가 파일 모드로 동작한다."""
from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from config import DATABASE_URL

SIGNAL_COLS = [
    "company_name", "company_norm", "corp_code", "company_group", "listed",
    "event_type", "stage", "summary", "purpose",
    "amount_krw", "amount_disclosed", "amount_conflict", "period_start", "period_end", "floor_area_m2", "size_class",
    "sido", "sigungu", "industrial_complex", "address_raw", "location_precision", "lat", "lng", "geocode_status",
    "sector", "process_hint", "need_compressed_air", "need_dryer", "need_hmi", "need_rationale", "relevance_score",
    "grade", "confidence", "source_count",
]


SCHEMA_SQL = Path(__file__).parent.parent / "db" / "schema.sql"


def ensure_schema(c) -> bool:
    """signals 테이블이 없으면 db/schema.sql 을 실행해 테이블·뷰를 만든다. (첫 접속 때 1회)"""
    exists = c.execute("select to_regclass('public.signals') as t").fetchone()["t"]
    if exists:
        return False
    c.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
    c.commit()
    return True


@contextmanager
def conn():
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as c:
        if ensure_schema(c):
            logging.getLogger("db").info("빈 DB → 테이블 자동 생성 완료 (db/schema.sql)")
        yield c
        c.commit()


def upsert_document(c, doc: dict) -> str | None:
    """새 문서면 id 반환, 이미 있으면 None (이미 처리됨)."""
    row = c.execute(
        """insert into raw_documents (source_type, source_name, source_tier, url, title, body, published_at, meta)
           values (%s,%s,%s,%s,%s,%s,%s,%s)
           on conflict (url) do nothing returning id""",
        (doc["source_type"], doc.get("source_name"), doc.get("source_tier", 3), doc["url"], doc.get("title"),
         doc.get("body"), doc.get("published_at"), Jsonb(doc.get("meta") or {})),
    ).fetchone()
    return str(row["id"]) if row else None


def pending_documents(c, limit: int = 500) -> list[dict]:
    return c.execute("select * from raw_documents where not extracted order by published_at desc nulls last limit %s", (limit,)).fetchall()


def save_extraction(c, document_id: str, result: dict, error: str | None = None) -> str:
    payload = None if result.get("skipped") else result
    row = c.execute(
        """insert into extractions (document_id, model, is_relevant, irrelevant_reason, payload, confidence, error)
           values (%s,%s,%s,%s,%s,%s,%s) returning id""",
        (document_id, result.get("_model", "claude-session"), result.get("is_relevant") if not result.get("skipped") else None,
         result.get("irrelevant_reason"), Jsonb(payload) if payload else None,
         result.get("confidence"), error),
    ).fetchone()
    c.execute("update raw_documents set extracted = true, prefilter_pass = %s where id = %s",
              (not bool(result.get("skipped")), document_id))
    return str(row["id"])


def save_extraction_batch(c, results: list[dict]) -> int:
    n = 0
    for r in results:
        save_extraction(c, r["doc_id"], r)
        n += 1
    return n


def load_aliases(c) -> dict[str, str]:
    return {r["alias_norm"]: r["canonical_norm"] for r in c.execute("select alias_norm, canonical_norm from company_aliases")}


def load_complexes(c) -> dict[str, tuple[float, float]]:
    return {r["name_norm"]: (r["lat"], r["lng"]) for r in c.execute("select name_norm, lat, lng from industrial_complexes where lat is not null")}


def load_regions(c) -> dict[tuple, tuple[float, float]]:
    return {(r["sido"], r["sigungu"]): (r["lat"], r["lng"]) for r in c.execute("select sido, sigungu, lat, lng from regions")}


def load_geocode_cache(c) -> dict:
    return {r["query"]: ((r["lat"], r["lng"]) if r["ok"] else None) for r in c.execute("select * from geocode_cache")}


def save_geocode_cache(c, cache: dict, known: set[str]):
    for q, v in cache.items():
        if q in known:
            continue
        c.execute("insert into geocode_cache (query, lat, lng, ok) values (%s,%s,%s,%s) on conflict (query) do nothing",
                  (q, v[0] if v else None, v[1] if v else None, v is not None))


def load_existing_signals(c) -> list[dict]:
    rows = c.execute(
        """select s.*, s.id as _id, s.last_seen_at as published_at,
                  (select json_agg(json_build_object('tier', d.source_tier, 'source_name', d.source_name, 'document_id', d.id, 'url', d.url))
                     from signal_sources ss join raw_documents d on d.id = ss.document_id where ss.signal_id = s.id) as _sources
             from signals s where not s.archived"""
    ).fetchall()
    for r in rows:
        r["_sources"] = r["_sources"] or []
        for s in r["_sources"]:
            s["document_id"] = str(s["document_id"])
        r["_id"] = str(r["_id"])
    return rows


def upsert_signal(c, sig: dict) -> str:
    vals = {k: sig.get(k) for k in SIGNAL_COLS}
    if sig.get("_id"):
        sets = ", ".join(f"{k} = %({k})s" for k in SIGNAL_COLS)
        c.execute(f"update signals set {sets}, last_seen_at = now() where id = %(id)s", {**vals, "id": sig["_id"]})
        sid = sig["_id"]
    else:
        cols = ", ".join(SIGNAL_COLS)
        ph = ", ".join(f"%({k})s" for k in SIGNAL_COLS)
        sid = str(c.execute(f"insert into signals ({cols}) values ({ph}) returning id", vals).fetchone()["id"])
    for s in sig.get("_sources", []):
        if s.get("document_id"):
            c.execute("insert into signal_sources (signal_id, document_id) values (%s,%s) on conflict do nothing", (sid, s["document_id"]))
    return sid


def purge_bodies(c, days: int = 90) -> int:
    return c.execute("update raw_documents set body = null where source_type = 'naver_news' and fetched_at < now() - (%s || ' days')::interval and body is not null", (str(days),)).rowcount


def mark_stale(c) -> int:
    return c.execute("""update signals set stale = true where not archived and stage in ('disclosure','mou')
                        and last_seen_at < now() - interval '18 months' and not stale""").rowcount


def archive_completed(c) -> int:
    return c.execute("""update signals set archived = true where stage = 'completed'
                        and last_seen_at < now() - interval '12 months' and not archived""").rowcount


def export_json(c) -> str:
    rows = c.execute("select * from v_signals_map order by relevance_score desc").fetchall()
    return json.dumps(rows, ensure_ascii=False, default=lambda o: o.isoformat() if isinstance(o, datetime) else str(o), indent=1)
