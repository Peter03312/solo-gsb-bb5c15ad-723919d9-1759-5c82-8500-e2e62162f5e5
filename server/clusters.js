'use strict';

// 细胞接触簇分析（已发布报告冻结数据，只读）
//
// 距离语义：两个细胞各自「外轮廓扣除孔洞后的净区域」之间的最短距离。
//   - 两净区域重叠或边界接触时，间距为 0；
//   - 一个细胞仅落在另一细胞的孔洞内、且未触及其净区域时，间距为其到该孔洞
//     边界的距离（> 0），不视为接触；
//   - 净区域边界 = 外轮廓环 + 全部孔洞环；相离净区域的最短距离即两组环边之间
//     的最短线段距离（含孔洞环，因此孔洞内的细胞到净区域的距离被正确计算）。
//
// 邻接：净区域间距 ≤ 阈值（μm，可为 0）的细胞对。
// 连通簇：邻接关系的连通分量；没有邻接关系时每个细胞各自成独立簇。
//
// 分析只读取报告发布时冻结的 cells 与 calib；阈值仅影响本次查询，不写回报告。
// 本模块只包含纯逻辑（阈值校验、距离、连通簇），HTTP 层在 index.js 中。

const geo = require('./geometry');

const EPS = 1e-9; // 距离比较的浮点容差（远小于坐标精度 1e-3）

// ---------- 阈值校验 ----------

