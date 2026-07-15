// Nominatim による住所 → 座標のジオコーディング。
// 位置情報の許可が得られなかった場合の代替手段として使う。

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const FETCH_TIMEOUT_MS = 10000; // 応答が来ないと入力フォームが無効のままになるため必須

/**
 * 住所・地名文字列から座標を検索する。
 * @returns {Promise<{lat: number, lng: number, label: string} | null>}
 */
export async function geocodeAddress(query) {
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
