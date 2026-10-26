"use client";

import { EVENT_LABEL, SIDO_LIST, SIZE_LABEL, STAGE_LABEL } from "@/lib/format";


export const DEFAULT_FILTERS = { grades: ["A", "B"], sizes: [], stages: [], sidos: [], minScore: 0, q: "" };

function toggle(arr, v) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

export default function FilterBar({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <aside className="filters">
      <div className="f-group">
        <input
          className="f-search"
          placeholder="회사명·업종·지역·산단 검색"
          value={value.q}
          onChange={(e) => set({ q: e.target.value })}
        />
      </div>

      <div className="f-group">
        <div className="f-title">신뢰 등급</div>
        <div className="chips">
          {["A", "B", "C"].map((g) => (
            <button key={g} className={`chip ${value.grades.includes(g) ? "on" : ""}`} onClick={() => set({ grades: toggle(value.grades, g) })}>
              {g} {g === "A" ? "공식" : g === "B" ? "교차확인" : "미확인"}
            </button>
          ))}
        </div>
      </div>

      <div className="f-group">
        <div className="f-title">규모</div>
        <div className="chips">
          {Object.keys(SIZE_LABEL).map((k) => (
            <button key={k} className={`chip ${value.sizes.includes(k) ? "on" : ""}`} onClick={() => set({ sizes: toggle(value.sizes, k) })}>
              {SIZE_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <div className="f-group">
        <div className="f-title">단계</div>
        <div className="chips">
          {Object.keys(STAGE_LABEL).map((k) => (
            <button key={k} className={`chip ${value.stages.includes(k) ? "on" : ""}`} onClick={() => set({ stages: toggle(value.stages, k) })}>
              {STAGE_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <div className="f-group">
        <div className="f-title">관련도 ≥ {value.minScore}</div>
        <input type="range" min={0} max={100} step={5} value={value.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} />
        <div className="muted small">70+ 즉시 검토 · 40+ 모니터링</div>
      </div>

      <div className="f-group">
        <div className="f-title">지역 (시도)</div>
        <div className="chips wrap">
          {SIDO_LIST.map((s) => (
            <button key={s} className={`chip sm ${value.sidos.includes(s) ? "on" : ""}`} onClick={() => set({ sidos: toggle(value.sidos, s) })}>
              {s.replace(/(특별자치도|특별자치시|광역시|특별시)$/, "")}
            </button>
          ))}
        </div>
      </div>

      <div className="f-group">
        <button className="chip" onClick={() => onChange(DEFAULT_FILTERS)}>초기화</button>
      </div>

      <div className="legend">
        <div className="f-title">범례</div>
        <div><span className="dot" style={{ background: "#d63f2e" }} /> 관련도 70+ </div>
        <div><span className="dot" style={{ background: "#e8922e" }} /> 40~69</div>
        <div><span className="dot" style={{ background: "#8c8c8c" }} /> 40 미만 / 미상</div>
        <div className="muted small">핀 크기 = 규모 · 점선 테두리 = C등급</div>
        <div className="muted small">유형: {Object.values(EVENT_LABEL).join(" · ")}</div>
      </div>
    </aside>
  );
}
