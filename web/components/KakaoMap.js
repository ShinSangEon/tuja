"use client";

import { useEffect, useMemo, useState } from "react";
import { CustomOverlayMap, Map, MapMarker, MarkerClusterer, useKakaoLoader } from "react-kakao-maps-sdk";
import { markerImage, priority } from "@/lib/format";

const KOREA_CENTER = { lat: 36.3, lng: 127.9 };

// 클러스터: 먹색 원 + 흰 숫자. 5건 이상이면 큰 원.
const CLUSTER_STYLES = [
  { width: "40px", height: "40px", lineHeight: "40px", borderRadius: "50%", background: "#16211F", color: "#fff", textAlign: "center", fontWeight: "800", fontSize: "14px", boxShadow: "0 0 0 3px rgba(22,33,31,0.18)" },
  { width: "48px", height: "48px", lineHeight: "48px", borderRadius: "50%", background: "#16211F", color: "#fff", textAlign: "center", fontWeight: "800", fontSize: "15px", boxShadow: "0 0 0 4px rgba(216,50,31,0.35)" },
];

const PHASE_SHORT = { pms: "허가", sched: "착공예정", build: "착공", done: "사용승인" };
const fmtArea = (a) => (a ? (a >= 10000 ? `${(a / 10000).toFixed(1)}만㎡` : `${Math.round(a).toLocaleString()}㎡`) : "");
const fmtDay = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : "–");

function PermitCard({ p }) {
  const phase = p.use_apr_day ? "사용승인" : p.real_stcns_day ? "착공" : p.stcns_sched_day ? "착공 예정" : "허가";
  return (
    <>
      <div className="map-card-h"><span className="map-card-tag pm">건축허가 · {phase}</span></div>
      <div className="map-card-t">{p.bld_nm || `${p.arch_gb ?? ""} ${p.main_purps ?? "공장용지"}`.trim()}</div>
      <dl className="map-card-kv">
        <dt>구분</dt><dd>{p.arch_gb ?? "–"} · {p.main_purps ?? "용도 미기재"}</dd>
        <dt>연면적</dt><dd>{p.tot_area ? `${Math.round(p.tot_area).toLocaleString()}㎡` : "–"}{p.plat_area ? ` (대지 ${Math.round(p.plat_area).toLocaleString()}㎡)` : ""}</dd>
        <dt>허가일</dt><dd>{fmtDay(p.pms_day)}</dd>
        <dt>착공</dt><dd>{p.real_stcns_day ? fmtDay(p.real_stcns_day) : p.stcns_sched_day ? `예정 ${fmtDay(p.stcns_sched_day)}` : "–"}{p.use_apr_day ? ` · 사용승인 ${fmtDay(p.use_apr_day)}` : ""}</dd>
        <dt>위치</dt><dd>{p.plat_plc ?? "–"}{p.jiyuk ? ` · ${p.jiyuk}` : ""}</dd>
      </dl>
      <p className="map-card-note">출처 국토교통부 건축HUB. 허가→착공 사이가 설비 사양이 정해지는 시점.</p>
    </>
  );
}

function FactoryCard({ f }) {
  return (
    <>
      <div className="map-card-h"><span className="map-card-tag fac">기존 등록공장</span></div>
      <div className="map-card-t">{f.company_raw ?? "기존 공장"}</div>
      <dl className="map-card-kv">
        <dt>산단</dt><dd>{f.complex ?? "개별입지"}</dd>
        <dt>생산품</dt><dd>{f.products ?? "–"}</dd>
        <dt>주소</dt><dd>{f.address ?? "–"}</dd>
      </dl>
      <p className="map-card-note">출처 한국산업단지공단 전국등록공장현황 2025.12</p>
    </>
  );
}

