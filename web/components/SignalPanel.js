"use client";

import { EVENT_LABEL, SIZE_LABEL, STAGE_LABEL } from "@/lib/format";
import { fmtDate, fmtKrw, grade, needDots, scoreColor } from "@/lib/format";

export function SignalList({ signals, selectedId, onSelect }) {
  return (
    <div className="list">
      {signals.map((s) => (
        <button key={s.id} className={`row ${s.id === selectedId ? "sel" : ""}`} onClick={() => onSelect(s)}>
          <span className="score" style={{ background: scoreColor(s.relevance_score) }}>{s.relevance_score}</span>
          <span className="row-main">
            <span className="row-title">
              <b>{s.company_name}</b> <span className="tag">{grade(s)}</span> <span className="tag">{s.size_class}</span>
              {s.stale && <span className="tag warn">stale</span>}
            </span>
            <span className="row-sub">
              {s.sido?.replace(/(특별자치도|특별자치시|광역시|특별시)$/, "")} {s.sigungu} · {EVENT_LABEL[s.event_type]} · {STAGE_LABEL[s.stage]} · {fmtKrw(s.amount_krw)}
            </span>
          </span>
        </button>
      ))}
      {signals.length === 0 && <div className="muted" style={{ padding: 16 }}>조건에 맞는 건이 없습니다.</div>}
    </div>
  );
}

export function SignalDetail({ s, onClose }) {
  const g = grade(s);
  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <div className="detail-company">{s.company_name}{s.company_group ? <span className="muted"> · {s.company_group}</span> : null}</div>
          <div className="detail-loc">{s.sido} {s.sigungu} {s.industrial_complex ? `· ${s.industrial_complex}` : ""}</div>
        </div>
        <button className="x" onClick={onClose} aria-label="닫기">×</button>
      </div>

      <div className="badges">
        <span className="badge" style={{ background: scoreColor(s.relevance_score), color: "#fff" }}>관련도 {s.relevance_score}</span>
        <span className="badge">등급 {g}{s.manual_grade ? " (수동)" : ""}</span>
        <span className="badge">{SIZE_LABEL[s.size_class]}</span>
        <span className="badge">{EVENT_LABEL[s.event_type]}</span>
        <span className="badge">{STAGE_LABEL[s.stage]}</span>
        {s.amount_conflict && <span className="badge warn">금액 충돌</span>}
        {s.stale && <span className="badge warn">18개월 무소식</span>}
      </div>

      <p className="summary">{s.summary}</p>

      <dl className="kv">
        <dt>투자금액</dt><dd>{fmtKrw(s.amount_krw)}{s.amount_krw && !s.amount_disclosed ? " (추정)" : ""}</dd>
        <dt>기간</dt><dd>{s.period_start ?? "?"} ~ {s.period_end ?? "?"}</dd>
        <dt>업종</dt><dd>{s.sector ?? "-"}{s.process_hint ? ` · ${s.process_hint}` : ""}</dd>
        <dt>위치 정밀도</dt><dd>{s.location_precision ?? "-"} / {s.geocode_status ?? "-"}</dd>
        {s.address_raw && (<><dt>주소</dt><dd>{s.address_raw}</dd></>)}
      </dl>

      <div className="need">
        <div className="f-title">ES사업부 수요 예상</div>
        <div className="need-row"><span>압축기</span><span className="dots">{needDots(s.need_compressed_air)}</span></div>
        <div className="need-row"><span>드라이어</span><span className="dots">{needDots(s.need_dryer)}</span></div>
        <div className="need-row"><span>HMI·제어</span><span className="dots">{needDots(s.need_hmi)}</span></div>
        {s.need_rationale && <div className="muted small" style={{ marginTop: 6 }}>{s.need_rationale}</div>}
      </div>

      <div className="sources">
        <div className="f-title">출처 {s.source_count}건</div>
        {(s.sources ?? []).map((src, i) => (
          <a key={i} href={src.url} target="_blank" rel="noreferrer" className="src">
            <span className={`tier t${src.tier}`}>T{src.tier}</span>
            <span className="src-name">{src.source ?? ""}</span>
            <span className="src-title">{src.title ?? src.url}</span>
            <span className="muted small">{fmtDate(src.published_at)}</span>
          </a>
        ))}
      </div>

      <div className="action">
        <div className="f-title">영업 액션 (Phase 2)</div>
        <div className="muted small">담당: {s.owner ?? "미배정"} · 상태: {s.contact_status ?? "none"}</div>
        {s.network_note && <div className="small">연결: {s.network_note}</div>}
      </div>
    </div>
  );
}
