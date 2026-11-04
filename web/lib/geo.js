/** GENEQ 거점과의 직선거리 — 방문 영업 가능 여부 가늠용. 좌표는 실제 주소를 카카오로 지오코딩한 값.
 *  아산공장은 A/S(AM팀) 거점이라 영업 거리 계산에서는 뺀다 (sales:false). */
export const GENEQ_SITES = [
  { key: "changwon", name: "창원 본사", addr: "경남 창원시 성산구 공단로166번길 27-7", lat: 35.21296, lng: 128.64366, sales: true },
  { key: "gimhae", name: "김해 공장", addr: "경남 김해시 한림면 병동산단로 10-31", lat: 35.29090, lng: 128.79402, sales: true },
  { key: "pyeongtaek", name: "중부 사무소", addr: "경기 평택시 산단로16번길 12 M타워 217호", lat: 37.03572, lng: 127.07121, sales: true },
  { key: "asan", name: "아산 공장", addr: "충남 아산시 음봉면 산동로 145-7", lat: 36.84215, lng: 127.09703, sales: false },
];

export function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 가장 가까운 거점과 km. 좌표 없으면 null. */
export function nearestSite(lat, lng) {
  if (lat == null || lng == null) return null;
  let best = null;
  for (const s of GENEQ_SITES) {
    if (!s.sales) continue;
    const km = distanceKm(Number(lat), Number(lng), s.lat, s.lng);
    if (!best || km < best.km) best = { ...s, km: Math.round(km) };
  }
  return best;
}

/** 유틸리티 발주 예상 창: 준공 목표의 6~9개월 전. period_end 'YYYY-MM' 기준, 없으면 null. */
export function orderWindow(periodEnd) {
  const m = /^(\d{4})-(\d{2})/.exec(periodEnd ?? "");
  if (!m) return null;
  const end = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const from = new Date(end.getFullYear(), end.getMonth() - 9, 1);
  const to = new Date(end.getFullYear(), end.getMonth() - 6, 1);
  const f = (d) => `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { from, to, label: `${f(from)}~${f(to)}`, past: to < new Date() };
}
