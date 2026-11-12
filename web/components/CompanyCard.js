"use client";

import { useEffect, useState } from "react";
import { fmtKrw } from "@/lib/format";

/** 억 단위 짧게: 2조 9,387억 → "2.9조", 328억 → "328억", 음수 → "-12억" */
function eok(v) {
  if (v == null) return "–";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v) / 1e8;
  if (a >= 10000) return `${sign}${(a / 10000).toFixed(1).replace(/\.0$/, "")}조`;
  return `${sign}${Math.round(a).toLocaleString()}억`;
}

function Trend({ rows, k, label }) {
  const vals = rows.map((r) => r[k] ?? null);
  const max = Math.max(1, ...vals.map((v) => Math.abs(v ?? 0)));
  return (
    <div className="trend">
      <div className="trend-l">{label}</div>
      <div className="trend-bars">
        {rows.map((r, i) => (
          <div key={r.year} className="trend-col" title={`${r.year}: ${eok(vals[i])}`}>
            <div className={`trend-bar ${vals[i] < 0 ? "neg" : ""}`} style={{ height: `${Math.max(3, (Math.abs(vals[i] ?? 0) / max) * 100)}%` }} />
            <div className="trend-y">{String(r.year).slice(2)}</div>
          </div>
        ))}
      </div>
      <div className="trend-v">{eok(vals[vals.length - 1])}</div>
    </div>
  );
}

/** 사업보고서 섹션 원문 — 셀 단위 줄바꿈 텍스트를 읽기 좋게: 가./나./(1) 헤더 강조, 숫자만 있는 줄은 한 줄로 모음 */
function ReportText({ text }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  let buf = [];
  const flush = () => { if (buf.length) { out.push({ t: "row", v: buf.join(" · ") }); buf = []; } };
  for (const l of lines) {
    if (/^(가|나|다|라|마|바|사|아)\.\s|^\(\d\)|^\d\.\s|^[①-⑩]/.test(l)) { flush(); out.push({ t: "h", v: l }); }
    else if (l.length <= 18) buf.push(l);
    else { flush(); out.push({ t: "p", v: l }); }
  }
  flush();
  return (
    <div className="rpt">
      {out.map((x, i) => x.t === "h" ? <h4 key={i}>{x.v}</h4> : x.t === "row" ? <div key={i} className="rpt-row">{x.v}</div> : <p key={i}>{x.v}</p>)}
    </div>
  );
}

export default function CompanyCard({ corpCode, currentSignalId }) {
  const [c, setC] = useState(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!corpCode) return;
    setC(undefined); setOpen(false);
    fetch(`/api/company?corp_code=${corpCode}`).then((r) => (r.ok ? r.json() : null)).then(setC).catch(() => setC(null));
  }, [corpCode]);

  if (!corpCode) return null;
  if (c === undefined) return <section className="detail-sec"><h3>회사 카드</h3><p className="lookup-note">불러오는 중…</p></section>;
  if (!c) return <section className="detail-sec"><h3>회사 카드</h3><p className="lookup-note">아직 수집 전입니다. 다음 업데이트 때 DART에서 채워집니다.</p></section>;

  const fin = c.financials ?? [];
  const last = fin[fin.length - 1] ?? {};
  const margin = last.revenue && last.op_income != null ? ((last.op_income / last.revenue) * 100).toFixed(1) : null;
  const others = (c.signals ?? []).filter((s) => s.id !== currentSignalId);

  return (
    <section className="detail-sec company">
      <h3>회사 카드 <small>DART {c.report_name ?? ""}</small></h3>
      <div className="co-grid">
        <div><span className="co-k">대표</span>{c.ceo ?? "–"}</div>
        <div><span className="co-k">설립</span>{c.established ? c.established.slice(0, 4) : "–"}년</div>
        <div><span className="co-k">종업원</span>{c.employees ? `${c.employees.toLocaleString()}명` : "–"}</div>
        <div><span className="co-k">영업이익률</span>{margin != null ? `${margin}%` : "–"}</div>
      </div>
      <div className="co-addr">{c.address ?? ""}{c.homepage ? <> · <a href={c.homepage.startsWith("http") ? c.homepage : `https://${c.homepage}`} target="_blank" rel="noreferrer">{c.homepage.replace(/^https?:\/\//, "")}</a></> : null}</div>

      {fin.length > 0 && (
        <div className="trends">
          <Trend rows={fin} k="revenue" label="매출" />
          <Trend rows={fin} k="op_income" label="영업이익" />
          <Trend rows={fin} k="assets" label="자산" />
        </div>
      )}

      {others.length > 0 && (
        <div className="co-others">
          <span className="co-k">같은 회사 다른 건</span>
          {others.map((s) => <span key={s.id} className="co-chip">{s.sido ? s.sido.slice(0, 2) : "?"} {s.sigungu ?? ""} · {fmtKrw(s.amount_krw)}</span>)}
        </div>
      )}

      {c.facility_summary && <p className="co-sum">{c.facility_summary}</p>}

      {c.facility_text && (
        <div className="co-rpt">
          <button className="link" onClick={() => setOpen((o) => !o)}>{open ? "생산설비 현황 접기" : "사업보고서 「생산설비 현황」 펼치기"} ({Math.round(c.facility_text.length / 100) / 10}천자)</button>
          {open && <ReportText text={c.facility_text} />}
          {c.report_rcept_no && <a className="co-link" href={`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${c.report_rcept_no}`} target="_blank" rel="noreferrer">DART 원문 열기</a>}
        </div>
      )}
    </section>
  );
}
