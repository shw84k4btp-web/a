import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { searchToilets } from './api/overpass.js';
import { getWalkingRoute, haversine } from './api/routing.js';
import { geocodeAddress } from './api/geocode.js';
import { getCurrentPosition } from './api/location.js';
import { buildSafeRoute, SafeRouteError, TRAVEL_MODES } from './api/safeRoute.js';

// 検索半径: 見つからなければ自動的に広げる (m)
const SEARCH_RADII = [500, 1000, 2000, 4000];
// 表示する最大件数。都心部では数百件返ることがあり、マーカーとリスト行を
// 全件描画すると端末 (特にiPhone) が重くなるため近い順に制限する
const MAX_RESULTS = 60;
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

// 安心ルートの経由トイレ用: 通過順の番号バッジ付きピン
// (gapAfter: この地点の次の区間が1分の閾値を超える場合に警告色にする)
function waypointIcon(order, gapAfter) {
  return L.divIcon({
    className: 'waypoint-marker',
    html: `<div class="waypoint-pin${gapAfter ? ' gap' : ''}">🚻<span class="waypoint-badge">${order}</span></div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 36],
  });
}

const destIcon = L.divIcon({
  className: 'dest-marker',
  html: '<div class="dest-pin">🏁</div>',
  iconSize: [40, 40],
  iconAnchor: [20, 38],
});

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

// ボトムシートのスナップ位置 (画面の高さに対する割合)。
// 最小の 0.14 はサマリー行だけが見える「地図主体」の状態 (Google マップと同じ発想)
const SHEET_SNAPS = [0.14, 0.45, 0.82];
const TOPBAR_SLOT_HEIGHT = 56; // 上部フローティングバー1段あたりの高さ目安 (px)

export default function App() {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const userMarkerRef = useRef(null);
  const routeLayerRef = useRef(null); // 「最寄りトイレ」モードのルート線 (縁取り + 本線)
  // 遅延して届いた古い応答が UI を上書きしないよう、リクエストに世代番号を振る
  const routeSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  const [mode, setMode] = useState('nearest'); // 'nearest' | 'safe'

  const [origin, setOrigin] = useState(null); // {lat, lng, label}
  const [locationDenied, setLocationDenied] = useState(false);
  const [status, setStatus] = useState({ type: 'loading', text: '現在地を取得しています…' });
  const [toilets, setToilets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [route, setRoute] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [address, setAddress] = useState('');
  const [geocoding, setGeocoding] = useState(false);

  // ---- 「安心ルート」モード ----
  const safeRouteLayerRef = useRef(null); // 線 + 目的地ピン + 経由トイレピンをまとめて管理
  const safeRouteSeqRef = useRef(0);
  const [destInput, setDestInput] = useState('');
  const [destGeocoding, setDestGeocoding] = useState(false);
  const [destination, setDestination] = useState(null); // {lat, lng, label}
  const [safeRoute, setSafeRoute] = useState(null);
  const [safeRouteLoading, setSafeRouteLoading] = useState(false);
  const [safeRouteError, setSafeRouteError] = useState(null);
  const [travelMode, setTravelMode] = useState('car'); // 'car' | 'bike' | 'foot'

  // ボトムシート (Google Maps 風のドラッグ操作)
  const [sheetRatio, setSheetRatio] = useState(SHEET_SNAPS[1]);
  const dragRef = useRef(null);
  const sheetDragging = useRef(false);

  // ---- 地図の初期化 ----
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: false }).setView(DEFAULT_CENTER, 15);
    // Google マップ風のシンプルな配色のベースマップ (CARTO Voyager)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    markersRef.current = L.layerGroup(); // 表示/非表示はモード切替 effect が管理する
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // ---- 「最寄りトイレ」モードのマーカー層は、そのモードのときだけ地図に載せる ----
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersRef.current;
    if (!map || !layer) return;
    if (mode === 'nearest') map.addLayer(layer);
    else map.removeLayer(layer);
  }, [mode]);

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

  // ---- 出発地点が決まったら地図を移動してトイレを検索 (最寄りトイレモード) ----
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
        // 近い順に並べて直線距離を付与 (一覧表示用)。件数は近い順に制限
        const withDist = found
          .map((t) => ({ ...t, crowDist: haversine(o, t) }))
          .sort((a, b) => a.crowDist - b.crowDist);
        setToilets(withDist.slice(0, MAX_RESULTS));
        setStatus({
          type: 'ok',
          text:
            withDist.length > MAX_RESULTS
              ? `${withDist.length}件見つかりました (近い順${MAX_RESULTS}件を表示)`
              : `${withDist.length} 件見つかりました (半径 ${radius}m)`,
        });
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

  // ---- マーカーの描画 (最寄りトイレモード) ----
  // 一覧が変わったときだけ全マーカーを作り直す。選択変更では作り直さない
  const markerByIdRef = useRef(new Map());
  const prevSelectedIdRef = useRef(null);
  useEffect(() => {
    const layer = markersRef.current;
    if (!layer) return;
    layer.clearLayers();
    const byId = new Map();
    toilets.forEach((t) => {
      const m = L.marker([t.lat, t.lng], { icon: toiletIcon(false) })
        .addTo(layer)
        .on('click', () => selectToilet(t));
      byId.set(t.id, m);
    });
    markerByIdRef.current = byId;
    prevSelectedIdRef.current = null;
  }, [toilets, selectToilet]);

  // 選択が変わったら該当する2つのピンのアイコンだけ差し替える
  // (タップのたびに全ピンを破棄・再生成すると台数が多いとき重い)
  useEffect(() => {
    const byId = markerByIdRef.current;
    const prevId = prevSelectedIdRef.current;
    const nextId = selected?.id ?? null;
    if (prevId === nextId) return;
    if (prevId != null && byId.has(prevId)) {
      byId.get(prevId).setIcon(toiletIcon(false)).setZIndexOffset(0);
    }
    if (nextId != null && byId.has(nextId)) {
      byId.get(nextId).setIcon(toiletIcon(true)).setZIndexOffset(500);
    }
    prevSelectedIdRef.current = nextId;
  }, [selected, toilets]);

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
    if (!route && !safeRoute) return;
    const id = setInterval(() => setClockTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [route, safeRoute]);

  // ---- 安心ルートを閉じる (進行中の計算も世代番号で無効化) ----
  const closeSafeRoute = useCallback(() => {
    safeRouteSeqRef.current++;
    setSafeRoute(null);
    setSafeRouteError(null);
    setSafeRouteLoading(false);
    if (safeRouteLayerRef.current) {
      safeRouteLayerRef.current.remove();
      safeRouteLayerRef.current = null;
    }
  }, []);

  // ---- 安心ルートを計算して描画する ----
  const runSafeRoute = useCallback(async (o, d, mode) => {
    const seq = ++safeRouteSeqRef.current;
    setSafeRoute(null);
    setSafeRouteError(null);
    setSafeRouteLoading(true);
    if (safeRouteLayerRef.current) {
      safeRouteLayerRef.current.remove();
      safeRouteLayerRef.current = null;
    }

    let result;
    try {
      result = await buildSafeRoute(o, d, mode);
    } catch (err) {
      if (seq !== safeRouteSeqRef.current) return; // 新しい計算・閉じる操作で無効化済み
      setSafeRouteLoading(false);
      setSafeRouteError(
        err instanceof SafeRouteError ? err.message : '安心ルートの計算に失敗しました。通信状況を確認してください。'
      );
      return;
    }
    if (seq !== safeRouteSeqRef.current) return;
    setSafeRoute(result);
    setSafeRouteLoading(false);

    const map = mapRef.current;
    const casing = L.polyline(result.coords, { color: '#ffffff', weight: 10, opacity: 0.9 });
    const line = L.polyline(result.coords, {
      color: '#1a73e8',
      weight: 6,
      opacity: 0.95,
      dashArray: result.approximate ? '10 10' : null,
      lineCap: 'round',
      lineJoin: 'round',
    });
    const destMarker = L.marker([d.lat, d.lng], { icon: destIcon, zIndexOffset: 900 });
    const waypointMarkers = result.toiletsUsed.map((t, i) =>
      L.marker([t.lat, t.lng], {
        // legs[i] は「このトイレに到着する区間」なので、「この先の区間が1分超過」の
        // 警告色には次の区間 legs[i+1] を参照する
        icon: waypointIcon(i + 1, result.legs[i + 1]?.exceedsThreshold),
        zIndexOffset: 400,
      })
    );
    safeRouteLayerRef.current = L.layerGroup([casing, line, destMarker, ...waypointMarkers]).addTo(map);
    map.fitBounds(line.getBounds(), {
      paddingTopLeft: [48, 140],
      paddingBottomRight: [48, window.innerHeight * SHEET_SNAPS[1] + 40],
    });
  }, []);

  // ---- モード切替 (前のモードの選択状態・地図レイヤーを片付ける) ----
  function switchMode(newMode) {
    if (newMode === mode) return;
    if (mode === 'nearest') closeRoute();
    if (mode === 'safe') closeSafeRoute();
    setSheetRatio(SHEET_SNAPS[1]);
    setMode(newMode);
  }

  // ---- ボトムシートのドラッグ ----
  // ドラッグ中は React の再レンダーを介さず DOM を直接更新する。
  // (毎フレーム setState すると一覧全体が再描画されて iPhone でカクつくため)
  const sheetRef = useRef(null);
  const fabRef = useRef(null);
  const applySheetHeight = (ratio) => {
    if (sheetRef.current) sheetRef.current.style.height = `${ratio * 100}%`;
    if (fabRef.current) {
      fabRef.current.style.bottom = `calc(${ratio * 100}% + 20px + env(safe-area-inset-bottom))`;
    }
  };
  function onSheetPointerDown(e) {
    sheetDragging.current = true;
    dragRef.current = { startY: e.clientY, startRatio: sheetRatio, ratio: sheetRatio };
    sheetRef.current?.classList.add('dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onSheetPointerMove(e) {
    if (!sheetDragging.current || !dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY;
    const ratio = Math.min(0.9, Math.max(0.12, dragRef.current.startRatio + dy / window.innerHeight));
    dragRef.current.ratio = ratio;
    applySheetHeight(ratio);
  }
  function onSheetPointerUp() {
    if (!sheetDragging.current) return;
    sheetDragging.current = false;
    sheetRef.current?.classList.remove('dragging');
    const r = dragRef.current?.ratio ?? sheetRatio;
    const snap = SHEET_SNAPS.reduce((best, s) => (Math.abs(s - r) < Math.abs(best - r) ? s : best));
    applySheetHeight(snap);
    setSheetRatio(snap); // スナップ確定時だけ state を更新して再レンダー
  }

  // ---- 現在地に戻る ----
  function recenter() {
    if (origin) mapRef.current.setView([origin.lat, origin.lng], 16);
  }

  // ---- 住所検索 (位置情報が使えない場合の代替: 出発地) ----
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

  // ---- 目的地検索 (安心ルートモード) ----
  async function handleDestinationSubmit(e) {
    e.preventDefault();
    if (!destInput.trim() || destGeocoding || !origin) return;
    setDestGeocoding(true);
    try {
      const result = await geocodeAddress(destInput.trim());
      if (!result) {
        setSafeRouteError(`「${destInput}」が見つかりませんでした。`);
      } else {
        const dest = { lat: result.lat, lng: result.lng, label: result.label.split(',')[0] };
        setDestination(dest);
        runSafeRoute(origin, dest, travelMode);
      }
    } catch {
      setSafeRouteError('目的地検索に失敗しました。時間をおいて再試行してください。');
    } finally {
      setDestGeocoding(false);
    }
  }

  const isLoading = status.type === 'loading';
  const showSheet =
    mode === 'nearest'
      ? Boolean(origin && (toilets.length > 0 || selected))
      : Boolean(origin && (safeRouteLoading || safeRoute || safeRouteError));

  // 上部フローティングバーを、表示するものだけ順に積み上げる (重なり防止)
  const topBars = [];
  if (origin) topBars.push('modeToggle');
  if (locationDenied || !origin) topBars.push('originForm');
  if (mode === 'safe' && origin) topBars.push('destForm');
  const barTop = (name) => 84 + topBars.indexOf(name) * TOPBAR_SLOT_HEIGHT;

  return (
    <div className="app">
      <div ref={mapEl} className="map" />

      {/* 上部: グラスのステータスバー */}
      <div className="topbar glass">
        <span className="topbar-icon">{mode === 'nearest' ? '🚻' : '🧭'}</span>
        <div className="topbar-text">
          <div className="topbar-title">
            {mode === 'nearest' ? 'トイレファインダー' : '安心ルート'}
          </div>
          <div className={`topbar-status status-${mode === 'nearest' ? status.type : 'ok'}`}>
            {mode === 'nearest' ? (
              <>
                {isLoading && <span className="spinner" />}
                {status.text}
                {status.retry && origin && (
                  <button className="link-btn" onClick={() => runSearch(origin)}>再試行</button>
                )}
              </>
            ) : (
              <span>常に{TRAVEL_MODES[travelMode].thresholdLabel}以内のトイレを経由して目的地へ</span>
            )}
          </div>
        </div>
        {mode === 'nearest' && origin && (
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

      {/* モード切替 */}
      {topBars.includes('modeToggle') && (
        <div
          className="mode-toggle glass"
          style={{ top: `calc(${barTop('modeToggle')}px + env(safe-area-inset-top))` }}
        >
          <button
            className={mode === 'nearest' ? 'active' : ''}
            onClick={() => switchMode('nearest')}
          >
            🚻 最寄り
          </button>
          <button className={mode === 'safe' ? 'active' : ''} onClick={() => switchMode('safe')}>
            🧭 安心ルート
          </button>
        </div>
      )}

      {/* 位置情報が使えない場合の住所入力 (出発地) */}
      {topBars.includes('originForm') && !isLoading && (
        <form
          className="address-form glass"
          style={{ top: `calc(${barTop('originForm')}px + env(safe-area-inset-top))` }}
          onSubmit={handleAddressSubmit}
        >
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="住所・駅名を入力 (例: 新宿駅)"
            aria-label="出発地の住所検索"
          />
          <button type="submit" disabled={geocoding || !address.trim()}>
            {geocoding ? '…' : '検索'}
          </button>
        </form>
      )}

      {/* 目的地入力 (安心ルートモード) */}
      {topBars.includes('destForm') && (
        <form
          className="address-form glass"
          style={{ top: `calc(${barTop('destForm')}px + env(safe-area-inset-top))` }}
          onSubmit={handleDestinationSubmit}
        >
          <input
            type="text"
            value={destInput}
            onChange={(e) => setDestInput(e.target.value)}
            placeholder="目的地を入力 (例: 東京タワー)"
            aria-label="目的地検索"
          />
          <button type="submit" disabled={destGeocoding || !destInput.trim()}>
            {destGeocoding ? '…' : '検索'}
          </button>
        </form>
      )}

      {/* 現在地ボタン */}
      {origin && (
        <button
          ref={fabRef}
          className="fab glass"
          style={{ bottom: `calc(${showSheet ? sheetRatio * 100 : 0}% + 20px + env(safe-area-inset-bottom))` }}
          onClick={recenter}
          aria-label="現在地に戻る"
        >
          ◉
        </button>
      )}

      {/* ボトムシート */}
      {showSheet && (
        <div ref={sheetRef} className="sheet glass" style={{ height: `${sheetRatio * 100}%` }}>
          <div
            className="sheet-handle-area"
            onPointerDown={onSheetPointerDown}
            onPointerMove={onSheetPointerMove}
            onPointerUp={onSheetPointerUp}
            onPointerCancel={onSheetPointerUp}
          >
            <div className="sheet-handle" />
          </div>

          {mode === 'nearest' ? (
            !selected ? (
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
                      <div className="route-warn">⚠ 道順の取得に失敗したため直線距離での概算です</div>
                    )}
                    <div className="sheet-scroll steps">
                      {route.steps.map((s, i) => (
                        <div key={i} className="step-row">
                          <span className="step-arrow">{s.arrow}</span>
                          <span className="step-text">{s.instruction}</span>
                          {s.distance > 0 && <span className="step-dist">{formatDistance(s.distance)}</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )
          ) : (
            /* ---- 安心ルートモード ---- */
            <>
              <div className="route-head">
                <div className="route-head-main">
                  <div className="route-dest">🏁 {destination?.label || '目的地'}</div>
                </div>
                <button className="icon-btn" onClick={closeSafeRoute} aria-label="閉じる">
                  ✕
                </button>
              </div>

              {/* 交通手段の切り替え (Google マップ風のタブ。切替で再計算) */}
              <div className="travel-tabs" role="tablist" aria-label="交通手段">
                {Object.entries(TRAVEL_MODES).map(([key, cfg]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={travelMode === key}
                    className={travelMode === key ? 'active' : ''}
                    disabled={safeRouteLoading}
                    onClick={() => {
                      if (travelMode === key) return;
                      setTravelMode(key);
                      if (origin && destination) runSafeRoute(origin, destination, key);
                    }}
                  >
                    {cfg.emoji} {cfg.label}
                  </button>
                ))}
              </div>

              {safeRouteLoading && (
                <div className="route-loading">
                  <span className="spinner" /> 安心ルートを計算中…
                </div>
              )}

              {safeRouteError && <div className="route-warn">⚠ {safeRouteError}</div>}

              {safeRoute && (
                <>
                  <div className="route-summary">
                    <span className="route-time">
                      {(TRAVEL_MODES[safeRoute.travelMode] || TRAVEL_MODES.car).emoji}{' '}
                      {formatMinutes(safeRoute.duration)}
                    </span>
                    <span className="route-sub">
                      {formatDistance(safeRoute.distance)} · <strong>{arrivalTime(safeRoute.duration)} 到着</strong>
                    </span>
                  </div>

                  <div className={`safety-chip ${safeRoute.gapCount === 0 ? 'ok' : 'warn'}`}>
                    {safeRoute.gapCount === 0
                      ? `✅ 全区間、${(TRAVEL_MODES[safeRoute.travelMode] || TRAVEL_MODES.car).thresholdLabel}以内にトイレがあります (${safeRoute.toiletsUsed.length}件経由)`
                      : `⚠ ${safeRoute.gapCount}区間でトイレまで${(TRAVEL_MODES[safeRoute.travelMode] || TRAVEL_MODES.car).thresholdShort}を超えます (${safeRoute.toiletsUsed.length}件経由)`}
                  </div>

                  {safeRoute.toiletDataUnavailable && (
                    <div className="route-warn">⚠ トイレ情報を取得できなかったため、経由なしの直接ルートです</div>
                  )}
                  {safeRoute.approximate && (
                    <div className="route-warn">⚠ ルート検索に失敗したため直線での概算です</div>
                  )}

                  <div className="sheet-scroll">
                    {safeRoute.legs.map((leg, i) => (
                      <div key={i} className={`leg-row${leg.exceedsThreshold ? ' gap' : ''}`}>
                        <span className="leg-icon">{leg.toilet ? i + 1 : '🏁'}</span>
                        <span className="leg-main">
                          <span className="leg-name">
                            {leg.toilet ? toiletName(leg.toilet) : destination?.label || '目的地'}
                          </span>
                          {leg.exceedsThreshold && (
                            <span className="leg-warn">
                              この区間は{(TRAVEL_MODES[safeRoute.travelMode] || TRAVEL_MODES.car).thresholdShort}を超えます
                            </span>
                          )}
                        </span>
                        <span className="leg-time">{formatMinutes(leg.duration)}</span>
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
