"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import FilterBar, { DEFAULT_FILTERS } from "@/components/FilterBar";
import { SignalDetail, SignalList } from "@/components/SignalPanel";
import LookupPanel from "@/components/LookupPanel";
import { fmtDate, priority } from "@/lib/format";

const KakaoMap = dynamic(() => import("@/components/KakaoMap"), { ssr: false });

export default function Page() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lookup, setLookup] = useState(null); // 실시간 검색어
  const [factories, setFactories] = useState([]); // 선택한 회사의 기존 공장 (지도 연한 핀)

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.grades.length) p.set("grade", filters.grades.join(","));
    if (filters.sizes.length) p.set("size", filters.sizes.join(","));
    if (filters.stages.length) p.set("stage", filters.stages.join(","));
    if (filters.sidos.length) p.set("sido", filters.sidos.join(","));
    if (filters.minScore) p.set("minScore", String(filters.minScore));
    if (filters.q) p.set("q", filters.q);
    return p.toString();
  }, [filters]);

  useEffect(() => {
    setLookup(null);
    const ctl = new AbortController();
    setLoading(true);
    fetch(`/api/signals?${query}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
    return () => ctl.abort();
  }, [query]);

  const signals = data?.signals ?? [];
  const hot = signals.filter((s) => priority(s.relevance_score) === "hot").length;
  const bigSum = signals.reduce((a, s) => a + (s.amount_krw ?? 0), 0);
  const focus = selected?.lat != null ? { lat: selected.lat, lng: selected.lng } : null;

  return (
    <div className="radar">
      <header className="top">
        <div className="brand">
          <span className="brand-name">GENEQ 투자 레이더</span>
          <span className="brand-sub">국내 공장 신설·증설·개조 신호 → ES사업부 영업 타겟</span>
        </div>
        <p className="brief">
          조건에 맞는 <b>{data?.count ?? 0}</b>건 중 즉시 검토 <b className="hot">{hot}</b>건,
          투자 합계 <b>{bigSum ? `${Math.round(bigSum / 1e8).toLocaleString()}억` : "–"}</b>
          <a className="brief-link" href="/report">주간 보고 보기</a>
          <span className="brief-meta">
            {data?.source === "sample" ? "샘플 데이터" : data?.updated_at ? `마지막 업데이트 ${fmtDate(data.updated_at)}` : ""}
            {loading ? " · 불러오는 중" : ""}
          </span>
        </p>
      </header>

      <div className="body">
        <FilterBar value={filters} onChange={(f) => { setFilters(f); setSelected(null); }} bySido={data?.bySido ?? {}} unlocated={data?.unlocated ?? 0} />
        <main className="map">
          <KakaoMap signals={signals} selectedId={selected?.id ?? null} onSelect={setSelected} focus={focus} factories={selected ? factories : []} />
        </main>
        <section className="side">
          {selected
            ? <SignalDetail s={selected} onClose={() => setSelected(null)} onFactories={setFactories} />
            : lookup
              ? <><button className="back side-back" onClick={() => setLookup(null)}>← 목록</button><LookupPanel q={lookup} inDb={signals.length > 0} /></>
              : <>
                  {filters.q.length >= 2 && !loading && (
                    <div className="lookup-cta">
                      {signals.length === 0
                        ? <><b>‘{filters.q}’</b> 은(는) 레이더에 없습니다.</>
                        : <>레이더 안 결과 {signals.length}건.</>}
                      <button className="link" onClick={() => setLookup(filters.q.trim())}>구글뉴스·DART에서 바로 찾기</button>
                    </div>
                  )}
                  <SignalList signals={signals} selectedId={null} onSelect={setSelected} />
                </>}
        </section>
      </div>
    </div>
  );
}
