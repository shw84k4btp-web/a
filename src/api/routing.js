// 徒歩ルート検索。OSRM (foot profile) の公開サーバーを利用し、
// 実際の道路に沿ったルート形状 + 曲がり角ごとの案内 (steps) を取得する。
// 失敗した場合は直線ルート + 距離ベースの所要時間推定にフォールバックする。

const OSRM_FOOT_ENDPOINTS = [
  'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
  'https://router.project-osrm.org/route/v1/foot',
];

const WALK_SPEED_MPS = 1.33; // 約 80m/分 (不動産表示の徒歩速度)
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
