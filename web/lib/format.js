// 투자 레이더 공용 상수·포맷 (JS)

export const STAGE_ORDER = ["disclosure", "mou", "permit", "construction", "completed"];
export const STAGE_LABEL = { disclosure: "공시", mou: "투자협약", permit: "인허가", construction: "착공", completed: "준공" };
export const EVENT_LABEL = { new_plant: "신공장", expansion: "증설", retrofit: "개조·스마트화", equipment: "설비투자", relocation: "이전", other: "기타" };
export const SIZE_LABEL = { S: "소규모 · 50억 미만", M: "중규모 · 50~500억", L: "대규모 · 500억 이상", U: "규모 미상" };
export const SIZE_SHORT = { S: "소", M: "중", L: "대", U: "?" };
export const CONTACT_STATUS = ["none", "planned", "contacted", "meeting", "quoted", "won", "lost"];
export const CONTACT_LABEL = { none: "미접촉", planned: "접촉 예정", contacted: "접촉함", meeting: "미팅", quoted: "견적 제출", won: "수주", lost: "탈락" };
export const KIND_LABEL = { note: "메모", call: "전화", visit: "방문", quote: "견적", status_change: "변경" };
export const GRADE_LABEL = { A: "공식 출처", B: "교차 확인", C: "미확인 보도" };
// collector/config.py TIER2_PRESS 와 맞춰 둘 것
export const TIER2_PRESS = ["연합뉴스","뉴시스","뉴스1","한국경제","매일경제","서울경제","머니투데이","아시아경제","이데일리","전자신문","조선비즈","중앙일보","동아일보","경향신문","한겨레","파이낸셜뉴스","헤럴드경제","KBS","MBC","SBS","YTN","연합인포맥스","부산일보","국제신문","경남신문","경남일보","경남도민일보","매일신문","영남일보","경북일보","경상일보","울산매일","대전일보","중도일보","충청투데이","광주일보","전남일보","전북일보","경인일보","중부일보","인천일보","강원일보"];

export const SIDO_LIST = [
  "경상남도", "경상북도", "울산광역시", "부산광역시", "대구광역시",
  "충청남도", "충청북도", "대전광역시", "세종특별자치시",
  "경기도", "인천광역시", "서울특별시",
  "전라남도", "전북특별자치도", "광주광역시",
  "강원특별자치도", "제주특별자치도",
];
export const sidoShort = (s) => (s || "").replace(/(특별자치도|특별자치시|광역시|특별시)$/, "").replace(/도$/, (m, _, str) => (str && str.length <= 3 ? "" : m));
export function sidoName(s) {
  if (!s) return "미상";
  return s.replace("경상남도", "경남").replace("경상북도", "경북").replace("충청남도", "충남").replace("충청북도", "충북")
    .replace("전라남도", "전남").replace("전북특별자치도", "전북").replace("강원특별자치도", "강원").replace("제주특별자치도", "제주")
    .replace("세종특별자치시", "세종").replace(/(광역시|특별시)$/, "").replace("경기도", "경기");
}

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

/** 우선순위: hot(70+) / watch(40~69) / low */
export function priority(score) {
  if (score >= 70) return "hot";
  if (score >= 40) return "watch";
  return "low";
}
export const PRIORITY_LABEL = { hot: "즉시 검토", watch: "모니터링", low: "보관" };
export const PRIORITY_COLOR = { hot: "#D8321F", watch: "#E09A12", low: "#8E969B" };
export function scoreColor(score) {
  return PRIORITY_COLOR[priority(score)];
}

