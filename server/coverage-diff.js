'use strict';

// 同一切片两份已发布报告的「单视野细胞覆盖变化核对」（只读）
//
// 输入：基线报告、复测报告（必须不同且属于同一切片 image_id）、基线报告冻结的一个取样视野。
// 两份报告冻结的细胞净区域（外环扣除孔洞，重叠细胞先取并集）与基线视野净区域做平面排列，
// 把视野净区域精确划分为互不重叠的四类面：
//   common  共同覆盖：基线与复测的细胞净区域都覆盖
//   retest  仅复测覆盖：只有复测细胞净区域覆盖（基线未覆盖）
//   baseline 仅基线覆盖：只有基线细胞净区域覆盖（复测未覆盖）
//   never   始终未覆盖：两次都未被任何细胞净区域覆盖
//
// 面积规则（与单视野覆盖核对一致）：
//   跨视野边界的细胞只计视野内部分；多个细胞重叠先取并集（只计一次）；
//   细胞孔洞、视野孔洞与仅边界接触（零面积）不贡献面积。
//   四类面积按排列圈的有向面积求和得到，其和精确等于视野净面积。
//
// 物理面积一律按【基线报告冻结标尺】换算（px² → mm²）；两份报告标尺不同时在结果中
// 明确给出换算依据与复测标尺。本模块为纯只读逻辑，不触碰草稿、修订与报告。

const mergeSvc = require('./merge-stats');
const geo = require('./geometry');

const EPS = 1e-9;
// 数值残差容忍：四类像素面积之和与视野净面积的差异不超过 1e-6 px²（坐标精度 1e-3）
const AREA_TOLERANCE = 1e-6;

const CLASS_KEYS = ['common', 'retest', 'baseline', 'never'];

const CLASS_LABELS = {
  common: '共同覆盖',
  retest: '仅复测覆盖',
  baseline: '仅基线覆盖',
  never: '始终未覆盖'
};

// 页面默认配色（接口同时给出，前端可直接使用）
const CLASS_COLORS = {
  common: '#2e7d32',   // 绿：两次都覆盖
  retest: '#1565c0',   // 蓝：复测新增
  baseline: '#c62828', // 红：基线有、复测消失
  never: '#9e9e9e'     // 灰：始终未覆盖
};

function px2ToMm2(areaPx, scaleUmPerPx) {
  return areaPx * scaleUmPerPx * scaleUmPerPx / 1e6;
}

function round(v, n = 6) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

function roundPoint(p) {
  return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
}

function isCalibrated(report) {
  const s = report && report.calib;
  return !!(s && typeof s.scale === 'number' && Number.isFinite(s.scale) && s.scale > 0);
}

// ---------- 请求解析与校验 ----------
//
// body: { baselineReportId, retestReportId, fieldId }
// getReport: id => 水合报告或 null。
// 失败抛出 { status, message }；成功返回 { baseline, retest, field, fieldIndex, matchedBy }。
function resolveDiffQuery(body, getReport) {
  const b = body || {};
  const baselineId = b.baselineReportId;
  const retestId = b.retestReportId;
  if (typeof baselineId !== 'string' || !baselineId ||
      typeof retestId !== 'string' || !retestId) {
    throw { status: 400, message: '请分别选择基线报告 baselineReportId 与复测报告 retestReportId' };
  }
  if (typeof b.fieldId !== 'string' || !b.fieldId.trim()) {
    throw { status: 400, message: '请指定基线报告的取样视野 fieldId（视野 id 或名称）' };
  }

  // 先判定两份报告是否存在（404 与现有报告侧只读接口一致）
  const baseline = getReport(baselineId);
  if (!baseline) throw { status: 404, message: `基线报告 ${baselineId} 不存在` };
  const retest = getReport(retestId);
  if (!retest) throw { status: 404, message: `复测报告 ${retestId} 不存在` };

  // 相同报告
  if (baseline.id === retest.id) {
    throw {
      status: 400,
      message: '基线报告与复测报告必须是两份不同的报告（不能选择同一份报告进行覆盖变化核对）'
    };
  }

  // 必须同一切片（同一 image_id；含更正链历史报告——更正报告与被更正报告天然同一切片）
  if (baseline.imageId !== retest.imageId) {
    throw {
      status: 400,
      message: `两份报告不属于同一切片：基线报告《${baseline.title}》的切片为 ${baseline.imageId}，` +
        `复测报告《${retest.title}》的切片为 ${retest.imageId}；覆盖变化核对只能选择同一切片的两份报告`
    };
  }

  // 视野必须取自【基线报告】冻结的 fields；重名/不存在复用既有解析的明确报错
  let resolved;
  try {
    resolved = mergeSvc.resolveFieldIdentifier(baseline.fields, b.fieldId);
  } catch (e) {
    throw { status: 400, message: e.message };
  }

  return {
    baseline,
    retest,
    field: resolved.field,
    fieldIndex: resolved.index,
    matchedBy: resolved.matchBy
  };
}

