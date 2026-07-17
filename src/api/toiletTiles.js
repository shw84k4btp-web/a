// 事前生成した静的トイレデータタイル (scripts/build-toilet-tiles.mjs が生成し、
// アプリと同じ場所に配信される toilet-tiles/v1/*.json) のローダー。
// タイルが配信されていれば Overpass を一切呼ばずに数十msでトイレデータが揃う。
// 配信されていない環境 (単一HTML版など) では null を返し、呼び出し側が
// 従来どおり Overpass にフォールバックする。

const TILES_BASE = 'toilet-tiles/v1'; // 相対パス (サブディレクトリ配信でも動く)
const TILE_DEG = 0.1; // タイル1辺 (度)。日本では約11km×9km
const MAX_TILES_PER_QUERY = 40; // これを超える広範囲はOverpassに任せる

// meta.json の有無でタイル配信の有無を判定 (結果はセッション内で1回だけ確認)。
// 注意: 起動直後の一時的な通信失敗でも「このセッションはタイル無効」となり
// 以後は Overpass フォールバックで動き続ける (安全側に倒す意図的な設計)
let metaPromise;
function tilesMeta() {
  if (metaPromise === undefined) {
    metaPromise = fetch(`${TILES_BASE}/meta.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return metaPromise;
}

const tileCache = new Map(); // "li_gi" -> Promise<Array>

function fetchTile(li, gi) {
  const key = `${li}_${gi}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const promise = fetch(`${TILES_BASE}/${key}.json`).then((r) => {
    if (r.status === 404) return []; // 海など、データのないタイル
    if (!r.ok) throw new Error(`tile HTTP ${r.status}`);
    return r.json();
  });
  tileCache.set(key, promise);
  promise.catch(() => tileCache.delete(key)); // 通信失敗はキャッシュしない
  return promise;
}

/**
 * 矩形範囲のトイレ・トイレ付き施設を静的タイルから取得する。
 * タイル未配信・範囲過大・通信失敗の場合は null (呼び出し側でOverpassへ)。
 * @returns {Promise<Array<{id, lat, lng, tags, category}> | null>}
 */
export async function getToiletsInBBoxFromTiles(south, west, north, east) {
  const meta = await tilesMeta();
  if (!meta) return null;

  const li0 = Math.floor(south / TILE_DEG);
  const li1 = Math.floor(north / TILE_DEG);
  const gi0 = Math.floor(west / TILE_DEG);
  const gi1 = Math.floor(east / TILE_DEG);
  if ((li1 - li0 + 1) * (gi1 - gi0 + 1) > MAX_TILES_PER_QUERY) return null;

  const jobs = [];
  for (let li = li0; li <= li1; li++) {
    for (let gi = gi0; gi <= gi1; gi++) jobs.push(fetchTile(li, gi));
  }
  let tiles;
  try {
    tiles = await Promise.all(jobs);
  } catch {
    return null; // タイル取得に失敗したらOverpassへ
  }
  const out = [];
  for (const arr of tiles) {
    for (const p of arr) {
      if (p.lat >= south && p.lat <= north && p.lng >= west && p.lng <= east) out.push(p);
    }
  }
  return out;
}
