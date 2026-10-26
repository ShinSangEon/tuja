"use client";

import { Map, MapMarker, MarkerClusterer, useKakaoLoader } from "react-kakao-maps-sdk";
import { markerDataUri, sizeRadius } from "@/lib/format";

const KOREA_CENTER = { lat: 36.2, lng: 127.8 };

export default function KakaoMap({
  signals,
  selectedId,
  onSelect,
}) {
  const appkey = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY ?? "";
  const [loading, error] = useKakaoLoader({ appkey, libraries: ["clusterer"] });

  if (!appkey) {
    return (
      <div className="map-placeholder">
        <strong>카카오맵 키가 없습니다.</strong>
        <p>
          <code>web/.env.local</code> 에 <code>NEXT_PUBLIC_KAKAO_MAP_KEY</code> 를 넣으면 지도가 뜹니다.
          <br />
          (developers.kakao.com → 앱 → JavaScript 키, 플랫폼 Web에 http://localhost:3000 등록)
        </p>
        <p className="muted">지도 없이도 오른쪽 목록은 동작합니다. 현재 {signals.length}건.</p>
      </div>
    );
  }
  if (error) return <div className="map-placeholder">지도 로드 실패: 도메인 등록 또는 키를 확인하세요. ({String(error)})</div>;
  if (loading) return <div className="map-placeholder">지도 불러오는 중…</div>;

  const located = signals.filter((s) => s.lat != null && s.lng != null);

  return (
    <Map center={KOREA_CENTER} level={13} style={{ width: "100%", height: "100%" }}>
      <MarkerClusterer averageCenter minLevel={8} gridSize={70}>
        {located.map((s) => {
          const d = sizeRadius(s.size_class) + 4;
          const sel = s.id === selectedId;
          return (
            <MapMarker
              key={s.id}
              position={{ lat: s.lat, lng: s.lng }}
              image={{ src: markerDataUri(s), size: { width: d, height: d } }}
              title={`${s.company_name} · ${s.sigungu ?? s.sido ?? ""}`}
              zIndex={sel ? 10 : s.relevance_score >= 70 ? 5 : 1}
              onClick={() => onSelect(s)}
            />
          );
        })}
      </MarkerClusterer>
    </Map>
  );
}
