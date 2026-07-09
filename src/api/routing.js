// 徒歩ルート検索。OSRM (foot profile) の公開サーバーを利用し、
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

/**
 * from → to の徒歩ルートを取得する。
 * @returns {Promise<{coords: [lat,lng][], distance: number, duration: number, approximate: boolean}>}
 *   distance: メートル, duration: 秒
 */
export async function getWalkingRoute(from, to) {
  for (const base of OSRM_FOOT_ENDPOINTS) {
    try {
      const url =
        `${base}/${from.lng},${from.lat};${to.lng},${to.lat}` +
        `?overview=full&geometries=geojson&steps=false`;
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const data = await res.json();
      const route = data.routes?.[0];
      if (data.code !== 'Ok' || !route) continue;
      return {
        coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distance: route.distance,
        // OSRM の車用プロファイルが返る場合もあるため、所要時間は徒歩速度で再計算
        duration: route.distance / WALK_SPEED_MPS,
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
    approximate: true,
  };
}