export default function KakaoMap({ signals, selectedId, onSelect, focus, factories = [], permits = [] }) {
  const appkey = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY ?? "";
  const [loading, error] = useKakaoLoader({ appkey, libraries: ["clusterer"] });
  const located = useMemo(() => signals.filter((s) => s.lat != null && s.lng != null), [signals]);
  const [map, setMap] = useState(null);
  const [active, setActive] = useState(null); // 클릭한 건축허가/기존공장 카드
  // 선택한 신호로 이동: center/level 을 prop 으로 동시에 바꾸면 SDK 가 확대만 하고 이동을 건너뛰는 경우가 있어 직접 제어한다.
  const fLat = focus?.lat ?? null, fLng = focus?.lng ?? null;
  useEffect(() => {
    if (!map || fLat == null || fLng == null || !window.kakao?.maps) return;
    const ll = new window.kakao.maps.LatLng(Number(fLat), Number(fLng));
    if (map.getLevel() > 7) map.setLevel(7, { anchor: ll });
    map.panTo(ll);
  }, [map, fLat, fLng]);
  const hotIds = useMemo(() => new Set(located.filter((s) => priority(s.relevance_score) === "hot").map((s) => s.id)), [located]);

  if (!appkey) {
    return (
      <div className="map-empty">
        <strong>지도 키가 없습니다</strong>
        <p>배포 환경변수 <code>NEXT_PUBLIC_KAKAO_MAP_KEY</code>를 넣으면 지도가 뜹니다. 목록은 지도 없이도 동작합니다.</p>
      </div>
    );
  }
  if (error) return <div className="map-empty"><strong>지도를 불러오지 못했습니다</strong><p>카카오 앱의 Web 플랫폼에 이 주소가 등록돼 있는지 확인하세요.</p></div>;
  if (loading) return <div className="map-empty"><p>지도 불러오는 중</p></div>;

  return (
    <Map center={KOREA_CENTER} level={12} onCreate={setMap} onClick={() => setActive(null)} style={{ width: "100%", height: "100%" }}>
      <MarkerClusterer
        averageCenter
        minLevel={7}
        gridSize={64}
        styles={CLUSTER_STYLES}
        calculator={[5]}
      >
        {located.map((s) => {
          const sel = s.id === selectedId;
          const img = markerImage(s, sel);
          return (
            <MapMarker
              key={s.id}
              position={{ lat: s.lat, lng: s.lng }}
              image={{ src: img.src, size: { width: img.width, height: img.height }, options: { offset: { x: img.offsetX, y: img.offsetY } } }}
              title={`${s.company_name} · ${s.sigungu ?? s.sido ?? ""}`}
              zIndex={sel ? 100 : hotIds.has(s.id) ? 10 : 1}
              onClick={() => onSelect(s)}
            />
          );
        })}
      </MarkerClusterer>
      {permits.filter((p) => p.lat != null).map((p) => {
        const ph = p.use_apr_day ? "done" : p.real_stcns_day ? "build" : p.stcns_sched_day ? "sched" : "pms";
        return (
          <CustomOverlayMap key={`p${p.id}`} position={{ lat: p.lat, lng: p.lng }} yAnchor={1} zIndex={active?.id === p.id ? 60 : 2}>
            <button className={`pm-pin ${ph} ${active?.id === p.id ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); setActive({ kind: "permit", id: p.id, item: p }); }} title="건축허가 — 눌러서 내용 보기">
              <span className="pm-pin-k">{PHASE_SHORT[ph]}</span>{p.arch_gb ?? "허가"} {fmtArea(p.tot_area)}
            </button>
          </CustomOverlayMap>
        );
      })}
      {factories.filter((f) => f.lat != null).map((f) => (
        <CustomOverlayMap key={`f${f.id}`} position={{ lat: f.lat, lng: f.lng }} yAnchor={1} zIndex={active?.id === f.id ? 60 : 1}>
          <button className={`fac-pin ${active?.id === f.id ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); setActive({ kind: "factory", id: f.id, item: f }); }} title="이 회사의 기존 등록공장 — 눌러서 내용 보기">기존 공장</button>
        </CustomOverlayMap>
      ))}
      {active && (
        <CustomOverlayMap position={{ lat: active.item.lat, lng: active.item.lng }} yAnchor={1.18} zIndex={100}>
          <div className="map-card" onClick={(e) => e.stopPropagation()}>
            <button className="map-card-x" onClick={() => setActive(null)} aria-label="닫기">×</button>
            {active.kind === "permit" ? <PermitCard p={active.item} /> : <FactoryCard f={active.item} />}
          </div>
        </CustomOverlayMap>
      )}
    </Map>
  );
}
