// 「安心ルート」: 目的地までの移動中、常に車で一定時間以内に行けるトイレがある
// ようなルートを組み立てる。目的地までの最短ルートではなく、進行方向のコリドー
// (帯状の範囲) にあるトイレをできるだけ経由地として繋いでいく。
//
// アルゴリズム概要:
//   1. 出発地→目的地を包む矩形をコリドー幅ぶん広げて Overpass に矩形検索をかける
//   2. 各トイレを出発地→目的地の直線に射影し、進捗率 t と直線からの垂直距離で絞り込む
//   3. 「まだ次の閾値以内に置ける最も先のトイレ」を選び続ける貪欲法で経由地を作る
//      (区間ごとの最大ギャップを抑えつつ経由地点数を最小化する、区間被覆の定番の貪欲法)
//   4. 実際の道路距離 (OSRM car) で各区間を検証し、1分を超える区間があれば
//      その区間だけ狭い範囲で再検索して1回だけ補完を試みる
//   5. 補完しきれない区間は「ギャップ」として結果に含め、UI側で警告表示する

import { haversine, getRouteViaWaypoints } from './routing.js';
import { searchToiletsInBBox, searchToiletsInBBoxes } from './overpass.js';

const R = 6371000;
const CORRIDOR_HALF_WIDTH_M = 700; // コリドー (進行方向の帯) の片側幅
const GAP_FILL_HALF_WIDTH_M = 500; // ギャップ補完時に狭めて検索する範囲
const MAX_WAYPOINTS = 10; // OSRM への同時経由地点数の上限 (URL長・応答サイズ対策)
const MAX_TRIP_STRAIGHT_M = 60000; // これを超える距離は矩形検索が大きくなりすぎるため対象外
const MIN_TRIP_STRAIGHT_M = 100; // 近すぎる目的地はコリドー計算が不安定になるため対象外

// 交通手段ごとの設定。thresholdSec が「常に◯◯以内にトイレ」の閾値で、
// legMaxM は貪欲法で「次の候補」とみなす直線距離の上限 (閾値時間で無理なく
// 移動できる距離の目安)。thresholdShort/Label は UI 表示用の文言
export const TRAVEL_MODES = {
  car: {
    emoji: '🚗', label: '車',
    thresholdSec: 60, thresholdShort: '1分', thresholdLabel: '車で1分',
    legMaxM: 900,
  },
  bike: {
    emoji: '🚴', label: '自転車',
    thresholdSec: 120, thresholdShort: '2分', thresholdLabel: '自転車で2分',
    legMaxM: 500,
  },
  foot: {
    emoji: '🚶', label: '徒歩',
    thresholdSec: 300, thresholdShort: '5分', thresholdLabel: '徒歩5分',
    legMaxM: 400,
  },
};

export class SafeRouteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafeRouteError';
    this.code = code; // 'TOO_CLOSE' | 'TOO_FAR'
  }
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

// 緯度経度を、refLatRad 付近を原点とするローカルなメートル平面 (x=東方向, y=北方向) に変換する。
// 同じ refLatRad を使う点同士でのみ、平面上の距離計算が (数km規模で) 正確になる。
function flatten(p, refLatRad) {
  return { x: toRad(p.lng) * Math.cos(refLatRad) * R, y: toRad(p.lat) * R };
}

// 点 P を線分 A→B に射影し、進捗率 t (0=A, 1=B) と垂直距離 (m) を返す
function projectOntoSegment(P, A, B) {
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return { t: 0, perp: Math.hypot(P.x - A.x, P.y - A.y) };
  const t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq;
  const perp = Math.abs((P.x - A.x) * aby - (P.y - A.y) * abx) / Math.sqrt(lenSq);
  return { t, perp };
}

// a-b を包む矩形を halfWidthM だけ拡張した (south,west,north,east) を返す
function corridorBBox(a, b, halfWidthM) {
  const south = Math.min(a.lat, b.lat);
  const north = Math.max(a.lat, b.lat);
  const west = Math.min(a.lng, b.lng);
  const east = Math.max(a.lng, b.lng);
  const latPad = (halfWidthM / R) * (180 / Math.PI);
  const midLatRad = toRad((a.lat + b.lat) / 2);
  const lngPad = (halfWidthM / (R * Math.cos(midLatRad))) * (180 / Math.PI);
  return { south: south - latPad, west: west - lngPad, north: north + latPad, east: east + lngPad };
}

