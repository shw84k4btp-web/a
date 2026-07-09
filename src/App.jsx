import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { searchToilets } from './api/overpass.js';
import { getWalkingRoute } from './api/routing.js';
import { geocodeAddress } from './api/geocode.js';

// 検索半径: 見つからなければ自動的に広げる (m)
const SEARCH_RADII = [500, 1000, 2000, 4000];
const DEFAULT_CENTER = [35.6812, 139.7671]; // 東京駅 (現在地取得前の仮表示)

const userIcon = L.divIcon({
  className: 'user-marker',
  html: '<div class="user-marker-dot"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function toiletIcon(selected) {
  return L.divIcon({
    className: 'toilet-marker',
    html: `<div class="toilet-marker-pin${selected ? ' selected' : ''}">🚻</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 34],
  });
}

function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function formatDuration(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  return min >= 60 ? `約${Math.floor(min / 60)}時間${min % 60}分` : `約${min}分`;
}

function toiletName(t) {
  return t.tags.name || t.tags['name:ja'] || '公衆トイレ';
}

function toiletDetails(t) {
  const d = [];
  if (t.tags.wheelchair === 'yes') d.push('♿ 車椅子対応');
  if (t.tags.fee === 'yes') d.push('💰 有料');
  if (t.tags.fee === 'no') d.push('無料');
  if (t.tags.opening_hours) d.push(`🕐 ${t.tags.opening_hours}`);
  if (t.tags.changing_table === 'yes') d.push('🚼 おむつ交換台');
  return d;
}

export default function App() {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null); // L.layerGroup (トイレマーカー)
  const userMarkerRef = useRef(null);
  const routeLineRef = useRef(null);
  const routeSeqRef = useRef(0); // 古いルート取得結果を破棄するための連番

  const [origin, setOrigin] = useState(null); // {lat, lng, label}
  const [locationDenied, setLocationDenied] = useState(false);
  const [status, setStatus] = useState({ type: 'loading', text: '現在地を取得しています…' });
  const [toilets, setToilets] = useState([]);
  const [usedRadius, setUsedRadius] = useState(null);
  const [selected, setSelected] = useState(null); // 選択中のトイレ
  const [route, setRoute] = useState(null); // {coords, distance, duration, approximate}
  const [routeLoading, setRouteLoading] = useState(false);
  const [address, setAddress] = useState('');
  const [geocoding, setGeocoding] = useState(false);

  // ---- 地図の初期化 ----
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: false }).setView(DEFAULT_CENTER, 15);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // ---- 起動時に現在地を取得 ----
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationDenied(true);
      setStatus({ type: 'error', text: 'この端末では位置情報を利用できません。住所を入力してください。' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: '現在地' });
      },
      () => {
        setLocationDenied(true);
        setStatus({
          type: 'error',
          text: '位置情報を取得できませんでした。住所や駅名を入力して検索できます。',
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  // ---- 出発地点が決まったら地図を移動してトイレを検索 ----
  const runSearch = useCallback(async (o) => {
    const map = mapRef.current;
    map.setView([o.lat, o.lng], 16);

    if (userMarkerRef.current) userMarkerRef.current.remove();
    userMarkerRef.current = L.marker([o.lat, o.lng], { icon: userIcon, zIndexOffset: 1000 })
      .addTo(map)
      .bindTooltip(o.label, { direction: 'top', offset: [0, -12] });

    setToilets([]);
    setSelected(null);
    setRoute(null);
    setUsedRadius(null);

    // 半径を段階的に広げながら検索
    for (const radius of SEARCH_RADII) {
      setStatus({ type: 'loading', text: `半径 ${radius}m 以内のトイレを検索中…` });
      let found;
      try {
        found = await searchToilets(o.lat, o.lng, radius);
      } catch {
        setStatus({
          type: 'error',
          text: 'トイレ情報の取得に失敗しました。通信状況を確認して再試行してください。',
          retry: true,
        });
        return;
      }
      if (found.length > 0) {
        setToilets(found);
        setUsedRadius(radius);
        setStatus({
          type: 'ok',
          text: `半径 ${radius}m 以内に ${found.length} 件のトイレが見つかりました。マーカーをタップするとルートを表示します。`,
        });
        return;
      }
    }
    setStatus({
      type: 'warn',
      text: `半径 ${SEARCH_RADII[SEARCH_RADII.length - 1] / 1000}km まで探しましたが、トイレが見つかりませんでした。`,
    });
  }, []);

  useEffect(() => {
    if (origin) runSearch(origin);
  }, [origin, runSearch]);

  // ---- トイレ選択 → 徒歩ルート取得 ----
  const selectToilet = useCallback(
    async (toilet) => {
      setSelected(toilet);
      setRoute(null);
      setRouteLoading(true);
      const seq = ++routeSeqRef.current;
      const r = await getWalkingRoute(origin, toilet); // 内部でフォールバックするため throw しない
      if (seq !== routeSeqRef.current) return; // 別のマーカーが選ばれた後の古い結果は捨てる
      setRoute(r);
      setRouteLoading(false);
      const map = mapRef.current;
      const line = L.polyline(r.coords, {
        color: '#2563eb',
        weight: 5,
        opacity: 0.85,
        dashArray: r.approximate ? '8 8' : null,
      });
      if (routeLineRef.current) routeLineRef.current.remove();
      routeLineRef.current = line.addTo(map);
      map.fitBounds(line.getBounds(), { padding: [60, 60] });
    },
    [origin]
  );

  // ---- マーカーの描画 ----
  useEffect(() => {
    const layer = markersRef.current;
    if (!layer) return;
    layer.clearLayers();
    toilets.forEach((t) => {
      L.marker([t.lat, t.lng], { icon: toiletIcon(selected?.id === t.id) })
        .addTo(layer)
        .bindTooltip(toiletName(t), { direction: 'top', offset: [0, -30] })
        .on('click', () => selectToilet(t));
    });
  }, [toilets, selected, selectToilet]);

  // ---- 選択解除時にルート線を消す ----
  useEffect(() => {
    if (!selected && routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }
  }, [selected]);

  // ---- 住所検索 (位置情報が使えない場合の代替) ----
  async function handleAddressSubmit(e) {
    e.preventDefault();
    if (!address.trim() || geocoding) return;
    setGeocoding(true);
    try {
      const result = await geocodeAddress(address.trim());
      if (!result) {
        setStatus({ type: 'error', text: `「${address}」が見つかりませんでした。別の表記で試してください。` });
      } else {
        setLocationDenied(false);
        setOrigin({ lat: result.lat, lng: result.lng, label: result.label.split(',')[0] });
      }
    } catch {
      setStatus({ type: 'error', text: '住所検索に失敗しました。時間をおいて再試行してください。' });
    } finally {
      setGeocoding(false);
    }
  }

  const isLoading = status.type === 'loading';

  return (
    <div className="app">
      <header className="header">
        <h1>🚻 トイレファインダー</h1>
        {origin && (
          <button className="btn-small" onClick={() => runSearch(origin)} disabled={isLoading}>
            再検索
          </button>
        )}
      </header>

      <div ref={mapEl} className="map" />

      {/* ステータスバー */}
      <div className={`status status-${status.type}`}>
        {isLoading && <span className="spinner" />}
        <span>{status.text}</span>
        {status.retry && origin && (
          <button className="btn-small" onClick={() => runSearch(origin)}>
            再試行
          </button>
        )}
      </div>

      {/* 位置情報が使えない場合の住所入力 */}
      {(locationDenied || !origin) && !isLoading && (
        <form className="address-form" onSubmit={handleAddressSubmit}>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="住所・駅名・施設名を入力 (例: 新宿駅)"
            aria-label="住所検索"
          />
          <button type="submit" disabled={geocoding || !address.trim()}>
            {geocoding ? '検索中…' : '検索'}
          </button>
        </form>
      )}

      {/* 選択中トイレの詳細 + ルート情報 */}
      {selected && (
        <div className="route-panel">
          <div className="route-panel-head">
            <strong>{toiletName(selected)}</strong>
            <button className="btn-close" onClick={() => setSelected(null)} aria-label="閉じる">
              ✕
            </button>
          </div>
          {toiletDetails(selected).length > 0 && (
            <div className="toilet-tags">
              {toiletDetails(selected).map((d) => (
                <span key={d} className="tag">{d}</span>
              ))}
            </div>
          )}
          {routeLoading && (
            <div className="route-info">
              <span className="spinner" /> 徒歩ルートを検索中…
            </div>
          )}
          {route && (
            <div className="route-info">
              <span className="route-stat">🚶 {formatDistance(route.distance)}</span>
              <span className="route-stat">⏱ {formatDuration(route.duration)}</span>
              {route.approximate && (
                <span className="route-note">※ ルート検索に失敗したため直線距離での概算です</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
