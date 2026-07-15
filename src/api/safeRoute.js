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

import { haversine, getDrivingRoute } from './routing.js';
import { searchToiletsInBBox } from './overpass.js';

const R = 6371000;
const CORRIDOR_HALF_WIDTH_M = 700; // コリドー (進行方向の帯) の片側幅
const GAP_FILL_HALF_WIDTH_M = 500; // ギャップ補完時に狭めて検索する範囲
const MAX_STRAIGHT_LEG_M = 900; // 貪欲法で「次の候補」とみなす直線距離の上限
const MAX_WAYPOINTS = 10; // OSRM への同時経由地点数の上限 (URL長・応答サイズ対策)
const GAP_THRESHOLD_SEC = 60; // 「車で1分」の閾値
const MAX_TRIP_STRAIGHT_M = 60000; // これを超える距離は矩形検索が大きくなりすぎるため対象外
const MIN_TRIP_STRAIGHT_M = 100; // 近すぎる目的地はコリドー計算が不安定になるため対象外

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

// 直進困難な区間 (ギャップ) を、狭い範囲での再検索で1件だけ補おうとする。
// 失敗しても null を返すだけで例外は投げない (ギャップとして扱われる)。
async function fillGap(fromPoint, toPoint) {
  const bbox = corridorBBox(fromPoint, toPoint, GAP_FILL_HALF_WIDTH_M);
  let candidates;
  try {
    candidates = await searchToiletsInBBox(bbox.south, bbox.west, bbox.north, bbox.east);
  } catch {
    return null;
  }
  if (!candidates.length) return null;
  const mid = { lat: (fromPoint.lat + toPoint.lat) / 2, lng: (fromPoint.lng + toPoint.lng) / 2 };
  candidates.sort((a, b) => haversine(mid, a) - haversine(mid, b));
  return candidates[0];
}

// 貪欲法: 「まだ MAX_STRAIGHT_LEG_M 以内に置ける、最も進捗率 (t) の大きい候補」を
// 選び続ける。区間ごとの最大ギャップを一定に抑えつつ経由地点数を最小化する
// (区間被覆問題の標準的な貪欲法で、この条件下では経由地点数が最小になることが知られている)。
function buildGreedyChain(sortedCandidates, originFlat, destFlat) {
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
      if (dist <= MAX_STRAIGHT_LEG_M && cand.t > bestT) {
        bestT = cand.t;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      // 直進では届く範囲に候補がない。目的地まで直進できるなら打ち切り、
      // できないなら範囲を広げて最も近い次善候補で橋渡しを試みる。
      const distToDest = Math.hypot(destFlat.x - current.x, destFlat.y - current.y);
      if (distToDest <= MAX_STRAIGHT_LEG_M) break;

      let bridgeIdx = -1;
      let bridgeDist = Infinity;
      for (let i = startIdx; i < sortedCandidates.length; i++) {
        const cand = sortedCandidates[i];
        if (cand.t <= currentT) continue;
        const dist = Math.hypot(cand.flat.x - current.x, cand.flat.y - current.y);
        if (dist <= MAX_STRAIGHT_LEG_M * 2 && dist < bridgeDist) {
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

function buildLegs(routeResult, chain) {
  return routeResult.legs.map((leg, i) => ({
    toilet: i < chain.length ? chain[i] : null, // 最後の区間は目的地への到着区間
    distance: leg.distance,
    duration: leg.duration,
    exceedsThreshold: leg.duration > GAP_THRESHOLD_SEC,
  }));
}

/**
 * origin → destination のコリドー内のトイレをできるだけ経由しながら、
 * 常に車で GAP_THRESHOLD_SEC 以内にトイレがある「安心ルート」を組み立てる。
 * ネットワーク障害時は直線フォールバックで応答する (投げるのは入力値検証エラーのみ)。
 *
 * @returns {Promise<{
 *   coords: [lat,lng][], distance: number, duration: number,
 *   legs: Array<{toilet: object|null, distance: number, duration: number, exceedsThreshold: boolean}>,
 *   toiletsUsed: object[], corridorToiletsCount: number, gapCount: number,
 *   approximate: boolean, toiletDataUnavailable: boolean
 * }>}
 */
export async function buildSafeRoute(origin, destination) {
  const straightM = haversine(origin, destination);
  if (straightM < MIN_TRIP_STRAIGHT_M) {
    throw new SafeRouteError('TOO_CLOSE', '目的地が近すぎます。安心ルートは100m以上先の目的地向けです。');
  }
  if (straightM > MAX_TRIP_STRAIGHT_M) {
    throw new SafeRouteError('TOO_FAR', '目的地が遠すぎます (60km以内でご利用ください)。');
  }

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

  let chain = buildGreedyChain(candidates, originFlat, destFlat);
  let waypoints = [origin, ...chain, destination];
  let routeResult = await getDrivingRoute(waypoints);
  let legs = buildLegs(routeResult, chain);

  // ギャップ区間を1回だけ補完してみる (再帰させず1パスに限定して挙動を予測可能にする)
  const gapIndices = legs.reduce((acc, l, i) => (l.exceedsThreshold ? [...acc, i] : acc), []);
  if (gapIndices.length > 0 && chain.length < MAX_WAYPOINTS && !routeResult.approximate) {
    const fillResults = await Promise.all(
      gapIndices.map((i) => fillGap(waypoints[i], waypoints[i + 1]))
    );
    const newWaypoints = [...waypoints];
    let insertedAny = false;
    // 後ろの区間から挿入するとインデックスがずれない
    for (let k = gapIndices.length - 1; k >= 0; k--) {
      const toilet = fillResults[k];
      if (!toilet) continue;
      newWaypoints.splice(gapIndices[k] + 1, 0, toilet);
      insertedAny = true;
    }
    if (insertedAny) {
      const retryResult = await getDrivingRoute(newWaypoints);
      if (!retryResult.approximate) {
        waypoints = newWaypoints;
        chain = newWaypoints.slice(1, -1);
        routeResult = retryResult;
        legs = buildLegs(routeResult, chain);
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
  };
}
