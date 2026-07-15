// 徒歩ルート検索。OSRM (foot profile) の公開サーバーを利用し、
// 実際の道路に沿ったルート形状 + 曲がり角ごとの案内 (steps) を取得する。
// 失敗した場合は直線ルート + 距離ベースの所要時間推定にフォールバックする。

// router.project-osrm.org は car プロファイルしか提供せず (URLの/footは無視される)、
// 一方通行・車道基準の経路を「徒歩ルート」として返してしまうため使わない。
// foot 対応の FOSSGIS サーバーが落ちている場合は直線フォールバックに任せる。
const OSRM_FOOT_ENDPOINTS = [
  'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
];

// 「安心ルート」(車移動) では car プロファイルが本来の用途に合致するため、
// 同じ公開デモサーバーを意図して使用する (徒歩フォールバックでの誤用とは別の話)。
const OSRM_CAR_ENDPOINTS = ['https://router.project-osrm.org/route/v1/driving'];

const WALK_SPEED_MPS = 1.33; // 約 80m/分 (不動産表示の徒歩速度)
const CAR_SPEED_MPS = 8.33; // 約 30km/h (フォールバック時の市街地走行速度の目安)
const FETCH_TIMEOUT_MS = 15000;

export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const DIRECTION_JA = {
  left: '左折',
  right: '右折',
  'slight left': '斜め左へ',
  'slight right': '斜め右へ',
  'sharp left': '大きく左へ',
  'sharp right': '大きく右へ',
  straight: '直進',
  uturn: 'Uターン',
};

export const STEP_ARROWS = {
  left: '↰',
  right: '↱',
  'slight left': '↖',
  'slight right': '↗',
  'sharp left': '↩',
  'sharp right': '↪',
  straight: '↑',
  uturn: '⤾',
  depart: '📍',
  arrive: '🚻',
};

// OSRM の maneuver を日本語の案内文に変換する
function stepInstruction(step) {
  const type = step.maneuver?.type;
  const modifier = step.maneuver?.modifier;
  const name = step.name || '';
  if (type === 'depart') return name ? `${name} を出発` : '出発';
  if (type === 'arrive') return '目的地に到着';
  if (type === 'roundabout' || type === 'rotary') return 'ロータリーを通過';
  const dir = DIRECTION_JA[modifier];
  if (dir && dir !== '直進') return name ? `${dir}して ${name} へ` : dir;
  return name ? `${name} を直進` : '直進';
}

function stepArrow(step) {
  const type = step.maneuver?.type;
  if (type === 'depart' || type === 'arrive') return STEP_ARROWS[type];
  return STEP_ARROWS[step.maneuver?.modifier] || '↑';
}

/**
 * from → to の実際の道路に沿った徒歩ルートを取得する。
 * @returns {Promise<{
 *   coords: [lat,lng][], distance: number, duration: number,
 *   steps: Array<{instruction, arrow, distance}>, approximate: boolean
 * }>}  distance: メートル, duration: 秒
 */
export async function getWalkingRoute(from, to) {
  for (const base of OSRM_FOOT_ENDPOINTS) {
    try {
      const url =
        `${base}/${from.lng},${from.lat};${to.lng},${to.lat}` +
        `?overview=full&geometries=geojson&steps=true`;
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const data = await res.json();
      const route = data.routes?.[0];
      if (data.code !== 'Ok' || !route) continue;
      const steps = (route.legs?.[0]?.steps || []).map((s) => ({
        instruction: stepInstruction(s),
        arrow: stepArrow(s),
        distance: s.distance,
      }));
      return {
        coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distance: route.distance,
        // 公開サーバーのプロファイル差異を吸収するため、所要時間は徒歩速度で再計算
        duration: route.distance / WALK_SPEED_MPS,
        steps,
        approximate: false,
      };
    } catch {
      // 次のエンドポイントを試す
    }
  }

  // 全ルーティングサーバー失敗時: 直線ルートで概算
  const distance = haversine(from, to);
  return {
    coords: [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ],
    distance,
    duration: distance / WALK_SPEED_MPS,
    steps: [],
    approximate: true,
  };
}

/**
 * 複数の経由地点を順に通る車のルートを取得する (「安心ルート」機能で使用)。
 * 実際の道路網に沿った1本のルートと、区間 (waypoints[i] → waypoints[i+1]) ごとの
 * 距離・所要時間を返す。ルートサーバーが失敗した場合は各区間を直線で繋いで概算する
 * (呼び出し側が待ち続けないよう、この関数は throw しない)。
 *
 * @param {Array<{lat: number, lng: number}>} waypoints 2点以上
 * @returns {Promise<{
 *   coords: [lat,lng][], distance: number, duration: number,
 *   legs: Array<{distance: number, duration: number}>, approximate: boolean
 * }>}
 */
export async function getDrivingRoute(waypoints) {
  const coordsParam = waypoints.map((w) => `${w.lng},${w.lat}`).join(';');
  for (const base of OSRM_CAR_ENDPOINTS) {
    try {
      const url = `${base}/${coordsParam}?overview=full&geometries=geojson&steps=false`;
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const data = await res.json();
      const route = data.routes?.[0];
      if (data.code !== 'Ok' || !route || !route.legs) continue;
      return {
        coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distance: route.distance,
        duration: route.duration,
        legs: route.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
        approximate: false,
      };
    } catch {
      // 次のエンドポイントを試す
    }
  }

  // 全ルーティングサーバー失敗時: 区間ごとに直線で繋いで概算
  const legs = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const d = haversine(waypoints[i], waypoints[i + 1]);
    legs.push({ distance: d, duration: d / CAR_SPEED_MPS });
  }
  return {
    coords: waypoints.map((w) => [w.lat, w.lng]),
    distance: legs.reduce((s, l) => s + l.distance, 0),
    duration: legs.reduce((s, l) => s + l.duration, 0),
    legs,
    approximate: true,
  };
}
