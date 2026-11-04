import "./report.css";
import { CONTACT_LABEL, EVENT_LABEL, STAGE_LABEL, fmtKrw, priority, sidoName, estimateUtility } from "@/lib/format";
import { nearestSite, orderWindow } from "@/lib/geo";

export const dynamic = "force-dynamic";
export const metadata = { title: "투자 레이더 주간 보고" };

async function load(days) {
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = await import("pg");
  globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
  const p = globalThis.__radarPool;
  const num = (r) => ({ ...r, amount_krw: r.amount_krw == null ? null : Number(r.amount_krw) });
  const q = (sql, args) => p.query(sql, args).then((r) => r.rows).catch(() => []);
  const [all, fresh, docs, permits, inProgress, matchedPermits, systemChanges] = await Promise.all([
    q(`select * from v_signals_map where size_class <> 'S' order by relevance_score desc, amount_krw desc nulls last`),
    q(`select * from v_signals_map where first_seen_at > now() - ($1 || ' days')::interval and size_class <> 'S' order by relevance_score desc`, [String(days)]),
    q(`select count(*)::int as n, count(*) filter (where fetched_at > now() - ($1 || ' days')::interval)::int as recent from raw_documents`, [String(days)]),
    q(`select id, plat_plc, bld_nm, main_purps, arch_gb, tot_area::float as tot_area, pms_day, stcns_sched_day, real_stcns_day, use_apr_day
         from permits where tot_area >= 10000 and use_apr_day is null and pms_day >= to_char(now() - interval '365 days', 'YYYYMMDD')
         order by pms_day desc limit 25`),
    q(`select s.id, s.company_name, s.sido, s.sigungu, s.owner, s.contact_status, s.network_note, s.relevance_score, s.customer_name,
              a.actor, a.kind, a.content, a.created_at
         from signals s left join lateral (select actor, kind, content, created_at from signal_activities where signal_id = s.id order by created_at desc limit 1) a on true
        where not s.archived and (coalesce(s.contact_status,'none') <> 'none' or s.owner is not null)
        order by case s.contact_status when 'quoted' then 0 when 'meeting' then 1 when 'contacted' then 2 when 'planned' then 3 when 'won' then 4 else 5 end, s.relevance_score desc`),
    // 레이더 회사 이름이 건물명에 보이는 허가 = 뉴스가 실제 공사로 확인된 것
    q(`select s.id as signal_id, p.id as permit_id, p.bld_nm, p.arch_gb, p.tot_area::float as tot_area, p.pms_day, p.real_stcns_day, p.stcns_sched_day
         from signals s join permits p on p.sigungu_cd = left(s.bjdong_cd, 5) and p.bjdong_cd = right(s.bjdong_cd, 5)
        where not s.archived and s.bjdong_cd is not null and p.bld_nm is not null
          and length(regexp_replace(s.company_name, '\\(주\\)|㈜|주식회사|\\s|\\(.*\\)', '', 'g')) >= 2
          and regexp_replace(p.bld_nm, '\\s', '', 'g') ilike '%' || regexp_replace(s.company_name, '\\(주\\)|㈜|주식회사|\\s|\\(.*\\)', '', 'g') || '%'`),
    q(`select a.signal_id, s.company_name, a.content, a.created_at from signal_activities a join signals s on s.id = a.signal_id
        where a.kind = 'system' and a.created_at > now() - ($1 || ' days')::interval order by a.created_at desc limit 30`, [String(days)]),
  ]);
  return { all: all.map(num), fresh: fresh.map(num), docs: docs[0] ?? { n: 0, recent: 0 }, permits, inProgress, matchedPermits, systemChanges };
}

const fmtDate = (d) => { const x = new Date(d); return `${x.getFullYear()}.${String(x.getMonth() + 1).padStart(2, "0")}.${String(x.getDate()).padStart(2, "0")}`; };
const g = (s) => s.effective_grade ?? s.grade;
const fmtDay8 = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : "–");
const shortPlc = (s) => (s ?? "").replace(/^(서울|부산|대구|인천|광주|대전|울산|세종)(특별|광역)?(자치)?시\s|^(경기|강원|충청북|충청남|전라북|전라남|경상북|경상남|제주|전북|강원)(특별자치)?도\s/, "");
const core = (name) => (name ?? "").replace(/\(주\)|㈜|주식회사|\s|\(.*\)/g, "");