function pointInBBox(p, b) {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

// 候補プールからギャップ区間の補完トイレを1件選ぶ (区間中点への最近傍)
function pickGapFiller(pool, fromPoint, toPoint, excludeIds) {
  const fresh = pool.filter((c) => !excludeIds.has(c.id));
  if (!fresh.length) return null;
  const mid = { lat: (fromPoint.lat + toPoint.lat) / 2, lng: (fromPoint.lng + toPoint.lng) / 2 };
  fresh.sort((a, b) => haversine(mid, a) - haversine(mid, b));
  return fresh[0];
}

// 直進困難な区間 (ギャップ) 群を補完する候補を選ぶ。
// ギャップの検索範囲はほぼコリドー矩形の内側なので、まず初回コリドー検索で
// 取得済みの rawCandidates からローカルに補完し (ネットワーク不要)、
// ローカルで埋まらないギャップだけを1本の統合 Overpass クエリで再検索する。
// 失敗しても null を並べて返すだけで例外は投げない (ギャップとして扱われる)。
// excludeIds: 既にチェーンに入っているトイレのID群 (重複挿入防止)。
async function fillGaps(gapPairs, rawCandidates, excludeIds) {
  const bboxes = gapPairs.map(([fromPoint, toPoint]) =>
    corridorBBox(fromPoint, toPoint, GAP_FILL_HALF_WIDTH_M)
  );

  // 1) ローカル補完: 取得済み候補を各ギャップ bbox で絞る
  const picks = gapPairs.map(([fromPoint, toPoint], i) => {
    const pool = rawCandidates.filter((c) => pointInBBox(c, bboxes[i]));
    return pickGapFiller(pool, fromPoint, toPoint, excludeIds);
  });

  // 2) ローカルで埋まらなかったギャップだけ、1本の統合クエリで再検索
  const unfilled = picks.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  if (unfilled.length > 0) {
    let fetched;
    try {
      fetched = await searchToiletsInBBoxes(unfilled.map((i) => bboxes[i]));
    } catch {
      fetched = null; // ネットワーク失敗はギャップのまま
    }
    if (fetched) {
      for (const i of unfilled) {
        const pool = fetched.filter((c) => pointInBBox(c, bboxes[i]));
        picks[i] = pickGapFiller(pool, gapPairs[i][0], gapPairs[i][1], excludeIds);
      }
    }
  }
  return picks;
}

// 貪欲法: 「まだ legMaxM 以内に置ける、最も進捗率 (t) の大きい候補」を
// 選び続ける。区間ごとの最大ギャップを一定に抑えつつ経由地点数を少なく保つ
// (1次元の区間被覆の貪欲法の考え方を2D距離判定に適用した近似。
//  startIdx が毎回単調増加するため停止性は保証される)。
function buildGreedyChain(sortedCandidates, originFlat, destFlat, legMaxM) {
  const chain = [];
  let current = originFlat;
  let currentT = 0;
  let startIdx = 0;

  while (startIdx < sortedCandidates.length && chain.length < MAX_WAYPOINTS) {
    let bestIdx = -1;
    let bestT = currentT;
    for (let i = startIdx; i < sortedCandidates.length; i++) {
      const cand = sortedCandidates[i];
      if (cand.t <= currentT) continue;
      const dist = Math.hypot(cand.flat.x - current.x, cand.flat.y - current.y);
      if (dist <= legMaxM && cand.t > bestT) {
        bestT = cand.t;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      // 直進では届く範囲に候補がない。目的地まで直進できるなら打ち切り、
      // できないなら範囲を広げて最も近い次善候補で橋渡しを試みる。
      const distToDest = Math.hypot(destFlat.x - current.x, destFlat.y - current.y);
      if (distToDest <= legMaxM) break;

      let bridgeIdx = -1;
      let bridgeDist = Infinity;
      for (let i = startIdx; i < sortedCandidates.length; i++) {
        const cand = sortedCandidates[i];
        if (cand.t <= currentT) continue;
        const dist = Math.hypot(cand.flat.x - current.x, cand.flat.y - current.y);
        if (dist <= legMaxM * 2 && dist < bridgeDist) {
          bridgeDist = dist;
          bridgeIdx = i;
        }
      }
      if (bridgeIdx === -1) break; // これ以上は繋げない (最終ギャップとして残る)

      const chosen = sortedCandidates[bridgeIdx];
      chain.push(chosen.toilet);
      current = chosen.flat;
      currentT = chosen.t;
      startIdx = bridgeIdx + 1;
      continue;
    }

    const chosen = sortedCandidates[bestIdx];
    chain.push(chosen.toilet);
    current = chosen.flat;
    currentT = chosen.t;
    startIdx = bestIdx + 1;
  }

  return chain;
}

function buildLegs(routeResult, chain, thresholdSec) {
  return routeResult.legs.map((leg, i) => ({
    toilet: i < chain.length ? chain[i] : null, // 最後の区間は目的地への到着区間
    distance: leg.distance,
    duration: leg.duration,
    exceedsThreshold: leg.duration > thresholdSec,
  }));
}

/**
 * origin → destination のコリドー内のトイレをできるだけ経由しながら、
 * 常に選択した交通手段で閾値時間 (TRAVEL_MODES[travelMode].thresholdSec) 以内に
 * トイレがある「安心ルート」を組み立てる。
 * ネットワーク障害時は直線フォールバックで応答する (投げるのは入力値検証エラーのみ)。
 *
 * @returns {Promise<{
 *   coords: [lat,lng][], distance: number, duration: number,
 *   legs: Array<{toilet: object|null, distance: number, duration: number, exceedsThreshold: boolean}>,
 *   toiletsUsed: object[], corridorToiletsCount: number, gapCount: number,
 *   approximate: boolean, toiletDataUnavailable: boolean
 * }>}
 */
// 出発地〜目的地の距離が安心ルートの対応範囲か検証する (範囲外は SafeRouteError)。
// ネットワークリクエストを1本も発射する前に呼べるよう、単体でエクスポートする
export function validateTripDistance(origin, destination) {
  const straightM = haversine(origin, destination);
  if (straightM < MIN_TRIP_STRAIGHT_M) {
    throw new SafeRouteError('TOO_CLOSE', '目的地が近すぎます。安心ルートは100m以上先の目的地向けです。');
  }
  if (straightM > MAX_TRIP_STRAIGHT_M) {
    throw new SafeRouteError('TOO_FAR', '目的地が遠すぎます (60km以内でご利用ください)。');
  }
}

export async function buildSafeRoute(origin, destination, travelMode = 'car', opts = {}) {
  const modeCfg = TRAVEL_MODES[travelMode] || TRAVEL_MODES.car;
  validateTripDistance(origin, destination);

  const refLatRad = toRad((origin.lat + destination.lat) / 2);
  const originFlat = flatten(origin, refLatRad);
  const destFlat = flatten(destination, refLatRad);

  const bbox = corridorBBox(origin, destination, CORRIDOR_HALF_WIDTH_M);
  let rawCandidates = [];
  let toiletDataUnavailable = false;
  try {
    rawCandidates = await searchToiletsInBBox(bbox.south, bbox.west, bbox.north, bbox.east);
  } catch {
    toiletDataUnavailable = true;
  }

  const candidates = rawCandidates
    .map((toilet) => {
      const { t, perp } = projectOntoSegment(flatten(toilet, refLatRad), originFlat, destFlat);
      return { toilet, t, perp, flat: flatten(toilet, refLatRad) };
    })
    .filter((c) => c.t >= -0.08 && c.t <= 1.08 && c.perp <= CORRIDOR_HALF_WIDTH_M)
    .sort((a, b) => a.t - b.t);

  let chain = buildGreedyChain(candidates, originFlat, destFlat, modeCfg.legMaxM);
  let waypoints = [origin, ...chain, destination];
  // 経由地なしの場合、投機的に先行取得した直行ルート (opts.directRoute) を
  // そのまま使えるので OSRM の2度目の呼び出しを省略できる
  let routeResult = null;
  if (chain.length === 0 && opts.directRoute) {
    routeResult = await opts.directRoute.catch(() => null);
  }
  if (!routeResult) {
    routeResult = await getRouteViaWaypoints(waypoints, travelMode);
  }
  let legs = buildLegs(routeResult, chain, modeCfg.thresholdSec);

  // ギャップ区間を1回だけ補完してみる (再帰させず1パスに限定して挙動を予測可能にする)
  const gapIndices = legs.reduce((acc, l, i) => (l.exceedsThreshold ? [...acc, i] : acc), []);
  if (gapIndices.length > 0 && chain.length < MAX_WAYPOINTS && !routeResult.approximate) {
    // 既にチェーンに入っているトイレを補完候補から除外する (重複挿入防止)
    const usedIds = new Set(chain.map((t) => t.id));
    const fillResults = await fillGaps(
      gapIndices.map((i) => [waypoints[i], waypoints[i + 1]]),
      rawCandidates,
      usedIds
    );
    const newWaypoints = [...waypoints];
    let insertedCount = 0;
    const insertedIds = new Set();
    // 後ろの区間から挿入するとインデックスがずれない
    for (let k = gapIndices.length - 1; k >= 0; k--) {
      const toilet = fillResults[k];
      if (!toilet) continue;
      // 複数ギャップの補完が同じトイレを返した場合の重複と、経由地点数の上限を守る
      if (insertedIds.has(toilet.id)) continue;
      if (chain.length + insertedCount >= MAX_WAYPOINTS) break;
      newWaypoints.splice(gapIndices[k] + 1, 0, toilet);
      insertedIds.add(toilet.id);
      insertedCount++;
    }
    if (insertedCount > 0) {
      const retryResult = await getRouteViaWaypoints(newWaypoints, travelMode);
      if (!retryResult.approximate) {
        waypoints = newWaypoints;
        chain = newWaypoints.slice(1, -1);
        routeResult = retryResult;
        legs = buildLegs(routeResult, chain, modeCfg.thresholdSec);
      }
    }
  }

  return {
    coords: routeResult.coords,
    distance: routeResult.distance,
    duration: routeResult.duration,
    legs,
    toiletsUsed: chain,
    corridorToiletsCount: candidates.length,
    gapCount: legs.filter((l) => l.exceedsThreshold).length,
    approximate: routeResult.approximate,
    toiletDataUnavailable,
    travelMode,
  };
}
