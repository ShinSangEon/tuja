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
import os
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
GOV_SOURCES = {"dart"}  # 공공기관(.or.kr/.go.kr) 서버에 닿는 소스 — 회사 PC 에서는 실행 금지


def cmd_collect(a):
    since = datetime.fromisoformat(a.since).date()
    sources = [s.strip() for s in a.sources.split(",") if s.strip()]
    if not a.dump and not a.load and os.getenv("ALLOW_GOV_API") != "1" and (set(sources) & GOV_SOURCES):
        log.error("회사 PC 에서 %s 수집 금지 (정부·공공기관 서버 직접 접속). 외부에서 `collect --dump FILE` 로 받아 `load-docs FILE` 로 적재하세요.", sorted(set(sources) & GOV_SOURCES))
        return
    if a.load:
        docs = json.loads(Path(a.load).read_text(encoding="utf-8"))
        for d in docs:
            if d.get("published_at"):
                d["published_at"] = datetime.fromisoformat(d["published_at"])
        log.info("loaded %d docs from %s", len(docs), a.load)
    else:
        docs = collect(since, sources)
    if a.dump:
        Path(a.dump).parent.mkdir(parents=True, exist_ok=True)
        Path(a.dump).write_text(json.dumps(docs, ensure_ascii=False, default=str), encoding="utf-8")
        log.info("dumped %d docs → %s (PC 에서: python run.py collect --load %s --since %s)", len(docs), a.dump, a.dump, a.since)
        return
    pending = []
    if DATABASE_URL and not a.no_db:
        with db.conn() as c:
            extract.set_watchlist(_customer_names(c))
            new = db.upsert_documents(c, docs)
            log.info("new documents in DB: %d", new)
            skipped = []
            for d in db.pending_documents(c, limit=a.limit):
                d["id"] = str(d["id"])
                rc = (d.get("meta") or {}).get("rcept_no")
                if d.get("source_type") == "dart" and rc and len(d.get("body") or "") < 300 and os.getenv("ALLOW_GOV_API") == "1":
                    try:  # 웹 실시간 검색으로 추가된 공시 — 본문 보강
                        d["body"] = dart._focus(dart.fetch_document_text(rc))
                        c.execute("update raw_documents set body = %s where id = %s", (d["body"], d["id"]))
                    except Exception as e:  # noqa: BLE001
                        log.warning("dart body fill failed %s: %s", rc, e)
                ok = extract.prefilter(d.get("title") or "", d.get("body") or "", d.get("source_type", ""))
                if ok:
                    pending.append(d)
                else:
                    skipped.append(d["id"])
            if skipped:  # 사전필터 탈락은 한 번에 기록 (건별 왕복이면 원격 DB 에서 수 분 걸림)
                c.cursor().executemany("insert into extractions (document_id, model, is_relevant) values (%s, 'prefilter', null)", [(i,) for i in skipped])
                c.execute("update raw_documents set extracted = true, prefilter_pass = false where id = any(%s::uuid[])", (skipped,))
    else:
        wl = os.getenv("WATCHLIST_FILE")
        if wl and Path(wl).exists():
            extract.set_watchlist(json.loads(Path(wl).read_text(encoding="utf-8")))
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
            more = [i for i in by_id if i not in docs]
            if more:  # rescan-demand 처럼 이미 처리된 문서를 다시 판독한 경우
                for d in c.execute("select * from raw_documents where id = any(%s::uuid[])", (more,)).fetchall():
                    docs[str(d["id"])] = d
            aliases = db.load_aliases(c)
            cust = customers.Matcher(c)
            cands, to_save = [], []
            for doc_id, r in by_id.items():
                d = docs.get(doc_id)
                if not d:
                    log.warning("doc %s not pending in DB (이미 처리됐거나 id 오타)", doc_id)
                    continue
                d["id"] = doc_id
                to_save.append({**r, "doc_id": doc_id})
                if r.get("is_relevant"):
                    cand = validate.candidate_from_extraction(r, d, aliases)
                    if cand:
                        cands.append(cand)
            db.save_extraction_batch(c, to_save)
            c.commit()  # 판독 결과는 먼저 확정 (이후 단계가 시간 제한에 걸려도 rebuild 로 복구 가능)
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
            import time  # noqa: PLC0415
            db.save_geocode_cache(c, cache, known); known |= set(cache)
            log.info("factory pins geocoded: %d", geocode_target_factories(c, cache, time.time() + float(os.getenv("INGEST_FACTORY_SEC", "8"))))
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