/** 왜 지금 연락해야 하나 — 보고서에서 가장 중요한 한 칸 */
function reasons(s, permitHit) {
  const r = [];
  if (permitHit) r.push({ k: "permit", t: permitHit.real_stcns_day ? "건축허가·착공 확인" : "건축허가 확인" });
  if (s.customer_name) r.push({ k: "cust", t: "기존 거래처" });
  if (s.stage === "construction") r.push({ k: "hot", t: "착공 — 발주 임박" });
  if (s.stage === "permit") r.push({ k: "hot", t: "인허가 — 발주 전" });
  if (g(s) === "A") r.push({ k: "a", t: "공시로 확정" });
  const w = orderWindow(s.period_end);
  if (w && !w.past) r.push({ k: "win", t: `발주 예상 ${w.label}` });
  if ((s.amount_krw ?? 0) >= 1e11) r.push({ k: "big", t: "1,000억 이상" });
  if (s.need_compressed_air === 3 && s.need_dryer === 3) r.push({ k: "need", t: "클린 CDA·저노점 필수" });
  return r;
}

const Tags = ({ list }) => <span className="tags">{list.map((x) => <span key={x.t} className={`tag ${x.k}`}>{x.t}</span>)}</span>;

export default async function Report({ searchParams }) {
  const sp = await searchParams;
  const days = Number(sp?.days ?? 7);
  const data = await load(days);
  const today = new Date();
  if (!data) return <main className="rpt-page"><h1>보고서</h1><p>DB 연결이 없어 보고서를 만들 수 없습니다.</p></main>;

  const { all, fresh, docs, permits, inProgress, matchedPermits, systemChanges } = data;
  const hitBySignal = {};
  for (const m of matchedPermits) if (!hitBySignal[m.signal_id] || m.real_stcns_day) hitBySignal[m.signal_id] = m;
  const hot = all.filter((s) => priority(s.relevance_score) === "hot");
  const early = hot.filter((s) => ["disclosure", "mou", "permit", "construction"].includes(s.stage));
  const cust = all.filter((s) => s.customer_name);
  const totalAmt = all.reduce((a, s) => a + (s.amount_krw ?? 0), 0);

  // 이번 주 꼭 3건: 이유 수 → 점수 → 금액
  const ranked = early.map((s) => ({ s, r: reasons(s, hitBySignal[s.id]) }))
    .sort((a, b) => (b.r.length - a.r.length) || (b.s.relevance_score - a.s.relevance_score) || ((b.s.amount_krw ?? 0) - (a.s.amount_krw ?? 0)));
  const top3 = ranked.slice(0, 3);
  const rest = ranked.slice(3, 15);

  // 영업 퍼널 (팀이 기록한 상태)
  const funnelKeys = ["planned", "contacted", "meeting", "quoted", "won", "lost"];
  const funnel = Object.fromEntries(funnelKeys.map((k) => [k, inProgress.filter((s) => s.contact_status === k).length]));
  const byOwner = {};
  for (const s of inProgress) if (s.owner) (byOwner[s.owner] ??= { n: 0, active: 0 }), byOwner[s.owner].n++, ["contacted", "meeting", "quoted"].includes(s.contact_status) && byOwner[s.owner].active++;

  const bySido = {};
  for (const s of all) { const k = s.sido ?? "미상"; (bySido[k] ??= { n: 0, hot: 0, amt: 0 }); bySido[k].n++; if (priority(s.relevance_score) === "hot") bySido[k].hot++; bySido[k].amt += s.amount_krw ?? 0; }
  const sidoRows = Object.entries(bySido).sort((a, b) => b[1].n - a[1].n);
  const byStage = Object.fromEntries(Object.keys(STAGE_LABEL).map((k) => [k, all.filter((s) => s.stage === k).length]));
  const bySector = {};
  for (const s of all) { const k = s.sector ?? "기타"; (bySector[k] ??= { n: 0, hot: 0 }); bySector[k].n++; if (priority(s.relevance_score) === "hot") bySector[k].hot++; }
  const sectorRows = Object.entries(bySector).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const near = all.filter((s) => { const n = nearestSite(s.lat, s.lng); return n && n.km <= 60 && priority(s.relevance_score) !== "low"; });
  const radarNames = all.map((s) => core(s.company_name)).filter((x) => x.length >= 2);
  const custNames = cust.map((s) => core(s.customer_name)).filter((x) => x.length >= 2);
  const permitMark = (pm) => { const b = core(pm.bld_nm); if (!b) return null; if (custNames.some((n) => b.includes(n))) return "cust"; if (radarNames.some((n) => b.includes(n))) return "radar"; return null; };

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

      <section className="kpis">
        <div className="kpi"><b>{all.length}</b><span>추적 중인 투자 건</span><small>공개 금액 합계 {fmtKrw(totalAmt)}</small></div>
        <div className="kpi hot"><b>{hot.length}</b><span>즉시 검토 (70점+)</span><small>그중 발주 전·착공 {early.length}건</small></div>
        <div className="kpi"><b>{fresh.length}</b><span>이번 주 새로 포착</span><small>문서 {docs.recent.toLocaleString()}건 읽음 · 누적 {docs.n.toLocaleString()}</small></div>
        <div className="kpi cust"><b>{cust.length}</b><span>기존 거래처의 투자</span><small>{cust.slice(0, 3).map((s) => s.customer_name).join(" · ") || "–"}</small></div>
        <div className="kpi"><b>{near.length}</b><span>거점 60km 이내</span><small>창원·김해·평택 기준 방문 가능</small></div>
      </section>

      <section className="top3">
        <h2>이번 주 꼭 할 3건 <small>즉시 검토 건 중 '지금 연락할 이유'가 가장 많은 순</small></h2>
        {top3.length === 0 ? <p className="muted">해당 없음</p> : (
          <ol className="top3-list">
            {top3.map(({ s, r }) => { const e = estimateUtility(s); const n = nearestSite(s.lat, s.lng); const hit = hitBySignal[s.id]; return (
              <li key={s.id} className={s.customer_name ? "is-cust" : ""}>
                <div className="top3-head">
                  <span className={`pri ${priority(s.relevance_score)}`}>{s.relevance_score}</span>
                  <div>
                    <div className="top3-name">{s.company_name}{s.customer_name ? <span className="cust-tag">고객</span> : null} <small>{sidoName(s.sido)} {s.sigungu ?? ""}{s.industrial_complex ? ` · ${s.industrial_complex}` : ""}{n ? ` · ${n.name} ${n.km}km` : ""}</small></div>
                    <Tags list={r} />
                  </div>
                </div>
                <p className="top3-sum">{s.summary}</p>
                <dl className="top3-kv">
                  <dt>무엇을</dt><dd>{EVENT_LABEL[s.event_type]} · {STAGE_LABEL[s.stage]} · {fmtKrw(s.amount_krw)}{s.period_start || s.period_end ? ` · ${s.period_start ?? "?"}→${s.period_end ?? "?"}` : ""}</dd>
                  <dt>우리 제안</dt><dd>{e.air} · {e.dryer}{e.note ? ` — ${e.note}` : ""}</dd>
                  {hit && <><dt>허가 원장</dt><dd>{hit.bld_nm} · {hit.arch_gb} {Math.round(hit.tot_area).toLocaleString()}㎡ · 허가 {fmtDay8(hit.pms_day)}{hit.real_stcns_day ? ` · 착공 ${fmtDay8(hit.real_stcns_day)}` : hit.stcns_sched_day ? ` · 착공예정 ${fmtDay8(hit.stcns_sched_day)}` : ""}</dd></>}
                  <dt>영업 상태</dt><dd>{s.contact_status && s.contact_status !== "none" ? `${CONTACT_LABEL[s.contact_status]}${s.owner ? ` · 담당 ${s.owner}` : ""}` : <span className="muted">아직 아무도 연락 안 함 — 담당 정하기</span>}</dd>
                </dl>
              </li>); })}
          </ol>
        )}
      </section>

      <section>
        <h2>다음 접촉 후보 <small>즉시 검토 + 발주 전·착공 단계 · 4~15위</small></h2>
        {rest.length === 0 ? <p className="muted">해당 없음</p> : (
          <table className="rpt-table">
            <thead><tr><th>#</th><th>회사</th><th>지역 · 거점</th><th>무엇을</th><th>단계</th><th>투자금액</th><th>왜 지금</th><th>예상 압축기</th><th>등급</th><th>영업</th></tr></thead>
            <tbody>
              {rest.map(({ s, r }, i) => { const e = estimateUtility(s); const n = nearestSite(s.lat, s.lng); return (
                <tr key={s.id} className={s.customer_name ? "is-cust" : ""}>
                  <td>{i + 4}</td>
                  <td><b>{s.company_name}</b>{s.customer_name ? <span className="cust-tag">고객</span> : null}{s.company_group ? <small> {s.company_group}</small> : null}</td>
                  <td>{sidoName(s.sido)} {s.sigungu ?? ""}{n ? <><br /><small>{n.name} {n.km}km</small></> : null}</td>
                  <td>{EVENT_LABEL[s.event_type]}<br /><small>{s.sector ?? ""}{s.process_hint ? ` · ${s.process_hint}` : ""}</small></td>
                  <td>{STAGE_LABEL[s.stage]}<br /><small>{s.period_start ?? "?"}→{s.period_end ?? "?"}</small></td>
                  <td className="num">{fmtKrw(s.amount_krw)}</td>
                  <td><Tags list={r} /></td>
                  <td><small>{e.air}<br />{e.dryer}</small></td>
                  <td className="grade">{g(s)}</td>
                  <td><small>{s.contact_status && s.contact_status !== "none" ? `${CONTACT_LABEL[s.contact_status]}${s.owner ? ` · ${s.owner}` : ""}` : "–"}</small></td>
                </tr>); })}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpt-two">
        <div>
          <h2>영업 현황 <small>팀이 기록한 상태 기준</small></h2>
          {inProgress.length === 0 ? <p className="muted">아직 기록된 영업 활동이 없습니다. 대시보드 상세 패널에서 상태·담당을 적으면 여기에 쌓입니다.</p> : (
            <>
              <div className="stage-chart">
                {funnelKeys.map((k) => (
                  <div key={k} className="stage-row"><span className="stage-l">{CONTACT_LABEL[k]}</span><span className="stage-bar"><span className={k === "won" ? "won" : k === "lost" ? "lost" : ""} style={{ width: `${(funnel[k] / Math.max(1, inProgress.length)) * 100}%` }} /></span><span className="stage-n">{funnel[k]}</span></div>
                ))}
              </div>
              {Object.keys(byOwner).length > 0 && (
                <table className="rpt-table compact" style={{ marginTop: 10 }}>
                  <thead><tr><th>담당</th><th>맡은 건</th><th>진행 중(접촉~견적)</th></tr></thead>
                  <tbody>{Object.entries(byOwner).sort((a, b) => b[1].active - a[1].active).map(([o, v]) => <tr key={o}><td>{o}</td><td className="num">{v.n}</td><td className="num">{v.active}</td></tr>)}</tbody>
                </table>
              )}
            </>
          )}
        </div>
        <div>
          <h2>지난주 대비 변화 <small>최근 {days}일</small></h2>
          <ul className="change-list">
            <li><b>{fresh.length}</b>건 새로 포착{fresh.length > 0 && <small> — {fresh.slice(0, 4).map((s) => s.company_name).join(", ")}{fresh.length > 4 ? " 등" : ""}</small>}</li>
            {systemChanges.length === 0
              ? <li className="muted">단계·금액이 바뀐 건 없음</li>
              : systemChanges.slice(0, 8).map((c, i) => <li key={i}><b>{c.company_name}</b> <small>{c.content} · {fmtDate(c.created_at)}</small></li>)}
            {matchedPermits.length > 0 && <li><b>{Object.keys(hitBySignal).length}</b>건은 건축허가 원장에서 회사명이 확인됨 <small>— {Object.values(hitBySignal).slice(0, 4).map((m) => m.bld_nm).join(", ")}</small></li>}
          </ul>
        </div>
      </section>

      {inProgress.length > 0 && (
        <section>
          <h2>진행 중인 영업 <small>상태순</small></h2>
          <table className="rpt-table">
            <thead><tr><th>상태</th><th>회사</th><th>지역</th><th>담당</th><th>인맥</th><th>최근 기록</th></tr></thead>
            <tbody>
              {inProgress.map((s) => (
                <tr key={s.id} className={s.customer_name ? "is-cust" : ""}>
                  <td><b className={["quoted", "meeting"].includes(s.contact_status) ? "hot" : ""}>{CONTACT_LABEL[s.contact_status ?? "none"]}</b></td>
                  <td><b>{s.company_name}</b>{s.customer_name ? <span className="cust-tag">고객</span> : null}</td>
                  <td>{sidoName(s.sido)} {s.sigungu ?? ""}</td>
                  <td>{s.owner ?? "–"}</td>
                  <td><small>{s.network_note ?? ""}</small></td>
                  <td><small>{s.content ? `${fmtDate(s.created_at)} ${s.actor ?? ""} — ${s.content}` : "–"}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="rpt-three">
        <div>
          <h2>지역별</h2>
          <table className="rpt-table compact">
            <thead><tr><th>시도</th><th>건</th><th>즉시</th><th>금액</th></tr></thead>
            <tbody>{sidoRows.map(([k, v]) => <tr key={k}><td>{sidoName(k)}</td><td className="num">{v.n}</td><td className="num hot">{v.hot || ""}</td><td className="num">{v.amt ? fmtKrw(v.amt) : "–"}</td></tr>)}</tbody>
          </table>
        </div>
        <div>
          <h2>업종별</h2>
          <table className="rpt-table compact">
            <thead><tr><th>업종</th><th>건</th><th>즉시</th></tr></thead>
            <tbody>{sectorRows.map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{v.n}</td><td className="num hot">{v.hot || ""}</td></tr>)}</tbody>
          </table>
        </div>
        <div>
          <h2>단계별</h2>
          <div className="stage-chart">
            {Object.entries(byStage).map(([k, n]) => (
              <div key={k} className="stage-row"><span className="stage-l">{STAGE_LABEL[k]}</span><span className="stage-bar"><span style={{ width: `${(n / Math.max(1, all.length)) * 100}%` }} /></span><span className="stage-n">{n}</span></div>
            ))}
          </div>
          <p className="muted small">공시·협약·인허가 = 발주 전. 착공 = 발주 임박. 준공 = 교체·증설 수요.</p>
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
              {permits.map((pm) => { const mk = permitMark(pm); return (
                <tr key={pm.id} className={mk === "cust" ? "is-cust" : mk === "radar" ? "is-radar" : ""}>
                  <td className="num">{fmtDay8(pm.pms_day)}</td>
                  <td>{pm.arch_gb ?? ""} {pm.main_purps ?? ""}</td>
                  <td><b>{pm.bld_nm ?? "–"}</b>{mk === "cust" ? <span className="cust-tag">고객</span> : mk === "radar" ? <span className="radar-tag">레이더</span> : null}</td>
                  <td>{shortPlc(pm.plat_plc)}</td>
                  <td className="num">{Math.round(pm.tot_area).toLocaleString()}㎡</td>
                  <td className="num">{pm.real_stcns_day ? <span className="hot">{fmtDay8(pm.real_stcns_day)}</span> : pm.stcns_sched_day ? `예정 ${fmtDay8(pm.stcns_sched_day)}` : "–"}</td>
                </tr>); })}
            </tbody>
          </table>
          <p className="muted small">건축HUB(국토교통부) 인허가 원장. 뉴스에 안 나와도 허가가 났으면 실제 공사 — 파란 줄은 기존 거래처, 회색 줄은 레이더에 있는 회사. 전국이 아니라 레이더 신호가 있는 동네만 조회한 결과.</p>
        </section>
      )}

      <section>
        <h2>전체 추적 목록 <small>{all.length}건 · 관련도순</small></h2>
        <table className="rpt-table compact">
          <thead><tr><th>점수</th><th>회사</th><th>지역</th><th>거점</th><th>유형</th><th>단계</th><th>금액</th><th>등급</th><th>출처</th><th>영업</th></tr></thead>
          <tbody>
            {all.map((s) => { const n = nearestSite(s.lat, s.lng); return (
              <tr key={s.id} className={s.customer_name ? "is-cust" : ""}>
                <td className={`num pri-${priority(s.relevance_score)}`}>{s.relevance_score}</td>
                <td>{s.company_name}{s.customer_name ? <span className="cust-tag">고객</span> : null}</td><td>{sidoName(s.sido)} {s.sigungu ?? ""}</td>
                <td className="num"><small>{n ? `${n.name.slice(0, 2)} ${n.km}km` : "–"}</small></td>
                <td>{EVENT_LABEL[s.event_type]}</td><td>{STAGE_LABEL[s.stage]}</td>
                <td className="num">{fmtKrw(s.amount_krw)}</td><td className="grade">{g(s)}</td><td className="num">{s.source_count}</td>
                <td><small>{s.contact_status && s.contact_status !== "none" ? CONTACT_LABEL[s.contact_status] : ""}</small></td>
              </tr>); })}
          </tbody>
        </table>
      </section>

      <footer className="rpt-foot">
        <p>읽는 법 — 점수: 업종·공정·단계로 산정한 압축기·드라이어·HMI 수요 관련도(70+ 즉시 검토, 40~69 모니터링). 등급: A 공식 출처(공시·정부 발표), B 서로 다른 주요 언론 2곳 이상 또는 매체 4곳 이상 보도, C 그 외. 예상 압축기 용량과 '발주 예상' 시기(준공 목표 6~9개월 전)는 추정치로 현장 확인 전 참고용입니다. 거점 거리는 창원 본사·김해 공장·평택 중부사무소 기준 직선거리입니다.</p>
        <p>출처: DART 전자공시, 산업통상부·정책브리핑, 구글·Bing 뉴스, 지방지 RSS, 한국산업단지공단 등록공장현황, 국토교통부 건축HUB 건축인허가. 자동 수집 후 담당자 검수.</p>
      </footer>
    </main>
  );
}
