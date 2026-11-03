"use client";

import CompanyCard from "@/components/CompanyCard";
import { EVENT_LABEL, GRADE_LABEL, SIZE_LABEL, STAGE_LABEL, STAGE_ORDER, fmtDate, fmtKrw, grade, priority, PRIORITY_LABEL, scoreColor, sidoName, stageIndex } from "@/lib/format";

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
          <span className="row-loc">{sidoName(s.sido)} {s.sigungu ?? ""}</span>
        </span>
        <span className="row-sub">
          <span className="amt">{fmtKrw(s.amount_krw)}</span>
          <span>{EVENT_LABEL[s.event_type]}</span>
          <span className={`g g${grade(s)}`}>{grade(s)}</span>
          {s.stale && <span className="warn">무소식 18개월</span>}
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

export function SignalDetail({ s, onClose, onBack }) {
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
      </section>

      <CompanyCard corpCode={s.corp_code} currentSignalId={s.id} />

      <section className="detail-sec">
        <h3>출처 {s.source_count}건</h3>
        <ul className="sources">
          {(s.sources ?? []).slice(0, 12).map((src, i) => (
            <li key={i}>
              <a href={src.url} target="_blank" rel="noreferrer">
                <span className={`tier t${src.tier}`}>{src.tier === 1 ? "공식" : src.tier === 2 ? "주요지" : "기타"}</span>
                <span className="src-name">{src.source ?? ""}</span>
                <span className="src-title">{src.title ?? src.url}</span>
                <span className="src-date">{fmtDate(src.published_at)}</span>
              </a>
            </li>
          ))}
          {(s.sources?.length ?? 0) > 12 && <li className="more">외 {s.sources.length - 12}건</li>}
        </ul>
      </section>

      <section className="detail-sec muted">
        <h3>영업 진행</h3>
        <p>담당 {s.owner ?? "미배정"} · 상태 {s.contact_status === "none" || !s.contact_status ? "미접촉" : s.contact_status}{s.network_note ? ` · ${s.network_note}` : ""}</p>
      </section>
    </div>
  );
}
