"use client";

import { useEffect, useState } from "react";

import CompanyCard from "@/components/CompanyCard";
import { estimateUtility, CONTACT_LABEL, CONTACT_STATUS, KIND_LABEL, EVENT_LABEL, GRADE_LABEL, SIZE_LABEL, STAGE_LABEL, STAGE_ORDER, fmtDate, fmtKrw, grade, priority, PRIORITY_LABEL, scoreColor, sidoName, stageIndex } from "@/lib/format";

/** 5단계 진행바 — 공시→협약→인허가→착공→준공 (진짜 순서라서 진행바) */
export function StageBar({ stage, compact = false }) {
  const idx = stageIndex(stage);
  return (
    <div className={`stagebar ${compact ? "compact" : ""}`} aria-label={`단계 ${STAGE_LABEL[stage]}`}>
      {STAGE_ORDER.map((k, i) => (
        <span key={k} className={`seg ${i < idx ? "done" : i === idx ? "now" : ""}`}>{compact ? "" : STAGE_LABEL[k]}</span>
      ))}
      {compact && <span className="stage-now">{STAGE_LABEL[stage]}</span>}
    </div>
  );
}

/** ES 수요 막대 3개 */
export function NeedBars({ s }) {
  const rows = [["압축기", s.need_compressed_air], ["드라이어", s.need_dryer], ["HMI·제어", s.need_hmi]];
  return (
    <div className="needs">
      {rows.map(([l, n]) => (
        <div key={l} className="need-row">
          <span className="need-l">{l}</span>
          <span className="need-track">{[1, 2, 3].map((i) => <span key={i} className={`need-cell ${i <= (n ?? 0) ? "on" : ""}`} />)}</span>
          <span className="need-t">{["없음", "낮음", "있음", "핵심"][n ?? 0]}</span>
        </div>
      ))}
    </div>
  );
}

export function SignalList({ signals, selectedId, onSelect }) {
  const hot = signals.filter((s) => priority(s.relevance_score) === "hot");
  const rest = signals.filter((s) => priority(s.relevance_score) !== "hot");
  const Row = ({ s }) => (
    <button className={`row ${s.id === selectedId ? "sel" : ""}`} onClick={() => onSelect(s)}>
      <span className="score" style={{ background: scoreColor(s.relevance_score) }}>{s.relevance_score}</span>
      <span className="row-main">
        <span className="row-title">
          <b>{s.company_name}</b>
          {s.customer_name && <span className="cust-badge" title={`기존 거래처: ${s.customer_name}`}>고객</span>}
          <span className="row-loc">{sidoName(s.sido)} {s.sigungu ?? ""}</span>
        </span>
        <span className="row-sub">
          <span className="amt">{fmtKrw(s.amount_krw)}</span>
          <span>{EVENT_LABEL[s.event_type]}</span>
          <span className={`g g${grade(s)}`}>{grade(s)}</span>
          {s.stale && <span className="warn">무소식 18개월</span>}
          {s.contact_status && s.contact_status !== "none" && <span className={`st st-${s.contact_status}`}>{CONTACT_LABEL[s.contact_status]}{s.owner ? ` · ${s.owner}` : ""}</span>}
        </span>
        <StageBar stage={s.stage} compact />
      </span>
    </button>
  );
  return (
    <div className="list">
      {hot.length > 0 && <div className="list-h"><span className="dot hot" />즉시 검토 <b>{hot.length}</b></div>}
      {hot.map((s) => <Row key={s.id} s={s} />)}
      {rest.length > 0 && <div className="list-h"><span className="dot watch" />모니터링·보관 <b>{rest.length}</b></div>}
      {rest.map((s) => <Row key={s.id} s={s} />)}
      {signals.length === 0 && <div className="empty">조건에 맞는 건이 없습니다. 필터를 풀거나 관련도를 낮춰 보세요.</div>}
    </div>
  );
}