def geocode_target_factories(c, cache: dict, deadline: float | None = None) -> int:
    """신호에 연결된 회사들의 등록공장 좌표 채우기 (지도 연한 핀용). 회사마다 저장하고, 시간 예산을 넘으면 멈춘다(다음 실행이 이어받음)."""
    import time
    n = 0
    try:
        for sig in c.execute("select company_norm, corp_code from signals where not archived order by relevance_score desc").fetchall():
            if deadline and time.time() > deadline:
                log.info("factory pins: 시간 예산 소진 — 나머지는 다음 실행에서")
                break
            corp_name = factories.corp_name_of(c, sig["corp_code"])
            rows = [r for r in factories.for_company(c, sig["company_norm"], corp_name) if not r.get("lat") and r.get("geocode_status") != "fail2"][:12]
            if rows:
                factories.ensure_geocoded(c, rows, geocode.geocode_address, cache)
                c.commit()
            n += len(rows)
    except Exception as e:  # noqa: BLE001
        log.warning("factory geocode skipped: %s", e)
    return n


# ── rebuild: 추출 결과 전체를 다시 병합 (규칙·버그 수정 후) ──
def cmd_rebuild(a):
    """signals 를 비우고 extractions 전체로 다시 만든다. 수동 입력(owner, manual_grade 등)은 스냅샷 후 복원.
    원격 실행 제한(3분)에 걸려도 안전하도록: ① 좌표 계산은 지우기 '전'에 하고 중간중간 저장(중단돼도 다음 실행이 이어받음)
    ② 지우고 다시 넣기는 DB 작업만이라 짧다 ③ 등록공장 핀 좌표는 맨 끝, 시간 예산 안에서만."""
    import time
    deadline = time.time() + float(os.getenv("REBUILD_BUDGET_SEC", "150"))
    with db.conn() as c:
        try:
            permits.link_signals(c, log_activity=False)  # 대형 허가 → 추출 행 생성 (이번 병합에 포함되도록 먼저)
            c.commit()
        except Exception as e:  # noqa: BLE001
            log.warning("permits link (pre) failed: %s", e)
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
        code_by_norm = {r["name_norm"]: r["corp_code"] for r in c.execute("select name_norm, corp_code from corp_codes where name_norm is not null").fetchall()}
        norms = {s["company_norm"] for s in merged}
        for s in merged:
            if not s.get("corp_code") and code_by_norm.get(s["company_norm"]):
                s["corp_code"] = code_by_norm[s["company_norm"]]
            cn = factories.corp_name_of(c, s.get("corp_code"))
            if cn:
                norms.add(validate.normalize_company(cn))
        log.info("factories prefetched: %d", factories.prefetch(c, norms))
        ready = []
        for i, s in enumerate(merged):  # ① 좌표 계산 — 아직 아무것도 지우지 않았으므로 중간 저장해도 안전
            if not s.get("corp_code") and code_by_norm.get(s["company_norm"]):
                s["corp_code"] = code_by_norm[s["company_norm"]]
            s["customer_name"] = cust.match(s.get("company_norm"), s.get("company_group"))
            ready.append(geocode_with_factories(c, s, complexes, regions, cache))
            if i % 15 == 14:
                db.save_geocode_cache(c, cache, known); known |= set(cache); c.commit()
        db.save_geocode_cache(c, cache, known); known |= set(cache); c.commit()
        log.info("geocode done: %d signals (%.0fs left)", len(ready), deadline - time.time())
        snap = db.snapshot_manual(c)
        db.wipe_signals(c)  # ② 지우고 다시 넣기 — 한 트랜잭션, 일괄 전송
        db.insert_signals_bulk(c, ready)
        log.info("manual fields/activities restored: %d/%d", db.restore_manual(c, snap), len(snap))
        try:
            permits.link_signals(c)  # 허가 원장으로 단계 승격
        except Exception as e:  # noqa: BLE001
            log.warning("permits link (post) failed: %s", e)
        c.commit()
        log.info("rebuild: %d extractions → %d candidates → %d signals", len(cands), len(cands), len(merged))
        log.info("factory pins geocoded: %d", geocode_target_factories(c, cache, deadline))  # ③
        db.save_geocode_cache(c, cache, known)


