// Overpass API でトイレを検索する。専用の公衆トイレ (amenity=toilets) に加えて、
// いざという時に駆け込めるトイレ付き施設 (コンビニ・ガソリンスタンド) も対象にする。
// 公開エンドポイントは混雑・タイムアウトしやすいため、
// 複数ミラーへのフォールバック + リトライを行う。

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// サーバー側 [timeout:15] より少し長く待つ (サーバー成功をクライアントが先に捨てない)
const FETCH_TIMEOUT_MS = 18000;

// 検索対象の施設カテゴリ。selector は Overpass のタグ条件、
// category は UI でアイコン・名称を出し分けるための識別子
const TARGET_SELECTORS = [
  { selector: '["amenity"="toilets"]', category: 'toilet' },
  { selector: '["shop"="convenience"]', category: 'convenience' },
  { selector: '["amenity"="fuel"]', category: 'fuel' },
];

function targetClauses(area) {
  // relation のコンビニ/GSはほぼ存在せず応答も重くなるだけなので node/way に絞る
  // (公衆トイレのみ relation も対象にする)
  return TARGET_SELECTORS.map(({ selector, category }) => {
    const types = category === 'toilet' ? ['node', 'way', 'relation'] : ['node', 'way'];
    return types.map((t) => `  ${t}${selector}(${area});`).join('\n');
  }).join('\n');
}

// 注意: "out center tags;" は node の座標を出力しないため使わないこと
// (tags verbosity は id+タグのみ。node が全て落ちて実質ヒット0になる)
function buildRadiusQuery(lat, lng, radius) {
  return `
[out:json][timeout:15];
(
${targetClauses(`around:${radius},${lat},${lng}`)}
);
out center;
`.trim();
}

function buildBBoxQuery(south, west, north, east) {
  return `
[out:json][timeout:15];
(
${targetClauses(`${south},${west},${north},${east}`)}
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

// タグから施設カテゴリを判定する
function categoryOf(tags) {
  if (tags.amenity === 'toilets') return 'toilet';
  if (tags.shop === 'convenience') return 'convenience';
  if (tags.amenity === 'fuel') return 'fuel';
  return 'toilet';
}

function parseElements(elements) {
  return (elements || [])
    .map((el) => {
      // way / relation は中心座標 (center) を使う
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) return null;
      const tags = el.tags || {};
      // コンビニ等で「トイレなし」が明示されている店舗は除外する
      if (tags.toilets === 'no') return null;
      return { id: `${el.type}/${el.id}`, lat, lng, tags, category: categoryOf(tags) };
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
 * 指定座標の半径 radius (m) 内のトイレ・トイレ付き施設を検索する。
 * @returns {Promise<Array<{id, lat, lng, tags, category}>>}
 */
export function searchToilets(lat, lng, radius) {
  return runQuery(buildRadiusQuery(lat, lng, radius));
}

/**
 * 矩形範囲 (south,west,north,east: 度) 内のトイレ・トイレ付き施設を検索する。
 * 目的地までの経路沿い (コリドー) のトイレを探す安心ルート機能で使用。
 * @returns {Promise<Array<{id, lat, lng, tags, category}>>}
 */
export function searchToiletsInBBox(south, west, north, east) {
  return runQuery(buildBBoxQuery(south, west, north, east));
}
