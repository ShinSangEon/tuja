"""파이프라인 — 두 단계로 나뉜다. 가운데 '추출'은 Claude 세션에서 수동으로.

  python run.py collect --since 2026-10-01      # 수집 → (DB 있으면 raw_documents 적재) → out/pending.md + pending.jsonl
  python run.py collect --sources news          # 소스 그룹: dart | news(구글·Bing) | paper(지방지) | gov(산업부·정책브리핑) | press(전부)
        ... Claude 가 out/pending.md 를 읽고 out/extracted.json 작성 ...
  python run.py ingest out/extracted.json       # 검증·병합·지오코딩 → DB (DB 없으면 out/signals.json)

  python run.py rebuild                         # 규칙 수정 후 extractions 전체 재병합 (signals 초기화)
  python run.py companies                       # 타겟 상장사 회사 카드(DART 재무·종업원·생산설비) 갱신
  python run.py permits                         # 타겟 시군구 최근 공장 건축인허가 (DATA_GO_KR_KEY 필요)
  python run.py export web/public/sample-signals.json   # DB → JSON (대시보드 샘플/백업)
  python run.py load-complexes 산단.csv         # 산단 마스터 (name, sido, sigungu, lat, lng)
  python run.py load-factories 등록공장.csv     # 전국 등록공장 현황 CSV (공공데이터포털 15105482, cp949)
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

import companies
import customers
import db
import extract
import factories
import geocode
import permits
import validate
from config import DATABASE_URL
from sources import dart, naver_news, press

log = logging.getLogger("run")
SOURCES = {"dart": dart.fetch, "naver_news": naver_news.fetch, "press": press.fetch,
           "news": lambda since: press.fetch(since, "news"), "paper": lambda since: press.fetch(since, "paper"), "gov": lambda since: press.fetch(since, "gov")}
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
            new = db.upsert_documents(c, docs)
            log.info("new documents in DB: %d", new)
            for d in db.pending_documents(c):
                d["id"] = str(d["id"])
                rc = (d.get("meta") or {}).get("rcept_no")
                if d.get("source_type") == "dart" and rc and len(d.get("body") or "") < 300:
                    try:  # 웹 실시간 검색으로 추가된 공시 — 본문 보강
                        d["body"] = dart._focus(dart.fetch_document_text(rc))
                        c.execute("update raw_documents set body = %s where id = %s", (d["body"], d["id"]))
                    except Exception as e:  # noqa: BLE001
                        log.warning("dart body fill failed %s: %s", rc, e)
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


def geocode_with_factories(c, s: dict, complexes, regions, cache) -> dict:
    """같은 회사의 등록공장이 같은 산단/시군구에 있으면 그 좌표(precision=factory), 아니면 기존 폴백."""
    try:
        f = factories.match_for_signal(c, s)
    except Exception:  # factories 테이블이 아직 없을 때
        f = None
    if f:
        factories.ensure_geocoded(c, [f], geocode.geocode_address, cache)
        if f.get("lat"):
            s = dict(s); s["lat"], s["lng"] = f["lat"], f["lng"]; s["geocode_status"] = "factory"
            if not s.get("address_raw"):
                s["address_raw"] = f["address"]
            s["location_precision"] = "address"
            return s
    return geocode.geocode_signal(s, complexes, regions, cache)


# ── 2단계: ingest ───────────────────────────────────────
def cmd_ingest(a):
    results = extract.load_extracted(Path(a.file))
    by_id = {r["doc_id"]: r for r in results}

    if DATABASE_URL and not a.no_db:
        with db.conn() as c:
            docs = {str(d["id"]): d for d in db.pending_documents(c, limit=5000)}
            aliases = db.load_aliases(c)
            cust = customers.Matcher(c)
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
                if s.get("_id") and s.get("lat") and s.get("_orig_source_count") == len(s["_sources"]):
                    continue  # 출처 추가 없음 → 변화 없음
                if not s.get("lat") or s.get("geocode_status") in (None, "pending", "unlocated", "fallback_region", "fallback_complex"):
                    s = geocode_with_factories(c, s, complexes, regions, cache)
                s["customer_name"] = cust.match(s.get("company_norm"), s.get("company_group"))
                db.upsert_signal(c, s)
                n_new += 0 if s.get("_id") else 1
                n_upd += 1 if s.get("_id") else 0
            log.info("factory pins geocoded: %d", geocode_target_factories(c, cache))
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


def geocode_target_factories(c, cache: dict) -> int:
    """신호에 연결된 회사들의 등록공장 좌표 채우기 (지도 연한 핀용). 회사당 몇 건이라 호출 적음."""
    n = 0
    try:
        for sig in c.execute("select company_norm, corp_code from signals where not archived").fetchall():
            corp_name = None
            if sig["corp_code"]:
                r = c.execute("select corp_name from corp_codes where corp_code = %s", (sig["corp_code"],)).fetchone()
                corp_name = r["corp_name"] if r else None
            rows = [r for r in factories.for_company(c, sig["company_norm"], corp_name) if not r.get("lat") and r.get("geocode_status") != "fail2"][:12]
            factories.ensure_geocoded(c, rows, geocode.geocode_address, cache)
            n += len(rows)
    except Exception as e:  # noqa: BLE001
        log.warning("factory geocode skipped: %s", e)
    return n


# ── rebuild: 추출 결과 전체를 다시 병합 (규칙·버그 수정 후) ──
def cmd_rebuild(a):
    """signals 를 비우고 extractions 전체로 다시 만든다. 수동 입력(owner, manual_grade 등)은 사라진다."""
    with db.conn() as c:
        aliases = db.load_aliases(c)
        cust = customers.Matcher(c)
        cands = []
        for payload, d in db.load_all_relevant_extractions(c):
            cand = validate.candidate_from_extraction(payload, d, aliases)
            if cand:
                cands.append(cand)
        merged = validate.consolidate(cands)
        complexes, regions, cache = db.load_complexes(c), db.load_regions(c), db.load_geocode_cache(c)
        known = set(cache)
        snap = db.snapshot_manual(c)
        db.wipe_signals(c)
        for s in merged:
            if not s.get("corp_code"):
                r = c.execute("select corp_code from corp_codes where name_norm = %s", (s["company_norm"],)).fetchone()
                if r:
                    s["corp_code"] = r["corp_code"]
            s["customer_name"] = cust.match(s.get("company_norm"), s.get("company_group"))
            db.upsert_signal(c, geocode_with_factories(c, s, complexes, regions, cache))
        log.info("factory pins geocoded: %d", geocode_target_factories(c, cache))
        db.save_geocode_cache(c, cache, known)
        log.info("manual fields/activities restored: %d/%d", db.restore_manual(c, snap), len(snap))
        log.info("rebuild: %d extractions → %d candidates → %d signals", len(cands), len(cands), len(merged))


# ── 회사 카드 ─────────────────────────────────────────
def cmd_companies(a):
    """signals 에 연결된 상장사의 DART 프로필(기본정보·재무 3년·종업원·사업보고서 생산설비 섹션)을 companies 에 적재."""
    with db.conn() as c:
        codes = [a.corp_code] if a.corp_code else companies.targets(c, a.max_age)
        log.info("companies: %d to refresh", len(codes))
        for i, code in enumerate(codes, 1):
            try:
                row = companies.build(code)
                companies.upsert(c, row)
                c.commit()
                log.info("[%d/%d] %s %s emp=%s fin=%s facility=%d자", i, len(codes), code, row.get("corp_name"), row.get("employees"), row.get("fin_year"), len(row.get("facility_text") or ""))
            except Exception as e:  # noqa: BLE001
                log.warning("company %s failed: %s", code, e)


def cmd_permits(a):
    """건축HUB 공장 인허가 수집 (DATA_GO_KR_KEY 필요)."""
    with db.conn() as c:
        log.info("permits saved: %d", permits.refresh_for_signals(c, a.days))


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


def cmd_load_factories(a):
    with db.conn() as c:
        factories.load_csv(c, a.file)


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


def cmd_refresh_corpcodes(a):
    """DART corpCode.xml (30MB, 다운로드 3분+) → corp_codes 테이블. --csv 로 미리 만든 CSV 를 넣을 수도 있다."""
    if getattr(a, "csv", None):
        rows = [{"corp_code": r["corp_code"], "corp_name": r["corp_name"], "stock_code": r["stock_code"]} for r in csv.DictReader(open(a.csv, encoding="utf-8"))]
    else:
        rows = dart.download_corp_codes()
    listed = [(validate.normalize_company(r["corp_name"]), r["corp_name"], r["corp_code"], r["stock_code"]) for r in rows if r["stock_code"]]
    log.info("corp codes: %d total, %d listed", len(rows), len(listed))
    with db.conn() as c:
        c.execute("""create table if not exists corp_codes (corp_code text primary key, corp_name text not null, name_norm text not null, stock_code text);
                     create index if not exists corp_codes_norm_idx on corp_codes (name_norm)""")
        c.execute("delete from corp_codes")
        with c.cursor().copy("copy corp_codes (name_norm, corp_name, corp_code, stock_code) from stdin") as cp:
            for row in listed:
                cp.write_row(row)
        c.execute("""insert into company_aliases (alias_norm, canonical_norm, corp_code)
                     select name_norm, name_norm, corp_code from corp_codes on conflict (alias_norm) do nothing""")
    log.info("corp_codes table: %d rows", len(listed))


def cmd_purge_bodies(_a):
    with db.conn() as c:
        log.info("purged %d bodies", db.purge_bodies(c))


def cmd_load_customers(_a):
    """collector/customers.yaml → customers 테이블. 이후 rebuild 로 signals.customer_name 반영."""
    import customers
    with db.conn() as c:
        log.info("customers loaded: %d", customers.load_yaml(c))


def cmd_alias(a):
    """사명 별칭 등록: 이전 추출에서 '사명 미확인' 으로 잡힌 건을 실제 사명으로 합칠 때.
    예) python run.py alias 제천투자협약기업 바이오파마코리아  → rebuild 하면 두 건이 하나로 병합된다."""
    src, dst = validate.normalize_company(a.alias), validate.normalize_company(a.canonical)
    with db.conn() as c:
        c.execute("""insert into company_aliases (alias_norm, canonical_norm) values (%s, %s)
                     on conflict (alias_norm) do update set canonical_norm = excluded.canonical_norm""", (src, dst))
        log.info("alias %s → %s (rebuild 필요)", src, dst)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("collect"); p.add_argument("--since", default=(date.today() - timedelta(days=3)).isoformat())
    p.add_argument("--sources", default="dart,press"); p.add_argument("--no-db", action="store_true"); p.set_defaults(fn=cmd_collect)
    p = sub.add_parser("ingest"); p.add_argument("file"); p.add_argument("--no-db", action="store_true"); p.set_defaults(fn=cmd_ingest)
    p = sub.add_parser("rebuild"); p.set_defaults(fn=cmd_rebuild)
    p = sub.add_parser("permits"); p.add_argument("--days", type=int, default=120); p.set_defaults(fn=cmd_permits)
    p = sub.add_parser("companies"); p.add_argument("--corp-code"); p.add_argument("--max-age", type=int, default=30); p.set_defaults(fn=cmd_companies)
    p = sub.add_parser("export"); p.add_argument("file"); p.set_defaults(fn=cmd_export)
    p = sub.add_parser("status"); p.set_defaults(fn=cmd_status)
    p = sub.add_parser("load-complexes"); p.add_argument("file"); p.set_defaults(fn=cmd_load_complexes)
    p = sub.add_parser("load-factories"); p.add_argument("file"); p.set_defaults(fn=cmd_load_factories)
    p = sub.add_parser("refresh-corpcodes"); p.add_argument("--csv"); p.set_defaults(fn=cmd_refresh_corpcodes)
    p = sub.add_parser("purge-bodies"); p.set_defaults(fn=cmd_purge_bodies)
    p = sub.add_parser("alias"); p.add_argument("alias"); p.add_argument("canonical"); p.set_defaults(fn=cmd_alias)
    p = sub.add_parser("load-customers"); p.set_defaults(fn=cmd_load_customers)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if not DATABASE_URL and a.cmd in ("collect", "ingest"):
        log.warning("DATABASE_URL 없음 → out/ 파일 모드")
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
