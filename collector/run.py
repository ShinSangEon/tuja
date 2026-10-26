"""파이프라인 — 두 단계로 나뉜다. 가운데 '추출'은 Claude 세션에서 수동으로.

  python run.py collect --since 2026-10-01      # 수집 → (DB 있으면 raw_documents 적재) → out/pending.md + pending.jsonl
        ... Claude 가 out/pending.md 를 읽고 out/extracted.json 작성 ...
  python run.py ingest out/extracted.json       # 검증·병합·지오코딩 → DB (DB 없으면 out/signals.json)

  python run.py export web/public/sample-signals.json   # DB → JSON (대시보드 샘플/백업)
  python run.py load-complexes 산단.csv         # 산단 마스터 (name, sido, sigungu, lat, lng)
  python run.py refresh-corpcodes               # DART 고유번호 → company_aliases
  python run.py purge-bodies                    # 90일 지난 기사 본문 비우기
  python run.py status                          # DB 요약 (등급·규모·지오코딩 분포)
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import db
import extract
import geocode
import validate
from config import DATABASE_URL
from sources import dart, naver_news, press

log = logging.getLogger("run")
SOURCES = {"dart": dart.fetch, "naver_news": naver_news.fetch, "press": press.fetch}
OUT = Path(__file__).parent / "out"


def collect(since: date, names: list[str]) -> list[dict]:
    docs = []
    for n in names:
        try:
            got = SOURCES[n](since)
            log.info("collected %s: %d", n, len(got))
            docs.extend(got)
        except Exception as e:  # noqa: BLE001
            log.error("source %s failed: %s", n, e)
    return docs


# ── 1단계: collect ──────────────────────────────────────
def cmd_collect(a):
    since = datetime.fromisoformat(a.since).date()
    docs = collect(since, [s.strip() for s in a.sources.split(",") if s.strip()])
    pending = []
    if DATABASE_URL and not a.no_db:
        with db.conn() as c:
            new = sum(1 for d in docs if db.upsert_document(c, d))
            log.info("new documents in DB: %d", new)
            for d in db.pending_documents(c):
                d["id"] = str(d["id"])
                ok = extract.prefilter(d.get("title") or "", d.get("body") or "", d.get("source_type", ""))
                if ok:
                    pending.append(d)
                else:
                    db.save_extraction(c, d["id"], {"skipped": "prefilter"})
    else:
        seen = set()
        for i, d in enumerate(docs):
            if d["url"] in seen:
                continue
            seen.add(d["url"])
            d["id"] = f"doc-{since:%Y%m%d}-{i:04d}"
            if extract.prefilter(d.get("title") or "", d.get("body") or "", d.get("source_type", "")):
                pending.append(d)
        (OUT / "pending_docs.json").parent.mkdir(parents=True, exist_ok=True)
        (OUT / "pending_docs.json").write_text(json.dumps(pending, ensure_ascii=False, default=str), encoding="utf-8")
    md, jl = extract.write_pending(pending, OUT)
    log.info("collect: %d docs → %d pending → %s", len(docs), len(pending), md)
    print(f"\n다음 단계: Claude 에게 '{md}' 를 읽고 '{OUT / 'extracted.json'}' 을 작성하게 한 뒤\n  python run.py ingest {OUT / 'extracted.json'}")


# ── 2단계: ingest ───────────────────────────────────────
def cmd_ingest(a):
    results = extract.load_extracted(Path(a.file))
    by_id = {r["doc_id"]: r for r in results}

    if DATABASE_URL and not a.no_db:
        with db.conn() as c:
            docs = {str(d["id"]): d for d in db.pending_documents(c, limit=5000)}
            aliases = db.load_aliases(c)
            cands = []
            for doc_id, r in by_id.items():
                d = docs.get(doc_id)
                if not d:
                    log.warning("doc %s not pending in DB (이미 처리됐거나 id 오타)", doc_id)
                    continue
                d["id"] = doc_id
                db.save_extraction(c, doc_id, r)
                if r.get("is_relevant"):
                    cand = validate.candidate_from_extraction(r, d, aliases)
                    if cand:
                        cands.append(cand)
            existing = db.load_existing_signals(c)
            merged = validate.consolidate(cands, existing)
            complexes, regions, cache = db.load_complexes(c), db.load_regions(c), db.load_geocode_cache(c)
            known = set(cache)
            n_new = n_upd = 0
            for s in merged:
                if s.get("_id") and s.get("lat") and s.get("source_count") == len(s["_sources"]):
                    continue
                if not s.get("lat") or s.get("geocode_status") in (None, "pending", "unlocated"):
                    s = geocode.geocode_signal(s, complexes, regions, cache)
                db.upsert_signal(c, s)
                n_new += 0 if s.get("_id") else 1
                n_upd += 1 if s.get("_id") else 0
            db.save_geocode_cache(c, cache, known)
            log.info("ingest: %d results → %d candidates → %d new, %d updated | stale %d, archived %d",
                     len(results), len(cands), n_new, n_upd, db.mark_stale(c), db.archive_completed(c))
    else:
        docs = {d["id"]: d for d in json.loads((OUT / "pending_docs.json").read_text(encoding="utf-8"))}
        cands = []
        for doc_id, r in by_id.items():
            d = docs.get(doc_id)
            if d and r.get("is_relevant"):
                if isinstance(d.get("published_at"), str) and d["published_at"]:
                    d["published_at"] = datetime.fromisoformat(d["published_at"])
                cand = validate.candidate_from_extraction(r, d)
                if cand:
                    cands.append(cand)
        prev_path = OUT / "signals.json"
        existing = json.loads(prev_path.read_text(encoding="utf-8")) if prev_path.exists() else []
        for e in existing:
            e["_id"] = e.get("_id") or e.get("id")
            if isinstance(e.get("published_at"), str) and e["published_at"]:
                e["published_at"] = datetime.fromisoformat(e["published_at"])
        cache = {}
        sigs = [geocode.geocode_signal(s, cache=cache) if not s.get("lat") else s for s in validate.consolidate(cands, existing)]
        for i, s in enumerate(sigs):
            s["id"] = s.get("_id") or f"sig-{i:04d}"
            s["sources"] = [{"title": None, "url": x.get("url"), "source": x.get("source_name"), "tier": x.get("tier"), "published_at": None} for x in s["_sources"]]
        prev_path.write_text(json.dumps(sigs, ensure_ascii=False, default=str, indent=1), encoding="utf-8")
        log.info("ingest (file mode): %d results → %d candidates → %d signals → %s", len(results), len(cands), len(sigs), prev_path)


# ── 유틸 ────────────────────────────────────────────────
def cmd_export(a):
    with db.conn() as c:
        Path(a.file).write_text(db.export_json(c), encoding="utf-8")
    log.info("exported → %s", a.file)


def cmd_status(_a):
    with db.conn() as c:
        for q in [
            "select grade, count(*) from signals where not archived group by 1 order by 1",
            "select size_class, count(*) from signals where not archived group by 1 order by 1",
            "select geocode_status, count(*) from signals group by 1 order by 2 desc",
            "select count(*) filter (where not extracted) as pending, count(*) as total from raw_documents",
        ]:
            print(q.split(" from ")[0][7:], "→", [dict(r) for r in c.execute(q)])


def cmd_load_complexes(a):
    with db.conn() as c, open(a.file, encoding="utf-8-sig", newline="") as f:
        n = 0
        for row in csv.DictReader(f):
            name = row.get("name") or row.get("산업단지명") or row.get("단지명")
            if not name:
                continue
            norm = geocode.re.sub(r"\s+|일반산업단지|국가산업단지|산업단지|산단|농공단지", "", name)
            lat, lng = row.get("lat") or row.get("위도"), row.get("lng") or row.get("경도")
            c.execute(
                """insert into industrial_complexes (name, name_norm, sido, sigungu, lat, lng, meta) values (%s,%s,%s,%s,%s,%s,%s)
                   on conflict (name_norm) do update set lat = excluded.lat, lng = excluded.lng""",
                (name, norm, row.get("sido") or row.get("시도"), row.get("sigungu") or row.get("시군구"),
                 float(lat) if lat else None, float(lng) if lng else None, json.dumps(row, ensure_ascii=False)),
            )
            n += 1
        log.info("complexes loaded: %d", n)


def cmd_refresh_corpcodes(_a):
    rows = dart.download_corp_codes()
    with db.conn() as c:
        for r in rows:
            if not r["stock_code"]:
                continue
            norm = validate.normalize_company(r["corp_name"])
            c.execute("insert into company_aliases (alias_norm, canonical_norm, corp_code) values (%s,%s,%s) on conflict (alias_norm) do nothing",
                      (norm, norm, r["corp_code"]))
    log.info("corp codes: %d rows", len(rows))


def cmd_purge_bodies(_a):
    with db.conn() as c:
        log.info("purged %d bodies", db.purge_bodies(c))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("collect"); p.add_argument("--since", default=(date.today() - timedelta(days=3)).isoformat())
    p.add_argument("--sources", default="dart,naver_news,press"); p.add_argument("--no-db", action="store_true"); p.set_defaults(fn=cmd_collect)
    p = sub.add_parser("ingest"); p.add_argument("file"); p.add_argument("--no-db", action="store_true"); p.set_defaults(fn=cmd_ingest)
    p = sub.add_parser("export"); p.add_argument("file"); p.set_defaults(fn=cmd_export)
    p = sub.add_parser("status"); p.set_defaults(fn=cmd_status)
    p = sub.add_parser("load-complexes"); p.add_argument("file"); p.set_defaults(fn=cmd_load_complexes)
    p = sub.add_parser("refresh-corpcodes"); p.set_defaults(fn=cmd_refresh_corpcodes)
    p = sub.add_parser("purge-bodies"); p.set_defaults(fn=cmd_purge_bodies)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if not DATABASE_URL and a.cmd in ("collect", "ingest"):
        log.warning("DATABASE_URL 없음 → out/ 파일 모드")
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
