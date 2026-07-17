// トイレデータ取得のファサード。
// 高速な静的タイル (toiletTiles.js) を優先し、配信されていない環境や
// 失敗時は従来どおり Overpass API (overpass.js) にフォールバックする。
// 呼び出し側はデータソースを意識しなくてよい。

import { searchToilets, searchToiletsInBBox, searchToiletsInBBoxes } from './overpass.js';
import { getToiletsInBBoxFromTiles } from './toiletTiles.js';
import { haversine } from './routing.js';

/**
 * 矩形範囲のトイレ・トイレ付き施設を取得する (安心ルートのコリドー検索用)。
 */
export async function getToiletsInBBox(south, west, north, east) {
  const fromTiles = await getToiletsInBBoxFromTiles(south, west, north, east);
  if (fromTiles) return fromTiles;
  return searchToiletsInBBox(south, west, north, east);
}

/**
 * 複数の矩形範囲をまとめて取得する (ギャップ補完のフォールバック検索用)。
 * 結果は全 bbox の和集合 (id で重複排除)。
 */
export async function getToiletsInBBoxes(bboxes) {
  if (!bboxes.length) return [];
  const fromTiles = await Promise.all(
    bboxes.map((b) => getToiletsInBBoxFromTiles(b.south, b.west, b.north, b.east))
  );
  if (fromTiles.every((r) => r !== null)) {
    const byId = new Map();
    for (const arr of fromTiles) for (const p of arr) byId.set(p.id, p);
    return [...byId.values()];
  }
  return searchToiletsInBBoxes(bboxes);
}

/**
 * 指定座標の半径 radius (m) 内のトイレ・トイレ付き施設を取得する (最寄りモード用)。
 */
export async function getToiletsAround(lat, lng, radius) {
  // 円を包む bbox でタイルを引き、半径で絞り込む
  const latPad = radius / 111320;
  const lngPad = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const fromTiles = await getToiletsInBBoxFromTiles(
    lat - latPad,
    lng - lngPad,
    lat + latPad,
    lng + lngPad
  );
  if (fromTiles) return fromTiles.filter((p) => haversine({ lat, lng }, p) <= radius);
  return searchToilets(lat, lng, radius);
}
