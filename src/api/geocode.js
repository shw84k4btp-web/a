// Nominatim による住所 → 座標のジオコーディング。
// 位置情報の許可が得られなかった場合の代替手段、および安心ルートの目的地検索に使う。

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const FETCH_TIMEOUT_MS = 10000; // 応答が来ないと入力フォームが無効のままになるため必須

// 同一クエリのメモリキャッシュ (入力中の先読みと送信で二重リクエストしないため、
// Promise を保持して in-flight の重複も排除する)
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const cache = new Map(); // normalized query -> { promise, expires }

async function fetchGeocode(query) {
  const url =
    `${NOMINATIM_URL}?format=json&limit=1&accept-language=ja&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const results = await res.json();
  if (!results.length) return null;
  const r = results[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: r.display_name };
}

/**
 * 住所・地名文字列から座標を検索する。
 * 結果 (見つからない場合の null 含む) はキャッシュされる。失敗はキャッシュしない。
 * @returns {Promise<{lat: number, lng: number, label: string} | null>}
 */
export function geocodeAddress(query) {
  const key = query.trim();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) {
    cache.delete(key);
    cache.set(key, hit); // LRU: ヒットで末尾へ
    return hit.promise;
  }
  const promise = fetchGeocode(key);
  cache.set(key, { promise, expires: now + CACHE_TTL_MS });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  if (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return promise;
}