# ── 회사 카드 ─────────────────────────────────────────
def cmd_companies(a):
    """signals 에 연결된 상장사의 DART 프로필(기본정보·재무 3년·종업원·사업보고서 생산설비 섹션)을 companies 에 적재.
    DART 호출은 회사 PC 금지 → (PC) --export-targets 로 코드 목록 → (외부) --build 로 조회·파일 저장 → (PC) --load 로 적재."""
    if a.build:
        codes = json.loads(Path(a.build).read_text(encoding="utf-8"))
        rows = []
        for i, code in enumerate(codes, 1):
            try:
                row = companies.build(code); rows.append(row)
                log.info("[%d/%d] %s %s emp=%s fin=%s facility=%d자", i, len(codes), code, row.get("corp_name"), row.get("employees"), row.get("fin_year"), len(row.get("facility_text") or ""))
            except Exception as e:  # noqa: BLE001
                log.warning("company %s failed: %s", code, e)
        Path(a.out).write_text(json.dumps(rows, ensure_ascii=False, default=str), encoding="utf-8")
        log.info("companies built: %d → %s", len(rows), a.out)
        return
    with db.conn() as c:
        if a.load:
            rows = json.loads(Path(a.load).read_text(encoding="utf-8"))
            for row in rows:
                companies.upsert(c, row)
            log.info("companies loaded: %d", len(rows))
            return
        codes = [a.corp_code] if a.corp_code else companies.targets(c, a.max_age)
        if a.export_targets:
            Path(a.export_targets).write_text(json.dumps(codes, ensure_ascii=False), encoding="utf-8")
            log.info("companies: %d targets → %s", len(codes), a.export_targets)
            return
        if os.getenv("ALLOW_GOV_API") != "1":
            log.error("회사 PC 에서 DART 직접 호출 금지. --export-targets → (외부) --build → --load 순으로.")
            return
        for i, code in enumerate(codes, 1):
            try:
                row = companies.build(code)
                companies.upsert(c, row)
                c.commit()
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
    elif os.getenv("ALLOW_GOV_API") != "1":
        log.error("회사 PC 에서 DART 직접 호출 금지. 외부에서 CSV 를 만들어 --csv 로 넣으세요."); return
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


def cmd_permits_codes(a):
    with db.conn() as c:
        permits.export_codes(c, a.out)


def cmd_permits_fetch(a):
    permits.fetch_to_file(a.codes, a.out, days=a.days)


def cmd_permits_load(a):
    with db.conn() as c:
        permits.load_file(c, a.file)
        permits.resolve_names(c)
        permits.link_signals(c)


def cmd_permits_resolve(_a):
    """이미 적재된 허가 중 회사명 없는 대형 건을 카카오 지번 조회로 확인 (정부 사이트 호출 없음)."""
    with db.conn() as c:
        c.execute(permits.SCHEMA)
        permits.resolve_names(c)
        permits.link_signals(c)


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


def _customer_names(c) -> list[str]:
    names = []
    for r in c.execute("select name, aliases from customers").fetchall():
        names.append(r["name"])
        al = r.get("aliases") or []
        names += [a for a in (al if isinstance(al, list) else []) if a]
    return sorted({n for n in names if n})


def cmd_watchlist(a):
    """(PC) 기존 거래처 이름 → JSON. 외부 서버의 뉴스 수집이 거래처별 소식을 받을 때 쓴다 (저장소에는 올리지 않음)."""
    with db.conn() as c:
        names = _customer_names(c)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(names, ensure_ascii=False), encoding="utf-8")
    log.info("watchlist: %d names → %s (외부 서버: WATCHLIST_FILE=%s python run.py collect --dump ...)", len(names), a.out, a.out)


def cmd_rescan_demand(a):
    """(PC) 지난 기사 중 '교체 가능성' 후보를 다시 골라 판독 대기열로. 이미 투자 건으로 판독된 기사는 빼고,
    사전필터에서 떨어졌거나 '관련 없음'으로 판독된 기사 중 징후 단어 + (거점 지역·거래처)가 있는 것만."""
    with db.conn() as c:
        extract.set_watchlist(_customer_names(c))
        rows = c.execute("""select d.* from raw_documents d
                            where d.fetched_at > now() - make_interval(days => %s)
                              and d.source_type not in ('permit', 'manual')
                              and not exists (select 1 from extractions e where e.document_id = d.id and e.is_relevant)
                            order by d.published_at desc nulls last""", (a.days,)).fetchall()
        pending = []
        for d in rows:
            if extract.demand_hit(d.get("title") or "", d.get("body") or ""):
                d["id"] = str(d["id"]); pending.append(d)
    md, jl = extract.write_pending(pending, OUT, name="pending-demand")
    log.info("rescan-demand: %d docs checked → %d candidates → %s", len(rows), len(pending), md)