/** 규모 → 핀 지름(px) */
export function sizeRadius(size) {
  return ({ L: 34, M: 27, S: 21, U: 21 })[size] ?? 21;
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 마커 SVG (data URI). 원 안에 점수, 크기=규모, 색=우선순위, 테두리=등급(A 굵은 먹색 / B 가는 먹색 / C 점선).
 * 70점 이상은 회사명 라벨을 오른쪽에 붙인다. 반환: { src, width, height, offsetX, offsetY }
 */
export const CUSTOMER_COLOR = "#2457C5"; // 기존 거래처(드라이어 납품 이력) = 파랑

export function markerImage(s, selected = false) {
  const d = sizeRadius(s.size_class);
  const isCust = !!s.customer_name;
  const color = isCust ? CUSTOMER_COLOR : scoreColor(s.relevance_score);
  const g = grade(s);
  const p = priority(s.relevance_score);
  const strokeW = g === "A" ? 3 : 2;
  const dash = g === "C" ? ` stroke-dasharray="3 2"` : "";
  const ring = selected ? 8 : 0;
  const label = p === "hot" || isCust ? String(s.company_name).replace(/^\(주\)|^㈜|^주식회사\s*/, "").slice(0, 10) : "";
  const fontPx = d >= 30 ? 13 : d >= 25 ? 12 : 10;
  const labelW = label ? Math.min(150, 14 + label.length * 12.5) : 0;
  const W = d + ring * 2 + 4 + (label ? labelW + 6 : 0);
  const H = d + ring * 2 + 4;
  const cx = ring + 2 + d / 2, cy = H / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${selected ? `<circle cx="${cx}" cy="${cy}" r="${d / 2 + ring - 1}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.5"/>` : ""}
  <circle cx="${cx}" cy="${cy}" r="${d / 2}" fill="${color}" stroke="#16211F" stroke-width="${strokeW}"${dash}/>
  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif" font-size="${fontPx}" font-weight="800" fill="#fff">${s.relevance_score}</text>
  ${label ? `<rect x="${cx + d / 2 + 3}" y="${cy - 11}" width="${labelW}" height="22" rx="4" fill="${isCust ? CUSTOMER_COLOR : "#16211F"}" fill-opacity="0.92"/>
  <text x="${cx + d / 2 + 10}" y="${cy}" dominant-baseline="central" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif" font-size="12" font-weight="700" fill="#fff">${esc(label)}</text>` : ""}
</svg>`;
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: W, height: H, offsetX: cx, offsetY: cy };
}

export function stageIndex(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i < 0 ? 0 : i;
}


/**
 * 설비 추정 (참고용 휴리스틱). 업종 × 규모 → 예상 압축기 총용량, 드라이어 타입, 비고.
 * 근거: 업종별 압축공기 원단위 경험치. 실제 제안 전 현장 확인 필요.
 */
const EST = {
  clean:   { L: "1,000kW+ (다수 대형 무급유)", M: "300~1,000kW", S: "75~300kW", U: "규모 미상", dryer: "흡착식 저노점(−40~−70℃) 필수", note: "클린 공정 — 무급유(Oil-free) 압축기, 고효율 필터 세트" },
  gmp:     { L: "500~1,500kW", M: "150~500kW", S: "37~150kW", U: "규모 미상", dryer: "흡착식(−40℃) + 제균 필터", note: "GMP — 무급유 권장, 에어 품질 ISO 8573-1 Class 1~2" },
  general: { L: "500~2,000kW", M: "150~500kW", S: "37~150kW", U: "규모 미상", dryer: "냉동식 기본, 도장·분체는 흡착식", note: "급유식 가능, 인버터·대수제어 제안" },
  heavy:   { L: "1,000~3,000kW", M: "300~1,000kW", S: "75~300kW", U: "규모 미상", dryer: "냉동식 + 계장용 흡착식", note: "계장용 공기(IA) 별도 라인, 대용량 원심식 검토" },
  light:   { L: "100~300kW", M: "37~100kW", S: "~37kW", U: "규모 미상", dryer: "냉동식", note: "수요 낮음, 소형 스크류" },
};
const SECTOR_CLASS = { "반도체": "clean", "디스플레이": "clean", "이차전지": "clean", "전자부품": "clean", "제약·바이오": "gmp", "식품·음료": "gmp",
  "자동차·부품": "general", "기계·장비": "general", "섬유": "general", "항공·방산": "general", "조선·해양": "heavy", "철강·금속": "heavy", "화학·소재": "heavy", "에너지": "heavy",
  "물류·창고": "light", "데이터센터": "light", "기타": "general" };
export function estimateUtility(s) {
  const cls = SECTOR_CLASS[s.sector] ?? "general";
  const e = EST[cls];
  return { air: e[s.size_class] ?? e.U, dryer: e.dryer, note: e.note };
}