// ---------- 平面排列上的四类划分 ----------

// 与 merge-stats 内部同语义的净区域判定（本文件内独立命名）
function pointInNet(p, shape) {
  if (!geo.pointStrictlyInside(p, shape.outer)) return false;
  for (const h of shape.holes || []) {
    if (geo.pointInsideOrOn(p, h)) return false;
  }
  return true;
}

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function netBBox(shape) {
  const b = ringBBox(shape.outer);
  for (const h of shape.holes || []) {
    const hb = ringBBox(h);
    if (hb.minX < b.minX) b.minX = hb.minX;
    if (hb.minY < b.minY) b.minY = hb.minY;
    if (hb.maxX > b.maxX) b.maxX = hb.maxX;
    if (hb.maxY > b.maxY) b.maxY = hb.maxY;
  }
  return b;
}

function bboxOverlap(a, b) {
  return !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY);
}

// 只保留外环包围盒与视野相交的细胞（孔洞在外环内部，bbox 不相交不可能有正面积交集）
function candidateCells(cells, fieldBox) {
  const out = [];
  (Array.isArray(cells) ? cells : []).forEach((cell, index) => {
    if (cell && Array.isArray(cell.outer) && bboxOverlap(fieldBox, netBBox(cell))) {
      out.push({ cell, index });
    }
  });
  return out;
}

// 采样点 q 的四类归属：先判在不在视野净区域内，再判两侧细胞并集
function classifyPoint(q, field, baseShapes, retestShapes) {
  if (!pointInNet(q, field)) return null; // 视野净区域之外（含视野孔洞）：不参与划分
  const inBase = baseShapes.some((s) => pointInNet(q, s));
  const inRetest = retestShapes.some((s) => pointInNet(q, s));
  if (inBase && inRetest) return 'common';
  if (inRetest) return 'retest';
  if (inBase) return 'baseline';
  return 'never';
}

// 沿半边缘左侧取一个不落在任何边上的采样点（merge-stats 已对 DELTAS 做过同样处理，
// 这里用排列自带的 onAnyEdge 复刻一遍以避免依赖其内部常量）。
const DELTAS = [1e-8, 2e-8, 5e-8, 1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6, 1e-5];
function sideSample(he, onAnyEdge) {
  const dx = he.to.x - he.from.x;
  const dy = he.to.y - he.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mx = (he.from.x + he.to.x) / 2;
  const my = (he.from.y + he.to.y) / 2;
  for (const d of DELTAS) {
    const q = { x: mx + nx * d, y: my + ny * d };
    if (!onAnyEdge(q)) return q;
  }
  return { x: mx + nx * DELTAS[DELTAS.length - 1], y: my + ny * DELTAS[DELTAS.length - 1] };
}

