"use client";

import { SIDO_LIST, SIZE_SHORT, STAGE_LABEL, STAGE_ORDER, sidoName } from "@/lib/format";

export const DEFAULT_FILTERS = { grades: ["A", "B"], sizes: ["L", "M", "U"], stages: [], sidos: [], minScore: 0, q: "", customer: false };

function toggle(arr, v) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

/**
 * 왼쪽 레일. 지역은 칩 나열 대신 "시도별 건수 막대" — 어디에 쌓여 있고 어디가 비었는지가 한눈에 보인다.
 * bySido: { 시도명: {total, hot} } (지역 필터 제외한 나머지 필터 적용 후 집계)
 */
export default function FilterBar({ value, onChange, bySido = {}, unlocated = 0 }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const max = Math.max(1, ...Object.values(bySido).map((v) => v.total));
  const active = (k) => value.sidos.includes(k);

  return (
    <aside className="rail">
      <input className="search" placeholder="회사·업종·지역·산단 검색" value={value.q} onChange={(e) => set({ q: e.target.value })} aria-label="검색" />
      <button className={`cust-toggle ${value.customer ? "on" : ""}`} onClick={() => set({ customer: !value.customer })}>
        <span className="cust-dot" />기존 거래처만 보기
      </button>

      <section className="rail-sec">
        <h3>지역별 건수</h3>
        <ul className="sido-bars">
          {SIDO_LIST.map((sido) => {
            const v = bySido[sido] ?? { total: 0, hot: 0 };
            const w = (v.total / max) * 100;
            return (
              <li key={sido}>
                <button className={`sido-row ${active(sido) ? "on" : ""} ${v.total === 0 ? "zero" : ""}`} onClick={() => set({ sidos: toggle(value.sidos, sido) })} title={`${sido}: ${v.total}건 (즉시검토 ${v.hot})`}>
                  <span className="sido-name">{sidoName(sido)}</span>
                  <span className="sido-bar"><span className="sido-fill" style={{ width: `${w}%` }}><span className="sido-hot" style={{ width: v.total ? `${(v.hot / v.total) * 100}%` : 0 }} /></span></span>
                  <span className="sido-n">{v.total || "–"}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {unlocated > 0 && <div className="rail-note">위치 미상 {unlocated}건은 목록에만 있습니다</div>}
        {value.sidos.length > 0 && <button className="link" onClick={() => set({ sidos: [] })}>전체 지역 보기</button>}
      </section>

      <section className="rail-sec">
        <h3>관련도 {value.minScore > 0 ? `${value.minScore}점 이상` : "전체"}</h3>
        <input type="range" min={0} max={90} step={10} value={value.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} aria-label="관련도 최소값" />
        <div className="scale"><span>0</span><span className="w">40 모니터링</span><span className="h">70 즉시검토</span></div>
      </section>

      <section className="rail-sec">
        <h3>출처 신뢰</h3>
        <div className="seg">
          {[["A", "공식"], ["B", "교차확인"], ["C", "단일보도"]].map(([g, l]) => (
            <button key={g} className={value.grades.includes(g) ? "on" : ""} onClick={() => set({ grades: toggle(value.grades, g) })}>
              <b>{g}</b> {l}
            </button>
          ))}
        </div>
      </section>

      <section className="rail-sec">
        <h3>규모</h3>
        <div className="seg">
          {["L", "M", "S", "U"].map((k) => (
            <button key={k} className={value.sizes.includes(k) ? "on" : ""} onClick={() => set({ sizes: toggle(value.sizes, k) })}>
              {k === "L" ? "500억+" : k === "M" ? "50~500억" : k === "S" ? "50억 미만" : "미상"}
            </button>
          ))}
        </div>
      </section>

      <section className="rail-sec">
        <h3>단계</h3>
        <div className="seg stages">
          {STAGE_ORDER.map((k) => (
            <button key={k} className={value.stages.includes(k) ? "on" : ""} onClick={() => set({ stages: toggle(value.stages, k) })}>{STAGE_LABEL[k]}</button>
          ))}
        </div>
      </section>

      <button className="link reset" onClick={() => onChange(DEFAULT_FILTERS)}>필터 초기화</button>

      <section className="legend">
        <h3>핀 읽는 법</h3>
        <div className="lg-row"><span className="lg-pin" style={{ background: "#D8321F" }}>85</span><span>빨강 70점+ 즉시 검토</span></div>
        <div className="lg-row"><span className="lg-pin" style={{ background: "#E09A12" }}>55</span><span>호박 40~69 모니터링</span></div>
        <div className="lg-row"><span className="lg-pin" style={{ background: "#8E969B" }}>20</span><span>회색 40 미만</span></div>
        <div className="lg-row"><span className="lg-pin" style={{ background: "#2457C5" }}>75</span><span>파랑 = 기존 거래처(드라이어 납품 이력)</span></div>
        <div className="lg-row"><span className="lg-pin lg-l">대</span><span>핀 크기 = 투자 규모</span></div>
        <div className="lg-row"><span className="lg-pin lg-c">C</span><span>점선 = 단일 보도(미확인)</span></div>
        <div className="lg-row"><span className="lg-chip dashed">기존 공장</span><span>선택한 회사의 등록공장 (누르면 생산품·주소)</span></div>
        <div className="lg-row"><span className="lg-chip"><i>착공</i>증축 4.8만㎡</span><span>같은 동네 건축허가 (누르면 허가일·착공일)</span></div>
      </section>
    </aside>
  );
}
