import "./report.css";
import { EVENT_LABEL, STAGE_LABEL, fmtKrw, priority, sidoName, estimateUtility } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "투자 레이더 주간 보고" };

async function load(days) {
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = await import("pg");
  globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
  const p = globalThis.__radarPool;
  const num = (r) => ({ ...r, amount_krw: r.amount_krw == null ? null : Number(r.amount_krw) });
  const permits = await p.query(`select id, plat_plc, bld_nm, main_purps, arch_gb, tot_area::float as tot_area, pms_day, stcns_sched_day, real_stcns_day, use_apr_day
                                   from permits where tot_area >= 10000 and use_apr_day is null and pms_day >= to_char(now() - interval '365 days', 'YYYYMMDD')
                                   order by pms_day desc limit 25`).then((r) => r.rows).catch(() => []);
  const [all, fresh, docs] = await Promise.all([
    p.query(`select * from v_signals_map where size_class <> 'S' order by relevance_score desc, amount_krw desc nulls last`),
    p.query(`select * from v_signals_map where first_seen_at > now() - ($1 || ' days')::interval and size_class <> 'S' order by relevance_score desc`, [String(days)]),
    p.query(`select count(*)::int as n, count(*) filter (where fetched_at > now() - ($1 || ' days')::interval)::int as recent from raw_documents`, [String(days)]),
  ]);
  return { all: all.rows.map(num), fresh: fresh.rows.map(num), docs: docs.rows[0], permits };
}

const fmtDate = (d) => { const x = new Date(d); return `${x.getFullYear()}.${String(x.getMonth() + 1).padStart(2, "0")}.${String(x.getDate()).padStart(2, "0")}`; };
const g = (s) => s.effective_grade ?? s.grade;
const fmtDay8 = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : "–");
const shortPlc = (s) => (s ?? "").replace(/^(서울|부산|대구|인천|광주|대전|울산|세종)(특별|광역)?(자치)?시\s|^(경기|강원|충청북|충청남|전라북|전라남|경상북|경상남|제주|전북|강원)(특별자치)?도\s/, "");