// 核心：构造四类划分结果（像素面积 + 可叠加的实际区域/边界几何）。
function buildCoverageDiff(baseline, retest, field) {
  const fieldAreaPx = Math.abs(geo.signedArea(field.outer)) -
    (field.holes || []).reduce((s, h) => s + Math.abs(geo.signedArea(h)), 0);

  const fieldBox = netBBox(field);
  const baseCandidates = candidateCells(baseline.cells, fieldBox);
  const retestCandidates = candidateCells(retest.cells, fieldBox);
  const baseShapes = baseCandidates.map((x) => x.cell);
  const retestShapes = retestCandidates.map((x) => x.cell);

  // 一个排列容纳视野 + 两侧全部候选细胞；面的归属由谓词在采样点上判定
  const ctx = mergeSvc.buildArrangement(
    [field].concat(baseShapes).concat(retestShapes));

  // 每个圈左采样点的四类归属（圈方向自带外正内负符号）
  const loopClass = ctx.loops.map((loop) =>
    classifyPoint(loop.q, field, baseShapes, retestShapes));

  // 有向面积按类求和
  const signed = { common: 0, retest: 0, baseline: 0, never: 0 };
  ctx.loops.forEach((loop, i) => {
    const k = loopClass[i];
    if (k) signed[k] += loop.area;
  });

  // 数值噪声夹取与配平：四类之和必须精确等于视野净面积
  let areasPx = { ...signed };
  for (const k of CLASS_KEYS) {
    if (areasPx[k] < 0 && areasPx[k] > -AREA_TOLERANCE) areasPx[k] = 0;
  }
  let sumPx = CLASS_KEYS.reduce((s, k) => s + areasPx[k], 0);
  const residual = fieldAreaPx - sumPx;
  if (Math.abs(residual) > Math.max(AREA_TOLERANCE, fieldAreaPx * 1e-9)) {
    // 理论上不可达：排列划分必然穷尽视野净区域
    throw new Error(`覆盖变化核对几何校验失败：四类面积之和 ${sumPx} 与视野净面积 ${fieldAreaPx} 不一致`);
  }
  if (Math.abs(residual) > 0) {
    // 优先配平到始终未覆盖（通常为最大类）；若其不足以吸收正残差则按面积加权摊入
    if (residual > 0) {
      areasPx.never += residual;
    } else {
      const deficit = -residual;
      const pool = CLASS_KEYS.filter((k) => areasPx[k] > 0).sort((a, b) => areasPx[b] - areasPx[a]);
      let left = deficit;
      const total = pool.reduce((s, k) => s + areasPx[k], 0) || 1;
      for (const k of pool) {
        const share = (k === pool[pool.length - 1])
          ? left
          : Math.min(left, deficit * areasPx[k] / total);
        areasPx[k] -= share;
        left -= share;
      }
    }
  }
  // 消除 -0
  for (const k of CLASS_KEYS) {
    if (Math.abs(areasPx[k]) <= AREA_TOLERANCE) areasPx[k] = 0;
  }
  sumPx = CLASS_KEYS.reduce((s, k) => s + areasPx[k], 0);

  // ---------- 可叠加区域：逐类收集排列圈（外环/孔洞按有向面积符号自动成套） ----------
  //
  // 同一类的全部圈放进一个 path，用 nonzero 填充规则绘制：外边界 CCW、孔洞 CW，
  // 浏览器/ SVG 自动按绕数扣除孔洞，图形面积与上面的数值一一对应。
  const loopsByClass = { common: [], retest: [], baseline: [], never: [] };

  // 与 ctx.loops 同顺序的闭合顶点（merge-stats 内部同一份半边缘遍历）
  const loopPoints = mergeSvc.traceFaceLoops(ctx);

  ctx.loops.forEach((loop, i) => {
    const k = loopClass[i];
    if (!k || !loopPoints[i]) return;
    if (Math.abs(loop.area) <= AREA_TOLERANCE) return; // 退化零面积圈不画
    loopsByClass[k].push(loopPoints[i].map(roundPoint));
  });

  // ---------- 类边界：两侧归属不同的排列边（无向去重） ----------
  //
  // 对每条无向边取两个半边缘的左采样点分类：两侧同类 → 内部边不画；
  // 两侧不同（含视野外侧 null）→ 实际区域边界。视野外环/孔洞边天然包含在内。
  const edgeSeen = new Set();
  const boundariesByClass = { common: [], retest: [], baseline: [], never: [] };
  for (const he of ctx.halfEdges) {
    const a = he.from;
    const b = he.to;
    const key = a.idx < b.idx ? `${a.idx}|${b.idx}` : `${b.idx}|${a.idx}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    const left = classifyPoint(sideSample(he, ctx.onAnyEdge), field, baseShapes, retestShapes);
    const right = classifyPoint(sideSample(he.twin, ctx.onAnyEdge), field, baseShapes, retestShapes);
    if (left === right) continue;
    const edge = {
      a: roundPoint(a),
      b: roundPoint(b),
      between: [left, right]
    };
    // 该边界关联到出现于任一侧的类：勾选某类时同时高亮其轮廓
    for (const k of CLASS_KEYS) {
      if (left === k || right === k) boundariesByClass[k].push(edge);
    }
  }

  // ---------- 物理面积（基线标尺）与占比 ----------
  const baseScale = isCalibrated(baseline) ? baseline.calib.scale : null;
  const retestScale = isCalibrated(retest) ? retest.calib.scale : null;
  const calibrated = baseScale !== null;
  const ratios = {};
  const areaMm2 = {};
  for (const k of CLASS_KEYS) {
    ratios[k] = fieldAreaPx > 0 ? areasPx[k] / fieldAreaPx : 0;
    areaMm2[k] = calibrated ? px2ToMm2(areasPx[k], baseScale) : null;
  }

  const classes = {};
  for (const k of CLASS_KEYS) {
    classes[k] = {
      key: k,
      label: CLASS_LABELS[k],
      color: CLASS_COLORS[k],
      areaPx: areasPx[k],
      ratio: round(ratios[k], 8),
      percent: round(ratios[k] * 100, 2),
      percentText: `${round(ratios[k] * 100, 2)}%`,
      areaMm2: areaMm2[k],
      areaText: calibrated ? String(round(areaMm2[k])) : '待定标',
      regionLoops: loopsByClass[k],
      boundaryEdges: boundariesByClass[k]
    };
  }

  const scaleMatch = retestScale !== null && baseScale !== null
    ? Math.abs(retestScale - baseScale) <= 1e-12
    : retestScale === baseScale;

  return {
    kind: 'report-field-coverage-diff',
    fieldId: field.id,
    fieldName: (field.name && String(field.name).trim()) || '',
    fieldHoles: Array.isArray(field.holes) ? field.holes.length : 0,
    fieldAreaPx,
    fieldAreaMm2: calibrated ? px2ToMm2(fieldAreaPx, baseScale) : null,
    fieldAreaText: calibrated ? String(round(px2ToMm2(fieldAreaPx, baseScale))) : '待定标',
    classes,
    classOrder: CLASS_KEYS,
    sumAreaPx: round(sumPx, 9),
    sumPercent: round(CLASS_KEYS.reduce((s, k) => s + ratios[k] * 100, 0), 6),
    calibrated,
    scale: {
      basis: 'baseline',
      baselineScaleUmPerPx: baseScale,
      retestScaleUmPerPx: retestScale,
      same: scaleMatch,
      note: scaleMatch
        ? '两份报告冻结标尺一致，物理面积按该标尺（μm/px）由像素面积换算。'
        : (calibrated
          ? `两份报告冻结标尺不同：基线 1 px = ${baseScale} μm，复测 1 px = ${retestScale} μm。` +
            '本核对的全部物理面积（mm²）与占比均以【基线报告冻结标尺】为唯一换算依据，复测标尺不参与换算。'
          : '基线报告缺少有效冻结标尺，物理面积不可换算（待定标）；像素面积与占比照常给出。')
    },
    baselineCellCandidateCount: baseCandidates.length,
    retestCellCandidateCount: retestCandidates.length,
    baselineContributingKeys: contributingKeys(ctx, field, baseCandidates, baseShapes),
    retestContributingKeys: contributingKeys(ctx, field, retestCandidates, retestShapes)
  };
}

// 与视野净区域存在正面积净交集的细胞（仅边界接触/完全在视野孔洞内 → 不列入）。
// 用同一排列的有向面积求和逐细胞判定，与单视野覆盖核对口径一致。
function contributingKeys(ctx, field, candidates, shapes) {
  const keys = [];
  candidates.forEach((entry, ci) => {
    let a = 0;
    for (const loop of ctx.loops) {
      if (!pointInNet(loop.q, field)) continue;
      if (!pointInNet(loop.q, shapes[ci])) continue;
      a += loop.area;
    }
    if (a > EPS) keys.push(cellKey(entry.cell, entry.index));
  });
  return keys;
}

function cellKey(cell, index) {
  return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
}

module.exports = {
  CLASS_KEYS,
  CLASS_LABELS,
  CLASS_COLORS,
  resolveDiffQuery,
  buildCoverageDiff,
  px2ToMm2,
  round
};