/** 등록공장 현황(공공데이터)에서 같은 회사의 기존 공장. 지도에는 연한 핀으로. */
export function FactoryList({ name, onFactories }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!name) return;
    setRows(null);
    fetch(`/api/factories?name=${encodeURIComponent(name)}`).then((r) => r.json()).then((d) => { setRows(d.factories ?? []); onFactories?.(d.factories ?? []); }).catch(() => setRows([]));
    return () => onFactories?.([]);
  }, [name]);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="detail-sec">
      <h3>기존 등록공장 {rows.length}곳 <small>한국산업단지공단 2025.12</small></h3>
      <ul className="facs">
        {rows.map((f) => (
          <li key={f.id}>
            <span className="fac-loc">{sidoName(f.sido)} {f.sigungu ?? ""}</span>
            <span className="fac-main">{f.complex ? <b>{f.complex}</b> : <b>개별입지</b>}<small>{(f.products ?? "").slice(0, 40)}</small></span>
            {f.lat == null && <span className="fac-nogeo" title="아직 좌표 없음">·</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}


const fmtDay = (d) => (d && d.length === 8 ? `${d.slice(2, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : "");
const fmtArea = (a) => (a ? `${Math.round(a).toLocaleString()}㎡` : "");

/** 같은 법정동의 최근 1년 공장·창고 건축허가 — 착공 임박 현장 = 유틸리티 발주 임박. */
export function PermitList({ signalId, onPermits }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!signalId) return;
    setRows(null);
    fetch(`/api/permits?signal_id=${encodeURIComponent(signalId)}`).then((r) => r.json()).then((d) => { setRows(d.permits ?? []); onPermits?.(d.permits ?? []); }).catch(() => setRows([]));
    return () => onPermits?.([]);
  }, [signalId]);
  if (!rows || rows.length === 0) return null;
  const phase = (p) => (p.use_apr_day ? "사용승인" : p.real_stcns_day ? "착공" : p.stcns_sched_day ? "착공예정" : "허가");
  return (
    <section className="detail-sec">
      <h3>같은 동네 공장 건축허가 {rows.length}건 <small>건축HUB · 최근 1년 · 연면적 300㎡ 이상</small></h3>
      <ul className="permits">
        {rows.map((p) => (
          <li key={p.id}>
            <span className={`pm-phase pm-${p.use_apr_day ? "done" : p.real_stcns_day ? "build" : "pms"}`}>{phase(p)}</span>
            <span className="pm-main">
              <b>{p.arch_gb ?? ""} {p.main_purps ?? "공장용지"} {fmtArea(p.tot_area)}</b>
              <small>{p.bld_nm ? `${p.bld_nm} · ` : ""}{(p.plat_plc ?? "").replace(/^(.*?(시|군|구)\s)/, "")}</small>
            </span>
            <span className="pm-day">{fmtDay(p.real_stcns_day || p.stcns_sched_day || p.pms_day)}</span>
          </li>
        ))}
      </ul>
      <p className="hint">허가→착공 사이가 압축기·드라이어 사양 결정 시점. 건물명에 회사명이 보이면 바로 연락.</p>
    </section>
  );
}

const myName = () => { try { return localStorage.getItem("radar.me") || ""; } catch { return ""; } };
const saveName = (n) => { try { localStorage.setItem("radar.me", n); } catch {} };
const fmtWhen = (d) => { const x = new Date(d); return `${String(x.getMonth() + 1).padStart(2, "0")}.${String(x.getDate()).padStart(2, "0")} ${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`; };

/** 영업 진행 — 상태(단계 칩), 담당, 인맥 메모, 활동 기록. 이름은 한 번 입력하면 이 브라우저에 기억. */
export function SalesPanel({ s, onChange }) {
  const [me, setMe] = useState("");
  const [data, setData] = useState(null);
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("call");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { setMe(myName()); }, []);
  useEffect(() => {
    setData(null); setErr("");
    fetch(`/api/activity?signal_id=${encodeURIComponent(s.id)}`).then((r) => r.json()).then((d) => { setData(d); setOwner(d.owner ?? ""); setNote(d.network_note ?? ""); }).catch(() => setData({ activities: [] }));
  }, [s.id]);

  const post = async (body) => {
    if (!me.trim()) { setErr("먼저 내 이름을 입력하세요."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signal_id: s.id, actor: me.trim(), ...body }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "저장 실패");
      setData(d); setOwner(d.owner ?? ""); setNote(d.network_note ?? "");
      onChange?.({ owner: d.owner, contact_status: d.contact_status, network_note: d.network_note });
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const status = data?.contact_status ?? s.contact_status ?? "none";
  const acts = data?.activities ?? [];

  return (
    <section className="detail-sec sales">
      <h3>영업 진행 <small>팀 공용 — 누가 어디까지 했는지</small></h3>

      <div className="me-row">
        <label>내 이름</label>
        <input value={me} placeholder="예: 신상언" onChange={(e) => { setMe(e.target.value); saveName(e.target.value); }} />
      </div>

      <div className="status-chips" role="radiogroup" aria-label="접촉 상태">
        {CONTACT_STATUS.map((k) => (
          <button key={k} className={`chip ${k} ${status === k ? "on" : ""}`} disabled={busy} onClick={() => status !== k && post({ status: k })}>{CONTACT_LABEL[k]}</button>
        ))}
      </div>

      <div className="kv-edit">
        <label>담당</label>
        <input value={owner} placeholder="미배정 — 이름 입력 후 Enter" onChange={(e) => setOwner(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && post({ owner })} onBlur={() => owner !== (data?.owner ?? "") && post({ owner })} />
        <button className="mini" disabled={busy || owner === me} onClick={() => { setOwner(me); post({ owner: me }); }}>내가 맡기</button>
      </div>
      <div className="kv-edit">
        <label>인맥</label>
        <input value={note} placeholder="예: ○○이사 → 공장장 동문. 소개 가능" onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && post({ network_note: note })} onBlur={() => note !== (data?.network_note ?? "") && post({ network_note: note })} />
      </div>

      <form className="act-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) post({ kind, content: text }).then(() => setText("")); }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="기록 종류">
          <option value="call">전화</option><option value="visit">방문</option><option value="quote">견적</option><option value="note">메모</option>
        </select>
        <input value={text} placeholder="예: 구매팀 김과장 통화, 내년 2월 설비 사양 확정 예정" onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={busy || !text.trim()}>기록</button>
      </form>
      {err && <p className="form-err">{err}</p>}

      {acts.length > 0 && (
        <ol className="timeline">
          {acts.map((a) => (
            <li key={a.id} className={a.kind}>
              <span className="tl-when">{fmtWhen(a.created_at)}</span>
              <span className="tl-kind">{KIND_LABEL[a.kind] ?? a.kind}</span>
              <span className="tl-body"><b>{a.actor ?? "?"}</b> {a.content}</span>
            </li>
          ))}
        </ol>
      )}
      {data && acts.length === 0 && <p className="hint">아직 기록 없음. 전화 한 통도 적어두면 다음 사람이 두 번 안 합니다.</p>}
    </section>
  );
}

/** 들어가는 길 — 그룹별 구매 채널·등록 절차·영업 팁. 기본값 + 팀이 고친 내용(DB). */
export function Playbook({ s }) {
  const [pb, setPb] = useState(null);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setPb(null); setEdit(false);
    fetch(`/api/playbook?company=${encodeURIComponent(s.company_name ?? "")}&group=${encodeURIComponent(s.company_group ?? "")}`).then((r) => r.json()).then(setPb).catch(() => setPb(null));
  }, [s.id]);
  if (!pb) return null;
  const save = async () => {
    const me = myName();
    if (!me) { setErr("영업 진행 칸의 '내 이름'을 먼저 입력하세요."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/playbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: pb.key, actor: me, ...draft }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "저장 실패");
      setPb(d); setEdit(false);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const F = ({ k, label, rows = 2 }) => (
    <label className="pb-f"><span>{label}</span><textarea rows={rows} value={draft[k] ?? pb[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>
  );
  return (
    <section className="detail-sec playbook">
      <h3>들어가는 길 <small>{pb.label}{pb.edited ? ` · ${pb.updated_by ?? "팀"} 수정` : " · 기본 안내"}</small>
        {!edit && <button className="mini pb-edit" onClick={() => { setDraft({}); setEdit(true); }}>수정</button>}
      </h3>
      {pb.verify && !pb.edited && <p className="pb-verify">기본값은 공개 정보로 채운 초안입니다. 실제 채널·담당을 아는 분이 '수정'으로 바로잡아 주세요.</p>}
      {edit ? (
        <div className="pb-form">
          {F({ k: "channel", label: "구매 채널", rows: 1 })}
          <label className="pb-f"><span>채널 주소</span><input value={draft.channel_url ?? pb.channel_url ?? ""} onChange={(e) => setDraft({ ...draft, channel_url: e.target.value })} placeholder="https://" /></label>
          {F({ k: "registration", label: "등록·진입 절차", rows: 3 })}
          {F({ k: "tips", label: "영업 팁 (GENEQ 경험)", rows: 3 })}
          {err && <p className="form-err">{err}</p>}
          <div className="pb-actions"><button className="mini" onClick={() => setEdit(false)} disabled={busy}>취소</button><button className="mini on" onClick={save} disabled={busy}>저장</button></div>
        </div>
      ) : (
        <dl className="pb-kv">
          <dt>채널</dt><dd>{pb.channel_url ? <a href={pb.channel_url} target="_blank" rel="noreferrer">{pb.channel}</a> : pb.channel}</dd>
          <dt>절차</dt><dd>{pb.registration}</dd>
          <dt>팁</dt><dd className="pb-tips">{pb.tips}</dd>
        </dl>
      )}
    </section>
  );
}

export function SignalDetail({ s, onClose, onBack, onFactories, onPermits, onSalesChange }) {
  const g = grade(s);
  const p = priority(s.relevance_score);
  return (
    <div className="detail">
      <div className="detail-top">
        <button className="back" onClick={onBack ?? onClose}>← 목록</button>
        <button className="x" onClick={onClose} aria-label="닫기">×</button>
      </div>

      <div className="detail-head">
        <span className="score lg" style={{ background: scoreColor(s.relevance_score) }}>{s.relevance_score}</span>
        <div>
          <h2>{s.company_name}{s.company_group ? <span className="grp"> {s.company_group}</span> : null}</h2>
          <div className="detail-loc">{s.sido ?? "위치 미상"} {s.sigungu ?? ""}{s.industrial_complex ? ` · ${s.industrial_complex}` : ""}</div>
        </div>
      </div>
      {s.customer_name && (
        <div className="cust-banner">
          <b>기존 거래처</b> — {s.customer_name}{s.customer_sites ? ` (${s.customer_sites})` : ""}{s.customer_note ? ` · ${s.customer_note}` : ""}. 드라이어 납품·견적 이력이 있으니 담당자 연락처부터 확인.
        </div>
      )}

      <p className="verdict">
        <b style={{ color: scoreColor(s.relevance_score) }}>{PRIORITY_LABEL[p]}</b> · {EVENT_LABEL[s.event_type]} · {SIZE_LABEL[s.size_class]} · {GRADE_LABEL[g]}{s.manual_grade ? " (수동)" : ""}
        {s.amount_conflict && <span className="warn"> · 출처 간 금액 불일치</span>}
      </p>

      <StageBar stage={s.stage} />

      <p className="summary">{s.summary}</p>

      <dl className="kv">
        <dt>투자금액</dt><dd className="amt-lg">{fmtKrw(s.amount_krw)}{s.amount_krw && !s.amount_disclosed ? <small> 추정</small> : null}</dd>
        <dt>기간</dt><dd>{s.period_start ?? "?"} → {s.period_end ?? "?"}</dd>
        <dt>업종·공정</dt><dd>{s.sector ?? "-"}{s.process_hint ? <><br /><small>{s.process_hint}</small></> : null}</dd>
        {s.address_raw && (<><dt>주소</dt><dd>{s.address_raw}</dd></>)}
      </dl>

      <section className="detail-sec">
        <h3>우리 설비가 필요한 이유</h3>
        <NeedBars s={s} />
        {s.need_rationale && <p className="rationale">{s.need_rationale}</p>}
        {(() => { const e = estimateUtility(s); return (
          <dl className="est">
            <dt>예상 압축기</dt><dd>{e.air}</dd>
            <dt>드라이어</dt><dd>{e.dryer}</dd>
            <dt>제안 포인트</dt><dd>{e.note}</dd>
            <dd className="est-note">업종·규모 기반 추정치. 현장 확인 전 참고용.</dd>
          </dl>); })()}
      </section>

      <Playbook s={s} />
      <SalesPanel s={s} onChange={(patch) => onSalesChange?.(s.id, patch)} />
      <FactoryList name={s.company_name} onFactories={onFactories} />
      <PermitList signalId={s.id} onPermits={onPermits} />

      <CompanyCard corpCode={s.corp_code} currentSignalId={s.id} />

      <section className="detail-sec">
        <h3>출처 {s.source_count}건</h3>
        <ul className="sources">
          {(s.sources ?? []).slice(0, 12).map((src, i) => (
            <li key={i}>
              <a href={src.url?.startsWith("permit://") ? "https://www.hub.go.kr" : src.url} target="_blank" rel="noreferrer">
                <span className={`tier t${src.tier}`}>{src.url?.startsWith("permit://") ? "원장" : src.tier === 1 ? "공식" : src.tier === 2 ? "주요지" : "기타"}</span>
                <span className="src-name">{src.source ?? ""}</span>
                <span className="src-title">{src.title ?? src.url}</span>
                <span className="src-date">{fmtDate(src.published_at)}</span>
              </a>
            </li>
          ))}
          {(s.sources?.length ?? 0) > 12 && <li className="more">외 {s.sources.length - 12}건</li>}
        </ul>
      </section>

    </div>
  );
}
