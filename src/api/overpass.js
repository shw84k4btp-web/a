// Overpass API でトイレ (amenity=toilets) を検索する。
// 公開エンドポイントは混雑・タイムアウトしやすいため、
// 複数ミラーへのフォールバック + リトライを行う。

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// サーバー側 [timeout:15] より少し長く待つ (サーバー成功をクライアントが先に捨てない)
const FETCH_TIMEOUT_MS = 18000;

// 注意: "out center tags;" は node の座標を出力しないため使わないこと
// (tags verbosity は id+タグのみ。node が全て落ちて実質ヒット0になる)
function buildRadiusQuery(lat, lng, radius) {
  return `
[out:json][timeout:15];
(
  node["amenity"="toilets"](around:${radius},${lat},${lng});
  way["amenity"="toilets"](around:${radius},${lat},${lng});
  relation["amenity"="toilets"](around:${radius},${lat},${lng});
);
out center;
`.trim();
}

function buildBBoxQuery(south, west, north, east) {
  const bbox = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:15];
(
  node["amenity"="toilets"](${bbox});
  way["amenity"="toilets"](${bbox});
  relation["amenity"="toilets"](${bbox});
);
out center;
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

function parseElements(elements) {
  return (elements || [])
    .map((el) => {
      // way / relation は中心座標 (center) を使う
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) return null;
      return { id: `${el.type}/${el.id}`, lat, lng, tags: el.tags || {} };
    })
    .filter(Boolean);
}

// 全ミラーを順に試し、成功したら要素を返す。すべて失敗したら例外を投げる。
async function runQuery(query) {
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
      // 混雑時の Overpass はHTTP 200のまま remark にタイムアウトを入れて
      // 空の elements を返すことがある。0件と誤認せず次のミラーへ
      if (data.remark && !(data.elements || []).length) {
        lastError = new Error(`Overpass remark: ${data.remark}`);
        continue;
      }
      return parseElements(data.elements);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass API に接続できませんでした');
}

/**
 * 指定座標の半径 radius (m) 内のトイレを検索する。
 * @returns {Promise<Array<{id, lat, lng, tags}>>}
 */
export function searchToilets(lat, lng, radius) {
  return runQuery(buildRadiusQuery(lat, lng, radius));
}

/**
 * 矩形範囲 (south,west,north,east: 度) 内のトイレを検索する。
 * 目的地までの経路沿い (コリドー) のトイレを探す安心ルート機能で使用。
 * @returns {Promise<Array<{id, lat, lng, tags}>>}
 */
export function searchToiletsInBBox(south, west, north, east) {
  return runQuery(buildBBoxQuery(south, west, north, east));
}
