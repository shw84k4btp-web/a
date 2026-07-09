// Overpass API でトイレ (amenity=toilets) を検索する。
// 公開エンドポイントは混雑・タイムアウトしやすいため、
// 複数ミラーへのフォールバック + リトライを行う。

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const FETCH_TIMEOUT_MS = 20000;

function buildQuery(lat, lng, radius) {
  return `
[out:json][timeout:25];
(
  node["amenity"="toilets"](around:${radius},${lat},${lng});
  way["amenity"="toilets"](around:${radius},${lat},${lng});
  relation["amenity"="toilets"](around:${radius},${lat},${lng});
);
out center tags;
`.trim();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 指定座標の半径 radius (m) 内のトイレを検索する。
 * 全エンドポイントを順に試し、すべて失敗したら例外を投げる。
 * @returns {Promise<Array<{id, lat, lng, tags}>>}
 */
export async function searchToilets(lat, lng, radius) {
  const query = buildQuery(lat, lng, radius);
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        },
        FETCH_TIMEOUT_MS
      );
      if (!res.ok) {
        lastError = new Error(`Overpass HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      return (data.elements || [])
        .map((el) => {
          // way / relation は中心座標 (center) を使う
          const lat2 = el.lat ?? el.center?.lat;
          const lng2 = el.lon ?? el.center?.lon;
          if (lat2 == null || lng2 == null) return null;
          return { id: `${el.type}/${el.id}`, lat: lat2, lng: lng2, tags: el.tags || {} };
        })
        .filter(Boolean);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass API に接続できませんでした');
}
