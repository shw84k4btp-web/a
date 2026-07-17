#!/usr/bin/env node
// 日本全国のトイレ・コンビニ・ガソリンスタンドを Overpass API から抽出し、
// アプリが直接読む静的データタイル (public/toilet-tiles/v1/*.json) を生成する。
//
// 使い方:  node scripts/build-toilet-tiles.mjs
//   - 日本の範囲を 2°×2° のチャンクに分けて順次取得 (チャンク間 8 秒待機で
//     Overpass のマナーを守る)。全体で 15〜25 分程度
//   - 週1回程度の再実行で十分 (GitHub Actions: build-toilet-tiles.yml 参照)
//
// 出力:
//   public/toilet-tiles/v1/{latIdx}_{lngIdx}.json  … 0.1°タイルごとのPOI配列
//   public/toilet-tiles/v1/meta.json               … 生成日時・件数 (存在=タイル有効)

import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OUT_DIR = path.join(process.cwd(), 'public', 'toilet-tiles', 'v1');
const TILE_DEG = 0.1; // src/api/toiletTiles.js の TILE_DEG と一致させること
const CHUNK_DEG = 2;
const SLEEP_MS = 8000;
// 日本をおおむね覆う範囲
const JP = { south: 24, west: 122, north: 46, east: 148 };
// アプリが使うタグのみ残してタイルを軽くする
const KEEP_TAGS = [
  'name', 'name:ja', 'brand', 'amenity', 'shop',
  'wheelchair', 'fee', 'opening_hours', 'changing_table', 'toilets',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunkQuery(s, w, n, e) {
  const bbox = `${s},${w},${n},${e}`;
  return `
[out:json][timeout:120];
(
  node["amenity"="toilets"](${bbox});
  way["amenity"="toilets"](${bbox});
  relation["amenity"="toilets"](${bbox});
  node["shop"="convenience"](${bbox});
  way["shop"="convenience"](${bbox});
  node["amenity"="fuel"](${bbox});
  way["amenity"="fuel"](${bbox});
);
out center;
`.trim();
}

function categoryOf(tags) {
  if (tags.amenity === 'toilets') return 'toilet';
  if (tags.shop === 'convenience') return 'convenience';
  if (tags.amenity === 'fuel') return 'fuel';
  return 'toilet';
}

function parseElements(elements) {
  const out = [];
  for (const el of elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const tags = el.tags || {};
    if (tags.toilets === 'no') continue; // トイレなしが明示された店舗は除外
    const kept = {};
    for (const k of KEEP_TAGS) if (tags[k] != null) kept[k] = tags[k];
    out.push({
      id: `${el.type}/${el.id}`,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      tags: kept,
      category: categoryOf(tags),
    });
  }
  return out;
}

async function fetchChunk(s, w, n, e, attempt = 1) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'toilet-finder-tile-builder (github actions)',
    },
    body: `data=${encodeURIComponent(chunkQuery(s, w, n, e))}`,
  });
  if (!res.ok) {
    if (attempt < 3) {
      console.warn(`  HTTP ${res.status} — ${30 * attempt}s 待って再試行`);
      await sleep(30000 * attempt);
      return fetchChunk(s, w, n, e, attempt + 1);
    }
    throw new Error(`Overpass HTTP ${res.status} (chunk ${s},${w})`);
  }
  const data = await res.json();
  if (data.remark && !(data.elements || []).length) {
    if (attempt < 3) {
      console.warn(`  remark: ${data.remark} — 再試行`);
      await sleep(30000 * attempt);
      return fetchChunk(s, w, n, e, attempt + 1);
    }
    throw new Error(`Overpass remark (chunk ${s},${w}): ${data.remark}`);
  }
  return parseElements(data.elements);
}

const tiles = new Map(); // "li_gi" -> Map(id -> poi)  (チャンク境界の重複はidで排除)

function addToTiles(pois) {
  for (const p of pois) {
    const key = `${Math.floor(p.lat / TILE_DEG)}_${Math.floor(p.lng / TILE_DEG)}`;
    if (!tiles.has(key)) tiles.set(key, new Map());
    tiles.get(key).set(p.id, p);
  }
}

const chunks = [];
for (let s = JP.south; s < JP.north; s += CHUNK_DEG) {
  for (let w = JP.west; w < JP.east; w += CHUNK_DEG) {
    chunks.push([s, w, Math.min(s + CHUNK_DEG, JP.north), Math.min(w + CHUNK_DEG, JP.east)]);
  }
}

console.log(`${chunks.length} チャンクを取得します (約${Math.round((chunks.length * SLEEP_MS) / 60000)}分)`);
let total = 0;
for (let i = 0; i < chunks.length; i++) {
  const [s, w, n, e] = chunks[i];
  const pois = await fetchChunk(s, w, n, e);
  addToTiles(pois);
  total += pois.length;
  console.log(`[${i + 1}/${chunks.length}] (${s},${w}) → ${pois.length}件 (累計${total})`);
  if (i < chunks.length - 1) await sleep(SLEEP_MS);
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });
let poiCount = 0;
for (const [key, byId] of tiles) {
  const arr = [...byId.values()];
  poiCount += arr.length;
  await writeFile(path.join(OUT_DIR, `${key}.json`), JSON.stringify(arr));
}
await writeFile(
  path.join(OUT_DIR, 'meta.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), tiles: tiles.size, pois: poiCount, tileDeg: TILE_DEG })
);
console.log(`完了: ${tiles.size} タイル / ${poiCount} POI → ${OUT_DIR}`);
