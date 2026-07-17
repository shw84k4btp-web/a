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

// bbox を外側スナップで量子化するグリッド幅 (度)。約550m。
// GPSジッターで毎回微妙に違う bbox になりキャッシュが効かない問題を防ぐ。
// 必ず「外側に」丸めるので取得範囲は要求の上位集合になり、欠落方向の誤差は
// 構造的に発生しない (呼び出し側は必要に応じて自分の条件で絞り込む)
const BBOX_SNAP_DEG = 0.005;

// localStorage への永続キャッシュ (アプリを開き直しても直近エリアが瞬時に出る)。
// キーにクエリ内容のハッシュを使うため、検索対象カテゴリ等の仕様変更で
// クエリ文字列が変われば自然に別キーになる (古いキャッシュの毒化なし)
const STORAGE_PREFIX = 'tf-ovp:';
const STORAGE_TTL_MS = 12 * 60 * 60 * 1000;
const STORAGE_MAX_ENTRIES = 15;

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

// 外側スナップ: south/west は切り捨て、north/east は切り上げ。
// toFixed(3) で浮動小数点の揺れを正規化しクエリ文字列 (=キャッシュキー) を安定させる
function snapBBox(south, west, north, east) {
  const f = BBOX_SNAP_DEG;
  return {
    south: (Math.floor(south / f) * f).toFixed(3),
    west: (Math.floor(west / f) * f).toFixed(3),
    north: (Math.ceil(north / f) * f).toFixed(3),
    east: (Math.ceil(east / f) * f).toFixed(3),
  };
}

function buildBBoxQuery(south, west, north, east) {
  const b = snapBBox(south, west, north, east);
  return `
[out:json][timeout:15];
(
${targetClauses(`${b.south},${b.west},${b.north},${b.east}`)}
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
// まず先頭ミラー1本。HEDGE_DELAY_MS 応答がなければ追加で1本発火する
// (ヘッジタイマーは1回だけ登録。失敗時は次のミラーへ即座に置き換わるため、
//  総発射数は最大3本になり得るが、同時実行は常に最大2本に収まる)。
// 最初の成功で残りを中断する。
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

// ---- localStorage 永続キャッシュ (失敗は書かない・容量/エントリ上限・全てtry/catch) ----
function storageKey(query) {
  let h = 5381;
  for (let i = 0; i < query.length; i++) h = ((h * 33) ^ query.charCodeAt(i)) >>> 0;
  return STORAGE_PREFIX + h.toString(36);
}

function storageGet(query) {
  try {
    const raw = localStorage.getItem(storageKey(query));
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || rec.q !== query || Date.now() - rec.t > STORAGE_TTL_MS) return null;
    return rec.e;
  } catch {
    return null;
  }
}

function storageSet(query, elements) {
  try {
    localStorage.setItem(
      storageKey(query),
      JSON.stringify({ q: query, t: Date.now(), e: elements })
    );
    // エントリ数上限: 古いものから削除
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) {
        try {
          mine.push({ k, t: JSON.parse(localStorage.getItem(k))?.t || 0 });
        } catch {
          mine.push({ k, t: 0 });
        }
      }
    }
    if (mine.length > STORAGE_MAX_ENTRIES) {
      mine.sort((a, b) => a.t - b.t);
      for (const { k } of mine.slice(0, mine.length - STORAGE_MAX_ENTRIES)) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // 容量超過等は無視 (キャッシュは最善努力)
  }
}

// ---- クエリ文字列キーのメモリキャッシュ (Promiseを保持して同時重複発火も排除) ----
// 注意: Promise は複数の呼び出し元で共有される。将来 AbortSignal をこの層へ
// 貫通させる場合、共有 Promise に呼び出し元の signal を直結してはいけない
// (1人の中断が全員を巻き添えにする)。参照カウント式にすること。
const queryCache = new Map(); // query -> { promise, expires }

function runQuery(query) {
  const now = Date.now();
  const hit = queryCache.get(query);
  if (hit && hit.expires > now) {
    // LRU: ヒットしたエントリを末尾へ移動 (Mapは挿入順なので削除→再挿入)
    queryCache.delete(query);
    queryCache.set(query, hit);
    return hit.promise;
  }

  // 永続キャッシュにあればネットワークに出ない
  const stored = storageGet(query);
  const promise = stored ? Promise.resolve(stored) : runQueryHedged(query);
  queryCache.set(query, { promise, expires: now + CACHE_TTL_MS });
  if (!stored) {
    promise.then(
      (elements) => storageSet(query, elements),
      () => {
        // 失敗はキャッシュしない (次回は再取得させる)
        if (queryCache.get(query)?.promise === promise) queryCache.delete(query);
      }
    );
  }
  // LRU: 上限を超えたら最も使われていないもの (先頭) から捨てる
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
    .map((b) => {
      const s = snapBBox(b.south, b.west, b.north, b.east);
      return targetClauses(`${s.south},${s.west},${s.north},${s.east}`);
    })
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