def cmd_requests(a):
    """웹 검색창의 '조사 요청' 목록 보기 / 답 달기.
    python run.py requests                       → 아직 답 안 한 요청
    python run.py requests --answer 12 --text "…" → 12번에 답(화면 검색 결과에 표시됨)"""
    with db.conn() as c:
        c.execute("""create table if not exists search_log (
            id bigserial primary key, q text not null, q_norm text, n_results int, requested boolean not null default false,
            note text, requested_by text, status text not null default 'open', answer text, answered_at timestamptz,
            created_at timestamptz not null default now())""")
        if a.answer:
            c.execute("update search_log set answer = %s, status = 'done', answered_at = now() where id = %s", (a.text, a.answer))
            row = c.execute("select q_norm from search_log where id = %s", (a.answer,)).fetchone()
            if row:  # 같은 검색어의 다른 요청도 같은 답으로 닫는다
                c.execute("update search_log set answer = %s, status = 'done', answered_at = now() where q_norm = %s and requested and status = 'open'", (a.text, row["q_norm"]))
            log.info("answered #%s", a.answer)
            return
        rows = c.execute("""select id, q, note, requested_by, created_at from search_log where requested and status = 'open' order by created_at""").fetchall()
        zero = c.execute("""select q_norm, min(q) q, count(*) n, max(created_at) last from search_log
                            where not requested and n_results = 0 and created_at > now() - interval '30 days'
                              and q_norm not in (select q_norm from search_log where requested)
                            group by q_norm order by n desc, last desc limit 40""").fetchall()
    print("== 조사 요청 (답 필요) ==")
    for r in rows:
        print(f"#{r['id']}  {r['q']}  | {r['note'] or ''}  | {r['requested_by'] or ''}  {r['created_at']:%m/%d %H:%M}")
    print("== 결과 0건이었던 검색어 (최근 30일) ==")
    for r in zero:
        print(f"{r['q']}  ×{r['n']}  {r['last']:%m/%d %H:%M}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("collect")
    p.add_argument("--dump", help="(외부 실행) DB 에 넣지 않고 수집 문서를 이 파일로 저장")
    p.add_argument("--load", help="(PC) --dump 로 받은 파일을 읽어 DB 적재·사전필터"); p.add_argument("--since", default=(date.today() - timedelta(days=3)).isoformat())
    p.add_argument("--sources", default="dart,press"); p.add_argument("--no-db", action="store_true")
    p.add_argument("--limit", type=int, default=3000, help="이번에 사전필터할 미처리 문서 수"); p.set_defaults(fn=cmd_collect)
    p = sub.add_parser("ingest"); p.add_argument("file"); p.add_argument("--no-db", action="store_true"); p.set_defaults(fn=cmd_ingest)
    p = sub.add_parser("rebuild"); p.set_defaults(fn=cmd_rebuild)
    p = sub.add_parser("permits"); p.add_argument("--days", type=int, default=120); p.set_defaults(fn=cmd_permits)
    p = sub.add_parser("companies")
    p.add_argument("--export-targets", help="(PC) 갱신 대상 corp_code 목록을 파일로"); p.add_argument("--build", help="(외부) 목록 파일을 읽어 DART 조회 → --out")
    p.add_argument("--out", default="out/companies.json"); p.add_argument("--load", help="(PC) --build 결과 적재"); p.add_argument("--corp-code"); p.add_argument("--max-age", type=int, default=30); p.set_defaults(fn=cmd_companies)
    p = sub.add_parser("export"); p.add_argument("file"); p.set_defaults(fn=cmd_export)
    p = sub.add_parser("status"); p.set_defaults(fn=cmd_status)
    p = sub.add_parser("load-complexes"); p.add_argument("file"); p.set_defaults(fn=cmd_load_complexes)
    p = sub.add_parser("load-factories"); p.add_argument("file"); p.set_defaults(fn=cmd_load_factories)
    p = sub.add_parser("refresh-corpcodes"); p.add_argument("--csv"); p.set_defaults(fn=cmd_refresh_corpcodes)
    p = sub.add_parser("purge-bodies"); p.set_defaults(fn=cmd_purge_bodies)
    p = sub.add_parser("alias"); p.add_argument("alias"); p.add_argument("canonical"); p.set_defaults(fn=cmd_alias)
    p = sub.add_parser("load-customers"); p.set_defaults(fn=cmd_load_customers)
    p = sub.add_parser("permits-codes"); p.add_argument("--out", default="out/bjdong.json"); p.set_defaults(fn=cmd_permits_codes)
    p = sub.add_parser("permits-fetch"); p.add_argument("--codes", default="out/bjdong.json"); p.add_argument("--out", default="out/permits.json"); p.add_argument("--days", type=int, default=365); p.set_defaults(fn=cmd_permits_fetch)
    p = sub.add_parser("permits-load"); p.add_argument("--file", default="out/permits.json"); p.set_defaults(fn=cmd_permits_load)
    p = sub.add_parser("permits-resolve"); p.set_defaults(fn=cmd_permits_resolve)
    p = sub.add_parser("watchlist"); p.add_argument("--out", default="out/watchlist.json"); p.set_defaults(fn=cmd_watchlist)
    p = sub.add_parser("rescan-demand"); p.add_argument("--days", type=int, default=120); p.set_defaults(fn=cmd_rescan_demand)
    p = sub.add_parser("requests"); p.add_argument("--answer", type=int); p.add_argument("--text", default=""); p.set_defaults(fn=cmd_requests)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if not DATABASE_URL and a.cmd in ("collect", "ingest"):
        log.warning("DATABASE_URL 없음 → out/ 파일 모드")
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
