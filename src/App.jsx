import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { searchToilets } from './api/overpass.js';
import { getWalkingRoute, haversine } from './api/routing.js';
import { geocodeAddress } from './api/geocode.js';
import { getCurrentPosition } from './api/location.js';

// 検索半径: 見つからなければ自動的に広げる (m)
const SEARCH_RADII = [500, 1000, 2000, 4000];
const DEFAULT_CENTER = [35.6812, 139.7671]; // 東京駅 (現在地取得前の仮表示)
const WALK_SPEED_MPS = 1.33; // 徒歩 80m/分

const userIcon = L.divIcon({
  className: 'user-marker',
  html: '<div class="user-marker-dot"><div class="user-marker-pulse"></div></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function toiletIcon(selected) {
  return L.divIcon({
    className: 'toilet-marker',
    html: `<div class="toilet-marker-pin${selected ? ' selected' : ''}">🚻</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 36],
  });
}

function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function formatMinutes(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

// 現在時刻 + 所要時間から到着時刻 "HH:MM" を計算
function arrivalTime(sec) {
  const t = new Date(Date.now() + sec * 1000);
  return t.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
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

// ボトムシートのスナップ位置 (画面の高さに対する割合)
const SHEET_SNAPS = [0.22, 0.45, 0.82];

export default function App() {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const userMarkerRef = useRef(null);
  const routeLayerRef = useRef(null); // ルート線 (縁取り + 本線)
  // 遅延して届いた古い応答が UI を上書きしないよう、リクエストに世代番号を振る
  const routeSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  const [origin, setOrigin] = useState(null); // {lat, lng, label}
  const [locationDenied, setLocationDenied] = useState(false);
  const [status, setStatus] = useState({ type: 'loading', text: '現在地を取得しています…' });
  const [toilets, setToilets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [route, setRoute] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [address, setAddress] = useState('');
  const [geocoding, setGeocoding] = useState(false);

  // ボトムシート (Google Maps 風のドラッグ操作)
  const [sheetRatio, setSheetRatio] = useState(SHEET_SNAPS[1]);
  const dragRef = useRef(null);
  const sheetDragging = useRef(false);

  // ---- 地図の初期化 ----
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: false }).setView(DEFAULT_CENTER, 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // ---- 起動時に現在地を取得 (iOSネイティブ / Web 両対応) ----
  useEffect(() => {
    let cancelled = false;
    getCurrentPosition()
      .then((pos) => {
        if (!cancelled) setOrigin({ ...pos, label: '現在地' });
      })
      .catch(() => {
        if (cancelled) return;
        setLocationDenied(true);
        setStatus({
          type: 'error',
          text: '位置情報を取得できませんでした。住所や駅名を入力して検索できます。',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 出発地点が決まったら地図を移動してトイレを検索 ----
  const runSearch = useCallback(async (o) => {
    // 進行中の検索・ルート取得を世代番号で無効化してから新しい検索を始める
    const seq = ++searchSeqRef.current;
    routeSeqRef.current++;

    const map = mapRef.current;
    map.setView([o.lat, o.lng], 16);

    if (userMarkerRef.current) userMarkerRef.current.remove();
    userMarkerRef.current = L.marker([o.lat, o.lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(map);

    setToilets([]);
    setSelected(null);
    setRoute(null);

    for (const radius of SEARCH_RADII) {
      setStatus({ type: 'loading', text: `半径 ${radius}m 以内のトイレを検索中…` });
      let found;
      try {
        found = await searchToilets(o.lat, o.lng, radius);
      } catch {
        if (seq !== searchSeqRef.current) return;
        setStatus({
          type: 'error',
          text: 'トイレ情報の取得に失敗しました。通信状況を確認してください。',
          retry: true,
        });
        return;
      }
      if (seq !== searchSeqRef.current) return; // 新しい検索が始まっていたら破棄
      if (found.length > 0) {
        // 近い順に並べて直線距離を付与 (一覧表示用)
        const withDist = found
          .map((t) => ({ ...t, crowDist: haversine(o, t) }))
          .sort((a, b) => a.crowDist - b.crowDist);
        setToilets(withDist);
        setStatus({ type: 'ok', text: `${withDist.length} 件見つかりました (半径 ${radius}m)` });
        return;
      }
    }
    setStatus({
      type: 'warn',
      text: `半径 ${SEARCH_RADII[SEARCH_RADII.length - 1] / 1000}km 以内にトイレが見つかりませんでした。`,
    });
  }, []);

  useEffect(() => {
    if (origin) runSearch(origin);
  }, [origin, runSearch]);

  // ---- トイレ選択 → 実際の道路に沿った徒歩ルートを取得 ----
  const selectToilet = useCallback(
    async (toilet) => {
      setSelected(toilet);
      setRoute(null);
      setRouteLoading(true);
      setSheetRatio(SHEET_SNAPS[1]);
      const seq = ++routeSeqRef.current;
      const r = await getWalkingRoute(origin, toilet); // 内部でフォールバックするため throw しない
      // 別のマーカー選択・✕での選択解除・再検索が起きていたら破棄
      // (これがないと閉じた後に幽霊ルートが描画され fitBounds で地図が飛ぶ)
      if (seq !== routeSeqRef.current) return;
      setRoute(r);
      setRouteLoading(false);

      const map = mapRef.current;
      if (routeLayerRef.current) routeLayerRef.current.remove();
      // Google Maps 風: 白い縁取り + 青い本線の二重ポリライン
      const casing = L.polyline(r.coords, { color: '#ffffff', weight: 10, opacity: 0.9 });
      const line = L.polyline(r.coords, {
        color: '#1a73e8',
        weight: 6,
        opacity: 0.95,
        dashArray: r.approximate ? '10 10' : null,
        lineCap: 'round',
        lineJoin: 'round',
      });
      routeLayerRef.current = L.layerGroup([casing, line]).addTo(map);
      // ボトムシートに隠れないよう下側に余白を取って全体表示
      map.fitBounds(line.getBounds(), {
        paddingTopLeft: [48, 140],
        paddingBottomRight: [48, window.innerHeight * SHEET_SNAPS[1] + 40],
      });
    },
    [origin]
  );

  // ---- マーカーの描画 ----
  useEffect(() => {
    const layer = markersRef.current;
    if (!layer) return;
    layer.clearLayers();
    toilets.forEach((t) => {
      L.marker([t.lat, t.lng], {
        icon: toiletIcon(selected?.id === t.id),
        zIndexOffset: selected?.id === t.id ? 500 : 0,
      })
        .addTo(layer)
        .on('click', () => selectToilet(t));
    });
  }, [toilets, selected, selectToilet]);

  // ---- ルート案内を閉じる (進行中のルート取得も世代番号で無効化) ----
  const closeRoute = useCallback(() => {
    routeSeqRef.current++;
    setSelected(null);
    setRoute(null);
    setRouteLoading(false);
  }, []);

  // ---- 選択解除時にルート線を消す ----
  useEffect(() => {
    if (!selected && routeLayerRef.current) {
      routeLayerRef.current.remove();
      routeLayerRef.current = null;
    }
  }, [selected]);

  // ---- 到着時刻が古くならないよう、ルート表示中は30秒ごとに再計算 ----
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!route) return;
    const id = setInterval(() => setClockTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [route]);

  // ---- ボトムシートのドラッグ ----
  function onSheetPointerDown(e) {
    sheetDragging.current = true;
    dragRef.current = { startY: e.clientY, startRatio: sheetRatio };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onSheetPointerMove(e) {
    if (!sheetDragging.current || !dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY;
    const ratio = Math.min(0.9, Math.max(0.12, dragRef.current.startRatio + dy / window.innerHeight));
    setSheetRatio(ratio);
  }
  function onSheetPointerUp() {
    if (!sheetDragging.current) return;
    sheetDragging.current = false;
    setSheetRatio((r) =>
      SHEET_SNAPS.reduce((best, s) => (Math.abs(s - r) < Math.abs(best - r) ? s : best))
    );
  }

  // ---- 現在地に戻る ----
  function recenter() {
    if (origin) mapRef.current.setView([origin.lat, origin.lng], 16);
  }

  // ---- 住所検索 (位置情報が使えない場合の代替) ----
  async function handleAddressSubmit(e) {
    e.preventDefault();
    if (!address.trim() || geocoding) return;
    setGeocoding(true);
    try {
      const result = await geocodeAddress(address.trim());
      if (!result) {
        setStatus({ type: 'error', text: `「${address}」が見つかりませんでした。` });
      } else {
        // locationDenied は維持する (別の住所で再検索する入口を残すため)
        setOrigin({ lat: result.lat, lng: result.lng, label: result.label.split(',')[0] });
      }
    } catch {
      setStatus({ type: 'error', text: '住所検索に失敗しました。時間をおいて再試行してください。' });
    } finally {
      setGeocoding(false);
    }
  }

  const isLoading = status.type === 'loading';
  const showSheet = origin && (toilets.length > 0 || selected);

  return (
    <div className="app">
      <div ref={mapEl} className="map" />

      {/* 上部: グラスのステータスバー */}
      <div className="topbar glass">
        <span className="topbar-icon">🚻</span>
        <div className="topbar-text">
          <div className="topbar-title">トイレファインダー</div>
          <div className={`topbar-status status-${status.type}`}>
            {isLoading && <span className="spinner" />}
            {status.text}
            {status.retry && origin && (
              <button className="link-btn" onClick={() => runSearch(origin)}>再試行</button>
            )}
          </div>
        </div>
        {origin && (
          <button
            className="icon-btn"
            onClick={() => runSearch(origin)}
            disabled={isLoading}
            aria-label="再検索"
            title="再検索"
          >
            ⟳
          </button>
        )}
      </div>

      {/* 位置情報が使えない場合の住所入力 */}
      {(locationDenied || !origin) && !isLoading && (
        <form className="address-form glass" onSubmit={handleAddressSubmit}>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="住所・駅名を入力 (例: 新宿駅)"
            aria-label="住所検索"
          />
          <button type="submit" disabled={geocoding || !address.trim()}>
            {geocoding ? '…' : '検索'}
          </button>
        </form>
      )}

      {/* 現在地ボタン */}
      {origin && (
        <button
          className="fab glass"
          style={{ bottom: `calc(${showSheet ? sheetRatio * 100 : 0}% + 20px + env(safe-area-inset-bottom))` }}
          onClick={recenter}
          aria-label="現在地に戻る"
        >
          ◉
        </button>
      )}

      {/* ボトムシート: トイレ一覧 / ルート案内 */}
      {showSheet && (
        <div
          className={`sheet glass${sheetDragging.current ? ' dragging' : ''}`}
          style={{ height: `${sheetRatio * 100}%` }}
        >
          <div
            className="sheet-handle-area"
            onPointerDown={onSheetPointerDown}
            onPointerMove={onSheetPointerMove}
            onPointerUp={onSheetPointerUp}
            onPointerCancel={onSheetPointerUp}
          >
            <div className="sheet-handle" />
          </div>

          {!selected ? (
            /* ---- 一覧モード: 近い順 ---- */
            <>
              <div className="sheet-title">近くのトイレ ({toilets.length}件)</div>
              <div className="sheet-scroll">
                {toilets.map((t) => (
                  <button key={t.id} className="toilet-row" onClick={() => selectToilet(t)}>
                    <span className="toilet-row-icon">🚻</span>
                    <span className="toilet-row-main">
                      <span className="toilet-row-name">{toiletName(t)}</span>
                      {toiletDetails(t).length > 0 && (
                        <span className="toilet-row-tags">{toiletDetails(t).join(' · ')}</span>
                      )}
                    </span>
                    <span className="toilet-row-dist">
                      {/* 直線距離ベースの目安なので「約」を付ける (実ルートは選択後に表示) */}
                      <strong>約{formatMinutes(t.crowDist / WALK_SPEED_MPS)}</strong>
                      <span>{formatDistance(t.crowDist)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            /* ---- ルート案内モード ---- */
            <>
              <div className="route-head">
                <div className="route-head-main">
                  <div className="route-dest">{toiletName(selected)}</div>
                  {toiletDetails(selected).length > 0 && (
                    <div className="route-tags">{toiletDetails(selected).join(' · ')}</div>
                  )}
                </div>
                <button className="icon-btn" onClick={closeRoute} aria-label="閉じる">
                  ✕
                </button>
              </div>

              {routeLoading && (
                <div className="route-loading">
                  <span className="spinner" /> 道順を検索中…
                </div>
              )}

              {route && (
                <>
                  <div className="route-summary">
                    <span className="route-time">🚶 {formatMinutes(route.duration)}</span>
                    <span className="route-sub">
                      {formatDistance(route.distance)} · <strong>{arrivalTime(route.duration)} 到着</strong>
                    </span>
                  </div>
                  {route.approximate && (
                    <div className="route-warn">
                      ⚠ 道順の取得に失敗したため直線距離での概算です
                    </div>
                  )}
                  <div className="sheet-scroll steps">
                    {route.steps.map((s, i) => (
                      <div key={i} className="step-row">
                        <span className="step-arrow">{s.arrow}</span>
                        <span className="step-text">{s.instruction}</span>
                        {s.distance > 0 && (
                          <span className="step-dist">{formatDistance(s.distance)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
