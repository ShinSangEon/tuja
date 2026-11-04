"use client";

import { useMemo } from "react";
import { Map, MapMarker, MarkerClusterer, useKakaoLoader } from "react-kakao-maps-sdk";
import { markerImage, priority } from "@/lib/format";

const KOREA_CENTER = { lat: 36.3, lng: 127.9 };

// 클러스터: 먹색 원 + 흰 숫자. 5건 이상이면 큰 원.
const CLUSTER_STYLES = [
  { width: "40px", height: "40px", lineHeight: "40px", borderRadius: "50%", background: "#16211F", color: "#fff", textAlign: "center", fontWeight: "800", fontSize: "14px", boxShadow: "0 0 0 3px rgba(22,33,31,0.18)" },
  { width: "48px", height: "48px", lineHeight: "48px", borderRadius: "50%", background: "#16211F", color: "#fff", textAlign: "center", fontWeight: "800", fontSize: "15px", boxShadow: "0 0 0 4px rgba(216,50,31,0.35)" },
];

const FACTORY_PIN = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="6.5" fill="#fff" fill-opacity="0.85" stroke="#16211F" stroke-width="1.5"/><rect x="6" y="6" width="6" height="6" fill="#16211F"/></svg>')}`;

const PERMIT_PIN = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><polygon points="9,2 16,15 2,15" fill="#E09A12" fill-opacity="0.9" stroke="#16211F" stroke-width="1.5" stroke-linejoin="round"/></svg>')}`;

export default function KakaoMap({ signals, selectedId, onSelect, focus, factories = [], permits = [] }) {
  const appkey = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY ?? "";
  const [loading, error] = useKakaoLoader({ appkey, libraries: ["clusterer"] });
  const located = useMemo(() => signals.filter((s) => s.lat != null && s.lng != null), [signals]);
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
    <Map center={focus ?? KOREA_CENTER} level={focus ? 7 : 12} isPanto style={{ width: "100%", height: "100%" }}>
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
      {permits.filter((p) => p.lat != null).map((p) => (
        <MapMarker key={`p${p.id}`} position={{ lat: p.lat, lng: p.lng }} image={{ src: PERMIT_PIN, size: { width: 18, height: 18 } }} title={`건축허가 · ${p.arch_gb ?? ""} ${p.main_purps ?? ""} ${p.tot_area ? Math.round(p.tot_area) + "㎡" : ""} · ${p.bld_nm ?? ""} ${p.plat_plc ?? ""}`} zIndex={0} />
      ))}
      {factories.filter((f) => f.lat != null).map((f) => (
        <MapMarker key={`f${f.id}`} position={{ lat: f.lat, lng: f.lng }} image={{ src: FACTORY_PIN, size: { width: 18, height: 18 } }} title={`기존 공장 · ${f.complex ?? "개별입지"} · ${f.address ?? ""}`} zIndex={0} />
      ))}
    </Map>
  );
}
