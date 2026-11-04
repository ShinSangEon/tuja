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
    "grade", "confidence", "source_count", "customer_name",
]

# 기존 DB 에 새 컬럼·테이블을 더하는 마이그레이션 (멱등). 뷰는 s.* 를 쓰므로 컬럼이 늘면 다시 만들어야 한다.
MIGRATE_SQL = """
alter table signals add column if not exists bjdong_cd text;
alter table signals add column if not exists customer_name text;
create table if not exists customers (
  name text primary key, name_norm text not null, aliases text[] not null default '{}',
  sites text, note text, updated_at timestamptz not null default now());
"""
VIEW_COLS_REQUIRED = ("customer_name", "customer_sites", "bjdong_cd")


SCHEMA_SQL = Path(__file__).parent.parent / "db" / "schema.sql"


def ensure_schema(c) -> bool:
    """signals 테이블이 없으면 db/schema.sql 을 실행해 테이블·뷰를 만든다. (첫 접속 때 1회)"""
    exists = c.execute("select to_regclass('public.signals') as t").fetchone()["t"]
    if exists:
        c.execute(MIGRATE_SQL)
        have = {r["column_name"] for r in c.execute("select column_name from information_schema.columns where table_name = 'v_signals_map'")}
        if not all(k in have for k in VIEW_COLS_REQUIRED):
            sql = SCHEMA_SQL.read_text(encoding="utf-8")
            view = sql[sql.index("create or replace view v_signals_map"):]
            view = view[: view.index(";") + 1]
            c.execute("drop view if exists v_signals_map")
            c.execute(view)
            logging.getLogger("db").info("v_signals_map 뷰 재생성")
        c.commit()
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


def upsert_documents(c, docs: list[dict]) -> int:
    """일괄 적재. 반환: 새로 들어간 수."""
    if not docs:
        return 0
    before = c.execute("select count(*) from raw_documents").fetchone()["count"]
    with c.cursor() as cur:
        cur.executemany(
            """insert into raw_documents (source_type, source_name, source_tier, url, title, body, published_at, meta)
               values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict (url) do nothing""",
            [(d["source_type"], d.get("source_name"), d.get("source_tier", 3), d["url"], d.get("title"), d.get("body"), d.get("published_at"), Jsonb(d.get("meta") or {})) for d in docs],
        )
    return c.execute("select count(*) from raw_documents").fetchone()["count"] - before


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
        r["_orig_source_count"] = len(r["_sources"])
    return rows


def load_all_relevant_extractions(c) -> list[tuple[dict, dict]]:
    """rebuild 용: (payload, document) 쌍 전부."""
    rows = c.execute("""select e.payload, d.* from extractions e join raw_documents d on d.id = e.document_id
                        where e.is_relevant and e.payload is not null""").fetchall()
    out = []
    for r in rows:
        payload = r.pop("payload"); r["id"] = str(r["id"]); out.append((payload, r))
    return out


MANUAL_COLS = ("owner", "contact_status", "network_note", "manual_grade", "bjdong_cd")


def snapshot_manual(c) -> list[dict]:
    """rebuild 전에 사람이 입력한 것(담당·상태·메모·수동등급)과 영업 활동 기록을 회사·지역 키로 떠둔다."""
    sigs = c.execute(f"""select id, company_norm, sido, sigungu, event_type, {', '.join(MANUAL_COLS)} from signals
                         where owner is not null or coalesce(contact_status,'none') <> 'none' or network_note is not null
                            or manual_grade is not null or bjdong_cd is not null""").fetchall()
    acts = c.execute("select signal_id, actor, kind, content, created_at from signal_activities").fetchall()
    by_sig: dict = {}
    for a in acts:
        by_sig.setdefault(str(a["signal_id"]), []).append(a)
    out = []
    for s in sigs:
        out.append({**s, "activities": by_sig.get(str(s["id"]), [])})
    # 활동만 있고 수동 필드는 없는 신호
    have = {str(s["id"]) for s in sigs}
    for sid, lst in by_sig.items():
        if sid not in have:
            r = c.execute("select id, company_norm, sido, sigungu, event_type from signals where id = %s", (sid,)).fetchone()
            if r:
                out.append({**r, **{k: None for k in MANUAL_COLS}, "activities": lst})
    return out


def restore_manual(c, snap: list[dict]) -> int:
    """회사(정규화)+시도 가 같은 새 신호에 되돌려 넣는다. 못 찾으면 회사만 같은 신호(유일할 때)."""
    n = 0
    for s in snap:
        rows = c.execute("select id from signals where company_norm = %s and coalesce(sido,'') = coalesce(%s,'')", (s["company_norm"], s["sido"])).fetchall()
        if len(rows) != 1:
            rows = c.execute("select id from signals where company_norm = %s", (s["company_norm"],)).fetchall()
        if len(rows) != 1:
            continue
        sid = rows[0]["id"]
        sets = {k: s.get(k) for k in MANUAL_COLS if s.get(k) not in (None, "none")}
        if sets:
            c.execute(f"update signals set {', '.join(f'{k} = %({k})s' for k in sets)} where id = %(id)s", {**sets, "id": sid})
        for a in s["activities"]:
            c.execute("insert into signal_activities (signal_id, actor, kind, content, created_at) values (%s,%s,%s,%s,%s)",
                      (sid, a["actor"], a["kind"], a["content"], a["created_at"]))
        n += 1
    return n


def wipe_signals(c):
    c.execute("delete from signal_activities"); c.execute("delete from signal_sources"); c.execute("delete from signals")


def upsert_signal(c, sig: dict) -> str:
    vals = {k: sig.get(k) for k in SIGNAL_COLS}
    if sig.get("_id"):
        old = c.execute("select stage, amount_krw, effective_grade from v_signals_map where id = %s", (sig["_id"],)).fetchone()
        sets = ", ".join(f"{k} = %({k})s" for k in SIGNAL_COLS)
        c.execute(f"update signals set {sets}, last_seen_at = now() where id = %(id)s", {**vals, "id": sig["_id"]})
        sid = sig["_id"]
        if old:  # 단계·금액·등급이 바뀌면 '시스템' 활동으로 남긴다 (주간 보고 '지난주 대비 변화')
            from config import STAGE_ORDER  # noqa: PLC0415
            labels = {"disclosure": "공시", "mou": "투자협약", "permit": "인허가", "construction": "착공", "completed": "준공"}
            msgs = []
            if old["stage"] != vals.get("stage") and vals.get("stage") in STAGE_ORDER:
                msgs.append(f"단계 {labels.get(old['stage'], old['stage'])} → {labels.get(vals['stage'], vals['stage'])}")
            oa, na = old.get("amount_krw"), vals.get("amount_krw")
            if na and (not oa or int(oa) != int(na)):
                msgs.append(f"금액 {int(oa) // 100000000 if oa else '미공개'}억 → {int(na) // 100000000}억")
            if old.get("effective_grade") != vals.get("grade") and vals.get("grade"):
                msgs.append(f"등급 {old.get('effective_grade')} → {vals['grade']}")
            if msgs:
                c.execute("insert into signal_activities (signal_id, actor, kind, content) values (%s, '시스템', 'system', %s)", (sid, " · ".join(msgs)))
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