// 校验间距阈值：必须是 ≥ 0 的有限数值（微米，允许 0；数值字符串按数值接受）。
// 非法时抛出 {status, message}，由路由映射为 HTTP 400。
function validateThreshold(raw) {
  const t = (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : raw;
  if (typeof t !== 'number' || Number.isNaN(t)) {
    throw { status: 400, message: '间距阈值无效：thresholdUm 必须是数值（微米，允许 0）' };
  }
  if (!Number.isFinite(t)) {
    throw { status: 400, message: '间距阈值无效：thresholdUm 必须是有限数值（不能为 Infinity 或 NaN）' };
  }
  if (t < 0) {
    throw { status: 400, message: `间距阈值无效：thresholdUm 不能为负数（收到 ${t}）` };
  }
  return t;
}

// ---------- 细胞标识（与 fields/compare/merge-stats 同一约定） ----------

function cellKey(cell, index) {
  return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
}

function cellLabel(cell, index) {
  return (cell && cell.name && String(cell.name).trim()) || `细胞 ${index + 1}`;
}

// ---------- 净区域距离 ----------

function ringEdges(poly) {
  const edges = [];
  for (let i = 0; i < poly.length; i++) {
    edges.push([poly[i], poly[(i + 1) % poly.length]]);
  }
  return edges;
}

// 细胞净区域的全部边界环（外轮廓 + 孔洞）
function cellRings(cell) {
  return [cell.outer].concat(Array.isArray(cell.holes) ? cell.holes : []);
}

// 点是否落在净区域（含边界）：在外轮廓内或边界上，且不严格位于任何孔洞内部。
// 孔洞边界上的点属于净区域（净区域为闭集）。
function pointInNetRegion(p, cell) {
  if (!geo.pointInsideOrOn(p, cell.outer)) return false;
  for (const h of cell.holes || []) {
    if (geo.pointStrictlyInside(p, h)) return false;
  }
  return true;
}

// 两净区域是否接触或重叠（间距为 0 的充要条件）：
// 1) 任一边界环的边相互接触（含孔洞环）；或
// 2) 无边界接触时，一方某条边界环整体落入对方净区域（顶点在对方净区域内）。
// 仅落在对方孔洞内（未触及净区域）不会命中任何一条 → false。
function netRegionsTouch(a, b) {
  const ringsA = cellRings(a);
  const ringsB = cellRings(b);
  for (const ra of ringsA) {
    const edgesA = ringEdges(ra);
    for (const rb of ringsB) {
      for (const [p1, p2] of edgesA) {
        for (const [q1, q2] of ringEdges(rb)) {
          if (geo.segmentsTouch(p1, p2, q1, q2)) return true;
        }
      }
    }
  }
  for (const ra of ringsA) {
    if (pointInNetRegion(ra[0], b)) return true;
  }
  for (const rb of ringsB) {
    if (pointInNetRegion(rb[0], a)) return true;
  }
  return false;
}

function pointSegmentDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > EPS ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentDist(p1, p2, q1, q2) {
  if (geo.segmentsTouch(p1, p2, q1, q2)) return 0;
  return Math.min(
    pointSegmentDist(p1, q1, q2),
    pointSegmentDist(p2, q1, q2),
    pointSegmentDist(q1, p1, p2),
    pointSegmentDist(q2, p1, p2)
  );
}

// 两细胞净区域的最短间距（像素）；净区域接触或重叠时为 0。
// 相离时最短距离必在双方边界环（外轮廓 + 孔洞）的边之间取得。
function netRegionDistancePx(a, b) {
  if (netRegionsTouch(a, b)) return 0;
  let best = Infinity;
  for (const ra of cellRings(a)) {
    const edgesA = ringEdges(ra);
    for (const rb of cellRings(b)) {
      for (const [p1, p2] of edgesA) {
        for (const [q1, q2] of ringEdges(rb)) {
          const d = segmentDist(p1, p2, q1, q2);
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

// ---------- 包围盒（成对计算的快速排除） ----------

function outerBBox(cell) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of cell.outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// 两包围盒间距：净区域真实间距的下界（净区域 ⊆ 外轮廓包围盒）
function bboxDistance(a, b) {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

// ---------- 接触簇分析 ----------

// cells：报告冻结的细胞数组；scale：μm/px（报告冻结定标，必为正数）；
// thresholdUm：间距阈值（μm，≥ 0，可为 0）。
// 返回 { thresholdUm, cellCount, pairCount, clusterCount, multiCellClusterCount,
//        pairs, cells, clusters }；不写任何数据。
function buildContactAnalysis(cells, scale, thresholdUm) {
  const list = Array.isArray(cells) ? cells : [];
  const keys = list.map((c, i) => cellKey(c, i));
  const labels = list.map((c, i) => cellLabel(c, i));
  const thresholdPx = thresholdUm / scale;
  const boxes = list.map(outerBBox);

  // 全部阈值内邻接对（包围盒下界先行排除）
  const found = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (bboxDistance(boxes[i], boxes[j]) > thresholdPx + EPS) continue;
      const distancePx = netRegionDistancePx(list[i], list[j]);
      const distanceUm = distancePx * scale;
      if (distanceUm <= thresholdUm + EPS) {
        found.push({ i, j, distancePx, distanceUm });
      }
    }
  }
  found.sort((x, y) => x.distanceUm - y.distanceUm || x.i - y.i || x.j - y.j);

  // 并查集求连通分量
  const parent = list.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (const p of found) {
    const ri = find(p.i);
    const rj = find(p.j);
    if (ri !== rj) parent[ri] = rj;
  }
  const byRoot = new Map();
  list.forEach((_, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  });
  // 簇排序：成员多的在前，同规模按最小细胞序号；簇 id 为排序后的 0 基序号
  const groups = [...byRoot.values()]
    .sort((A, B) => B.length - A.length || Math.min(...A) - Math.min(...B));
  const clusterIdOf = new Array(list.length);
  const clusters = groups.map((members, id) => {
    for (const i of members) clusterIdOf[i] = id;
    return {
      id,
      size: members.length,
      cellKeys: members.map((i) => keys[i]),
      cells: members.map((i) => ({ key: keys[i], name: labels[i], seq: i + 1 }))
    };
  });

  // 每个细胞的阈值内邻居（按间距升序）与最短净区域间距
  const nbrs = list.map(() => []);
  for (const p of found) {
    nbrs[p.i].push({ j: p.j, distanceUm: p.distanceUm, distancePx: p.distancePx });
    nbrs[p.j].push({ j: p.i, distanceUm: p.distanceUm, distancePx: p.distancePx });
  }
  const cellViews = list.map((c, i) => {
    const sorted = nbrs[i].sort((x, y) => x.distanceUm - y.distanceUm || x.j - y.j);
    return {
      key: keys[i],
      name: labels[i],
      seq: i + 1,
      clusterId: clusters.length ? clusterIdOf[i] : null,
      neighborCount: sorted.length,
      // 最短净区域间距：阈值内最近邻居的间距；无邻居为 null
      shortestUm: sorted.length ? sorted[0].distanceUm : null,
      neighbors: sorted.map((n) => ({
        key: keys[n.j],
        name: labels[n.j],
        seq: n.j + 1,
        distanceUm: n.distanceUm,
        distancePx: n.distancePx
      }))
    };
  });

  return {
    kind: 'contact-clusters',
    thresholdUm,
    cellCount: list.length,
    pairCount: found.length,
    clusterCount: clusters.length,
    multiCellClusterCount: clusters.filter((c) => c.size > 1).length,
    pairs: found.map((p) => ({
      a: keys[p.i],
      b: keys[p.j],
      aName: labels[p.i],
      bName: labels[p.j],
      distanceUm: p.distanceUm,
      distancePx: p.distancePx
    })),
    cells: cellViews,
    clusters
  };
}

module.exports = {
  validateThreshold,
  cellKey,
  cellLabel,
  pointInNetRegion,
  netRegionsTouch,
  netRegionDistancePx,
  buildContactAnalysis
};
