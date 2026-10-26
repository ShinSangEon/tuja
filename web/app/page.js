"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import FilterBar, { DEFAULT_FILTERS } from "@/components/FilterBar";
import { SignalDetail, SignalList } from "@/components/SignalPanel";

const KakaoMap = dynamic(() => import("@/components/KakaoMap"), { ssr: false });

export default function Page() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);

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
    const ctl = new AbortController();
    setLoading(true);
    fetch(`/api/signals?${query}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
    return () => ctl.abort();
  }, [query]);

  const signals = data?.signals ?? [];
  const stats = useMemo(() => {
    const by = (k) => signals.reduce((m, s) => { const v = String(s[k] ?? "?"); m[v] = (m[v] ?? 0) + 1; return m; }, {});
    return { size: by("size_class"), grade: by("grade"), hot: signals.filter((s) => s.relevance_score >= 70).length };
  }, [signals]);

  return (
    <div className="radar">
      <header className="top">
        <div className="brand">GENEQ 투자 레이더 <span className="muted">ES사업부 영업 타겟</span></div>
        <div className="stats">
          <span>표시 <b>{data?.count ?? 0}</b> / 전체 {data?.total ?? 0}</span>
          <span>🔴 즉시검토 <b>{stats.hot}</b></span>
          <span>L {stats.size.L ?? 0} · M {stats.size.M ?? 0} · S {stats.size.S ?? 0} · 미상 {stats.size.U ?? 0}</span>
          <span>A {stats.grade.A ?? 0} · B {stats.grade.B ?? 0} · C {stats.grade.C ?? 0}</span>
          {data?.source === "sample" && <span className="tag warn">샘플 데이터</span>}
          {loading && <span className="muted">…</span>}
        </div>
      </header>

      <div className="body">
        <FilterBar value={filters} onChange={(f) => { setFilters(f); setSelected(null); }} />
        <main className="map">
          <KakaoMap signals={signals} selectedId={selected?.id ?? null} onSelect={setSelected} />
        </main>
        <section className="side">
          {selected ? <SignalDetail s={selected} onClose={() => setSelected(null)} /> : <SignalList signals={signals} selectedId={null} onSelect={setSelected} />}
        </section>
      </div>
    </div>
  );
}