export default async function Report({ searchParams }) {
  const sp = await searchParams;
  const days = Number(sp?.days ?? 7);
  const data = await load(days);
  const today = new Date();
  if (!data) return <main className="rpt-page"><h1>보고서</h1><p>DB 연결이 없어 보고서를 만들 수 없습니다.</p></main>;

  const { all, fresh, docs, permits } = data;
  const hot = all.filter((s) => priority(s.relevance_score) === "hot");
  const early = hot.filter((s) => ["disclosure", "mou", "permit"].includes(s.stage));
  const bySido = {};
  for (const s of all) { const k = s.sido ?? "미상"; (bySido[k] ??= { n: 0, hot: 0, amt: 0 }); bySido[k].n++; if (priority(s.relevance_score) === "hot") bySido[k].hot++; bySido[k].amt += s.amount_krw ?? 0; }
  const sidoRows = Object.entries(bySido).sort((a, b) => b[1].n - a[1].n);
  const byStage = Object.fromEntries(Object.keys(STAGE_LABEL).map((k) => [k, all.filter((s) => s.stage === k).length]));
  const totalAmt = all.reduce((a, s) => a + (s.amount_krw ?? 0), 0);
  const cust = all.filter((s) => s.customer_name);

  return (
    <main className="rpt-page">
      <header className="rpt-head">
        <div>
          <div className="rpt-kicker">GENEQ 에너지시스템사업부 · 투자 레이더</div>
          <h1>국내 공장 투자 신호 주간 보고</h1>
          <div className="rpt-meta">{fmtDate(new Date(today - days * 86400e3))} ~ {fmtDate(today)} · 최근 {days}일 · 작성 {fmtDate(today)}</div>
        </div>
        <div className="rpt-actions"><a href="/">대시보드</a><a href={`/report?days=${days === 7 ? 30 : 7}`}>{days === 7 ? "최근 30일로" : "최근 7일로"}</a><span className="print-hint">Ctrl+P 로 PDF 저장</span></div>
      </header>

      <section className="rpt-lead">
        <p>
          최근 {days}일 동안 문서 <b>{docs.recent.toLocaleString()}</b>건(누적 {docs.n.toLocaleString()})을 읽어 <b>{fresh.length}</b>건의 투자 건을 새로 포착했습니다.
          현재 추적 중인 건은 <b>{all.length}</b>건, 공개된 투자금액 합계 <b>{fmtKrw(totalAmt)}</b>이며, 그중 즉시 검토 대상이 <b className="hot">{hot.length}</b>건입니다.
          공시·협약·인허가 단계라 설비 발주 전인 건은 <b>{early.length}</b>건으로, 이번 주 접촉 우선순위입니다.
          {cust.length > 0 && <> 이 중 <b className="cust">{cust.length}</b>건은 드라이어 납품 이력이 있는 <b className="cust">기존 거래처</b>({cust.slice(0, 5).map((s) => s.customer_name).join(", ")}{cust.length > 5 ? " 등" : ""})의 투자입니다.</>}
        </p>
      </section>

      <section>
        <h2>이번 주 접촉 추천 <small>즉시 검토 + 발주 전 단계</small></h2>
        <table className="rpt-table">
          <thead><tr><th>#</th><th>회사</th><th>지역</th><th>무엇을</th><th>단계</th><th>투자금액</th><th>우리 설비 수요</th><th>예상 압축기</th><th>등급</th></tr></thead>
          <tbody>
            {early.slice(0, 12).map((s, i) => { const e = estimateUtility(s); return (
              <tr key={s.id}>
                <td>{i + 1}</td>
                <td><b>{s.company_name}</b>{s.customer_name ? <span className="cust-tag">고객</span> : null}{s.company_group ? <small> {s.company_group}</small> : null}</td>
                <td>{sidoName(s.sido)} {s.sigungu ?? ""}</td>
                <td>{EVENT_LABEL[s.event_type]}<br /><small>{s.sector ?? ""}{s.process_hint ? ` · ${s.process_hint}` : ""}</small></td>
                <td>{STAGE_LABEL[s.stage]}<br /><small>{s.period_start ?? "?"}→{s.period_end ?? "?"}</small></td>
                <td className="num">{fmtKrw(s.amount_krw)}</td>
                <td className="need">압 {"●".repeat(s.need_compressed_air)}{"○".repeat(3 - s.need_compressed_air)}<br />건 {"●".repeat(s.need_dryer)}{"○".repeat(3 - s.need_dryer)}<br />제 {"●".repeat(s.need_hmi)}{"○".repeat(3 - s.need_hmi)}</td>
                <td><small>{e.air}<br />{e.dryer}</small></td>
                <td className="grade">{g(s)}</td>
              </tr>); })}
          </tbody>
        </table>
        {early.length === 0 && <p className="muted">해당 없음</p>}
      </section>

      <section className="rpt-two">
        <div>
          <h2>지역별 현황</h2>
          <table className="rpt-table compact">
            <thead><tr><th>시도</th><th>건수</th><th>즉시검토</th><th>투자금액</th></tr></thead>
            <tbody>{sidoRows.map(([k, v]) => <tr key={k}><td>{sidoName(k)}</td><td className="num">{v.n}</td><td className="num hot">{v.hot || ""}</td><td className="num">{v.amt ? fmtKrw(v.amt) : "–"}</td></tr>)}</tbody>
          </table>
        </div>
        <div>
          <h2>단계별 분포</h2>
          <div className="stage-chart">
            {Object.entries(byStage).map(([k, n]) => (
              <div key={k} className="stage-row"><span className="stage-l">{STAGE_LABEL[k]}</span><span className="stage-bar"><span style={{ width: `${(n / Math.max(1, all.length)) * 100}%` }} /></span><span className="stage-n">{n}</span></div>
            ))}
          </div>
          <p className="muted small">공시·협약·인허가 = 설비 발주 전(골든타임). 착공 = 유틸리티 발주 임박. 준공 = 교체·증설 수요.</p>
        </div>
      </section>

      <section>
        <h2>새로 포착된 건 <small>최근 {days}일</small></h2>
        {fresh.length === 0 ? <p className="muted">없음</p> : (
          <ul className="rpt-list">
            {fresh.map((s) => (
              <li key={s.id}>
                <span className={`pri ${priority(s.relevance_score)}`}>{s.relevance_score}</span>
                <div>
                  <b>{s.company_name}</b>{s.customer_name ? <span className="cust-tag">고객</span> : null} · {sidoName(s.sido)} {s.sigungu ?? ""} · {EVENT_LABEL[s.event_type]} · {STAGE_LABEL[s.stage]} · {fmtKrw(s.amount_krw)} · 등급 {g(s)} · 출처 {s.source_count}건
                  <div className="rpt-summary">{s.summary}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {permits.length > 0 && (
        <section>
          <h2>건축허가로 잡힌 대형 공장 공사 <small>레이더 신호 주변 법정동 · 최근 1년 · 연면적 1만㎡ 이상 · 미준공</small></h2>
          <table className="rpt-table compact">
            <thead><tr><th>허가일</th><th>구분</th><th>건물명(회사)</th><th>대지위치</th><th>연면적</th><th>착공</th></tr></thead>
            <tbody>
              {permits.map((pm) => (
                <tr key={pm.id}>
                  <td className="num">{fmtDay8(pm.pms_day)}</td>
                  <td>{pm.arch_gb ?? ""} {pm.main_purps ?? ""}</td>
                  <td><b>{pm.bld_nm ?? "–"}</b></td>
                  <td>{shortPlc(pm.plat_plc)}</td>
                  <td className="num">{Math.round(pm.tot_area).toLocaleString()}㎡</td>
                  <td className="num">{pm.real_stcns_day ? <span className="hot">{fmtDay8(pm.real_stcns_day)}</span> : pm.stcns_sched_day ? `예정 ${fmtDay8(pm.stcns_sched_day)}` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">건축HUB(국토교통부) 인허가 원장. 뉴스에 안 나와도 허가가 났으면 실제 공사 — 건물명에 회사가 보이면 레이더에 없어도 접촉 대상. 전국이 아니라 레이더 신호가 있는 동네만 조회한 결과.</p>
        </section>
      )}

      <section>
        <h2>전체 추적 목록 <small>{all.length}건 · 관련도순</small></h2>
        <table className="rpt-table compact">
          <thead><tr><th>점수</th><th>회사</th><th>지역</th><th>유형</th><th>단계</th><th>금액</th><th>등급</th><th>출처</th></tr></thead>
          <tbody>
            {all.map((s) => (
              <tr key={s.id}>
                <td className={`num pri-${priority(s.relevance_score)}`}>{s.relevance_score}</td>
                <td>{s.company_name}{s.customer_name ? <span className="cust-tag">고객</span> : null}</td><td>{sidoName(s.sido)} {s.sigungu ?? ""}</td><td>{EVENT_LABEL[s.event_type]}</td><td>{STAGE_LABEL[s.stage]}</td>
                <td className="num">{fmtKrw(s.amount_krw)}</td><td className="grade">{g(s)}</td><td className="num">{s.source_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="rpt-foot">
        <p>읽는 법 — 점수: 업종·공정·단계로 산정한 압축기·드라이어·HMI 수요 관련도(70+ 즉시 검토, 40~69 모니터링). 등급: A 공식 출처(공시·정부 발표), B 서로 다른 주요 언론 2곳 이상 또는 매체 4곳 이상 보도, C 그 외. 예상 압축기 용량은 업종·규모 기반 추정치로 현장 확인 전 참고용입니다.</p>
        <p>출처: DART 전자공시, 산업통상부·정책브리핑, 구글·Bing 뉴스, 지방지 RSS, 한국산업단지공단 등록공장현황, 국토교통부 건축HUB 건축인허가. 자동 수집 후 담당자 검수.</p>
      </footer>
    </main>
  );
}
