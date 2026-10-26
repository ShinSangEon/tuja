// 투자 레이더 공용 상수·포맷 (JS)

export const STAGE_LABEL = {
  disclosure: "공시",
  mou: "투자협약",
  permit: "인허가",
  construction: "착공",
  completed: "준공",
};

export const EVENT_LABEL = {
  new_plant: "신공장",
  expansion: "증설",
  retrofit: "개조·스마트화",
  equipment: "설비투자",
  relocation: "이전",
  other: "기타",
};

export const SIZE_LABEL = {
  S: "소규모 (50억 미만)",
  M: "중규모 (50~500억)",
  L: "대규모 (500억+)",
  U: "규모 미상",
};

export const SIDO_LIST = [
  "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시",
  "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도", "전북특별자치도", "전라남도",
  "경상북도", "경상남도", "제주특별자치도",
];


/** 원 → "2,200억" / "350억" / "48억" / "3.5억" */
export function fmtKrw(v) {
  if (!v) return "금액 미상";
  const eok = v / 100_000_000;
  if (eok >= 10_000) return `${(eok / 10_000).toFixed(1).replace(/\.0$/, "")}조`;
  if (eok >= 100) return `${Math.round(eok).toLocaleString()}억`;
  if (eok >= 1) return `${eok.toFixed(eok < 10 ? 1 : 0).replace(/\.0$/, "")}억`;
  return `${Math.round(v / 10_000).toLocaleString()}만원`;
}

export function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export function grade(s) {
  return s.effective_grade ?? s.manual_grade ?? s.grade;
}

/** 관련도 → 색. 70+ 빨강, 40~69 주황, 미만 회색 */
export function scoreColor(score) {
  if (score >= 70) return "#d63f2e";
  if (score >= 40) return "#e8922e";
  return "#8c8c8c";
}

/** 규모 → 핀 지름(px) */
export function sizeRadius(size) {
  return ({ L: 22, M: 16, S: 11, U: 11 })[size] ?? 11;
}

/** 마커 이미지 (SVG data URI). 색=관련도, 크기=규모, 테두리=등급 */
export function markerDataUri(s) {
  const d = sizeRadius(s.size_class);
  const color = scoreColor(s.relevance_score);
  const g = grade(s);
  const stroke = g === "A" ? "#1a1a1a" : g === "B" ? "#555" : "#bbb";
  const dash = g === "C" ? ` stroke-dasharray="2 2"` : "";
  const opacity = s.size_class === "U" ? 0.55 : 0.9;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d + 4}" height="${d + 4}"><circle cx="${(d + 4) / 2}" cy="${(d + 4) / 2}" r="${d / 2}" fill="${color}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="2"${dash}/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function needDots(n) {
  return "●".repeat(n) + "○".repeat(3 - n);
}
