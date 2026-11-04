/** GENEQ 거점과의 직선거리 — 방문 영업 가능 여부 가늠용 (좌표는 시 중심 근사). */
export const GENEQ_SITES = [
  { key: "changwon", name: "창원 본사", lat: 35.2281, lng: 128.6811 },
  { key: "gimhae", name: "김해 공장", lat: 35.2756, lng: 128.7856 },
  { key: "asan", name: "아산 공장", lat: 36.7898, lng: 127.0018 },
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
