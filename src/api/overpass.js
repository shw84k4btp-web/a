// Overpass API でトイレを検索する。専用の公衆トイレ (amenity=toilets) に加えて、
// いざという時に駆け込めるトイレ付き施設 (コンビニ・ガソリンスタンド) も対象にする。
// 公開エンドポイントは混雑・タイムアウトしやすいため、
// 複数ミラーへのフォールバック + リトライを行う。

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// サーバー側 [timeout:15] より少し長く待つ (サーバー成功をクライアントが先に捨てない。
// 8秒ヘッジ併用時の最悪ケースは max(18, 8+18, 16+18) ≈ 34秒)
const FETCH_TIMEOUT_MS = 18000;
// 先頭ミラーがこの時間応答しなければ2本目を追加発火する (ヘッジリクエスト)。
// 正常応答のp95より後ろに置くことで、混雑時以外は1本しか飛ばさない
const HEDGE_DELAY_MS = 8000;
// 失敗 (タイムアウト/429等) したミラーを後回しにする時間
const DEMOTE_MS = 5 * 60 * 1000;
// 同一クエリ結果のメモリキャッシュ (トイレ等のPOIはほぼ静的なので鮮度リスクは実質ゼロ)
const CACHE_TTL_MS = 12 * 60 * 1000;
const CACHE_MAX_ENTRIES = 30;

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

// ---- 1ミラーへの単発リクエスト (成功で要素配列、失敗で例外) ----
async function attemptEndpoint(endpoint, query, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = await res.json();
    // 混雑時の Overpass はHTTP 200のまま remark にタイムアウトを入れて
    // 空の elements を返すことがある。0件と誤認せず失敗扱いにする
    if (data.remark && !(data.elements || []).length) {
      throw new Error(`Overpass remark: ${data.remark}`);
    }
    return parseElements(data.elements);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

// ---- ミラーの健全性メモ (成功したミラーを優先、失敗したミラーは一定時間降格) ----
let preferredEndpoint = null;
const demotedUntil = new Map();

function orderedEndpoints() {
  const now = Date.now();
  const healthy = OVERPASS_ENDPOINTS.filter((e) => (demotedUntil.get(e) || 0) < now);
  const pool = healthy.length ? healthy : [...OVERPASS_ENDPOINTS];
  if (preferredEndpoint && pool.includes(preferredEndpoint)) {
    return [preferredEndpoint, ...pool.filter((e) => e !== preferredEndpoint)];
  }
  return pool;
}

// ---- ヘッジ付き実行 ----
// まず先頭ミラー1本。HEDGE_DELAY_MS 応答がなければ2本目を追加 (同時は最大2本まで)。
// 3本目は先行のどちらかが失敗したときのみ発火する。最初の成功で残りを中断する。
function runQueryHedged(query) {
  const order = orderedEndpoints();
  return new Promise((resolve, reject) => {
    let started = 0;
    let pending = 0;
    let settled = false;
    let hedgeScheduled = false;
    let lastError = null;
    const controllers = [];

    const startNext = () => {
      if (settled || started >= order.length) return;
      const endpoint = order[started++];
      const controller = new AbortController();
      controllers.push(controller);
      pending++;
      attemptEndpoint(endpoint, query, controller.signal)
        .then((elements) => {
          if (settled) return;
          settled = true;
          preferredEndpoint = endpoint; // 次回はこのミラーを先頭に
          controllers.forEach((c) => c !== controller && c.abort());
          resolve(elements);
        })
        .catch((err) => {
          pending--;
          if (settled) return;
          lastError = err;
          demotedUntil.set(endpoint, Date.now() + DEMOTE_MS);
          if (preferredEndpoint === endpoint) preferredEndpoint = null;
          if (started < order.length) startNext(); // 失敗駆動で次のミラーへ
          else if (pending === 0) {
            reject(lastError || new Error('Overpass API に接続できませんでした'));
          }
        });
      // ヘッジは1本だけ: 最初のリクエストが遅いときに限り2本目を足す
      if (!hedgeScheduled && started === 1 && order.length > 1) {
        hedgeScheduled = true;
        setTimeout(() => {
          if (!settled && pending > 0) startNext();
        }, HEDGE_DELAY_MS);
      }
    };

    startNext();
  });
}

// ---- クエリ文字列キーのメモリキャッシュ (Promiseを保持して同時重複発火も排除) ----
const queryCache = new Map(); // query -> { promise, expires }

function runQuery(query) {
  const now = Date.now();
  const hit = queryCache.get(query);
  if (hit && hit.expires > now) return hit.promise;

  const promise = runQueryHedged(query);
  queryCache.set(query, { promise, expires: now + CACHE_TTL_MS });
  // 失敗はキャッシュしない (次回は再取得させる)
  promise.catch(() => {
    if (queryCache.get(query)?.promise === promise) queryCache.delete(query);
  });
  // 簡易LRU: 上限を超えたら古いものから捨てる (Mapは挿入順)
  if (queryCache.size > CACHE_MAX_ENTRIES) {
    const oldest = queryCache.keys().next().value;
    queryCache.delete(oldest);
  }
  return promise;
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

/**
 * 複数の矩形範囲を1つの union クエリにまとめて検索する (ギャップ補完用)。
 * 個別に並列リクエストするより速く、ミラーへの同時接続も1本で済む。
 * 返り値は全 bbox の結果を重複排除した平坦なリスト。どの bbox 由来かは
 * 呼び出し側で点-in-bbox 判定して振り分けること。
 * @param {Array<{south,west,north,east}>} bboxes
 * @returns {Promise<Array<{id, lat, lng, tags, category}>>}
 */
export function searchToiletsInBBoxes(bboxes) {
  if (!bboxes.length) return Promise.resolve([]);
  const clauses = bboxes
    .map((b) => targetClauses(`${b.south},${b.west},${b.north},${b.east}`))
    .join('\n');
  const query = `
[out:json][timeout:15];
(
${clauses}
);
out center;
`.trim();
  return runQuery(query);
}
