'use strict';

// 已发布报告 · 单视野网格密度分析（只读）
//
// 选择报告冻结的一个取样视野与行×列数（各 1～40），把视野外接矩形等分为 rows×cols 个格子：
//   - 每格有效面积 = 格子矩形与视野净区域（外环扣除孔洞）的几何交集面积，
//     用平面排列（与多视野合并统计/覆盖核对同一实现）精确计算；
//     零面积格保留在结果中，其密度标为「不可计算」；
//   - 细胞归属沿用现有视野统计规则：以细胞扣除孔洞后的净区域质心判定，
//     质心严格落在视野净区域内的细胞才计入该视野，且只分配到质心所在的唯一格子；
//   - 质心落在内部网格线上归右侧/下侧格子，落在最外边线归末格（floor + 夹取实现）；
//     各格计数合计恒等于原视野统计的细胞数。
//
// 只读取报告发布时冻结的视野/细胞/标尺：草稿后续修改或报告更正都不改变本结果。
// 本模块只包含纯逻辑（校验、网格划分、面积与计数），HTTP 层在 index.js 中。

const geo = require('./geometry');
const mergeSvc = require('./merge-stats');
const fieldsSvc = require('./fields');

const MAX_GRID = 40;                 // 行/列数上限（各 1～40）
const NON_COMPUTABLE = '不可计算';   // 零面积格的密度展示
const PENDING = '待定标';
// 各格有效面积合计与视野净面积的数值残差容忍（坐标精度 1e-3，与覆盖变化核对一致）
const AREA_TOLERANCE = 1e-6;

function round(v, n = 6) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// ---------- 请求校验 ----------

// 校验行数/列数：必须是 1～40 的整数（数值字符串按数值接受）。
// 非法时抛出 {status, message}，由路由映射为 HTTP 400。
function validateGridDimension(raw, label) {
  const v = (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : raw;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw {
      status: 400,
      message: `网格密度分析请求无效：${label} 必须是 1～${MAX_GRID} 的整数（收到 ${raw === undefined ? '缺失' : JSON.stringify(raw)}），请求被拒绝`
    };
  }
  if (!Number.isInteger(v)) {
    throw {
      status: 400,
      message: `网格密度分析请求无效：${label} 必须是整数（收到 ${v}），请求被拒绝`
    };
  }
  if (v < 1 || v > MAX_GRID) {
    throw {
      status: 400,
      message: `网格密度分析请求无效：${label} 超出范围，必须在 1～${MAX_GRID} 之间（收到 ${v}），请求被拒绝`
    };
  }
  return v;
}

// 解析视野标识：先按 id 精确匹配，再按名称（trim 后）精确匹配。
// 空标识 / 不存在 / 名称重名均抛出明确错误（由接口层返回 400）。返回 {field, index, matchBy}。
function resolveGridField(fields, identifier) {
  const all = Array.isArray(fields) ? fields : [];
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw { status: 400, message: '网格密度分析请求无效：fieldId 必须为非空的视野标识（id 或视野名称）' };
  }
  const byIdIndex = all.findIndex((f) => f && typeof f.id === 'string' && f.id === identifier);
  if (byIdIndex >= 0) {
    // 按 id 命中但该 id 在报告内重复（防护上线前的历史报告）→ 身份歧义，拒绝；
    // 不再静默取第一个。按唯一名称查询的路径在下方，不受此限。
    const dupPositions = all.reduce((acc, f, i) => {
      if (f && typeof f.id === 'string' && f.id === identifier) acc.push(i + 1);
      return acc;
    }, []);
    if (dupPositions.length > 1) {
      throw {
        status: 400,
        message: `视野标识存在身份歧义：id「${identifier}」同时用于第 ${dupPositions.join('、')} 个视野，` +
          '按 id 无法确定指的是哪一个视野（不同分析会取到不同视野，结果互相矛盾），请求被拒绝；' +
          '可改用该视野的唯一名称查询；历史报告保持冻结不变'
      };
    }
    return { field: all[byIdIndex], index: byIdIndex, matchBy: 'id' };
  }
  const name = identifier.trim();
  const nameMatches = [];
  all.forEach((f, i) => {
    if (f && typeof f.name === 'string' && f.name.trim() === name) nameMatches.push(i);
  });
  if (nameMatches.length === 1) return { field: all[nameMatches[0]], index: nameMatches[0], matchBy: 'name' };
  if (nameMatches.length > 1) {
    throw {
      status: 400,
      message: `视野名称「${name}」在本报告中存在 ${nameMatches.length} 个同名视野，` +
        '无法唯一确定，请改用视野 id 查询（可在报告详情的 fields 中获取）'
    };
  }
  throw {
    status: 400,
    message: `视野标识不存在：${identifier}（不属于该报告；请使用本报告发布时冻结的视野 id 或名称），请求被拒绝`
  };
}

// ---------- 网格归属 ----------

// 点归入唯一格子：内部网格线上的点归右侧/下侧格子（floor 语义），
// 最外边线上的点归末格（夹取实现；左侧/上侧边线自然归首格）。
function gridIndexFor(p, bounds, rows, cols) {
  const w = (bounds.maxX - bounds.minX) / cols;
  const h = (bounds.maxY - bounds.minY) / rows;
  let col = Math.floor((p.x - bounds.minX) / w);
  let row = Math.floor((p.y - bounds.minY) / h);
  if (!(col >= 0)) col = 0;
  else if (col >= cols) col = cols - 1;
  if (!(row >= 0)) row = 0;
  else if (row >= rows) row = rows - 1;
  return { row, col, index: row * cols + col };
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

// ---------- 网格密度分析 ----------

// field：目标视野（已解析）；fieldIndex：视野在 fields 中的序号（用于原视野统计标签）；
// cells：报告冻结的全部细胞；scale：μm/px（报告冻结定标）；rows/cols：已校验的网格行列数。
// 返回每格有效面积（px²/mm²）、细胞数、密度与叠加几何；不写任何数据。
function buildFieldGrid(field, fieldIndex, cells, scale, rows, cols) {
  const holes = Array.isArray(field.holes) ? field.holes : [];
  // 视野外接矩形：孔洞严格位于外环内，外环包围盒即净区域包围盒
  const bounds = ringBBox(field.outer);
  const cellW = (bounds.maxX - bounds.minX) / cols;
  const cellH = (bounds.maxY - bounds.minY) / rows;

  // 平面排列：视野 + 外接矩形 + 内部网格线（2 点“环”即一条线段，与合并统计同一实现）。
  // 网格线成为排列边后，每个面要么完全落在某个格子内，要么在外接矩形之外。
  const shapes = [field, {
    outer: [
      { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }
    ],
    holes: []
  }];
  for (let c = 1; c < cols; c++) {
    const x = bounds.minX + c * cellW;
    shapes.push({ outer: [{ x, y: bounds.minY }, { x, y: bounds.maxY }], holes: [] });
  }
  for (let r = 1; r < rows; r++) {
    const y = bounds.minY + r * cellH;
    shapes.push({ outer: [{ x: bounds.minX, y }, { x: bounds.maxX, y }], holes: [] });
  }
  const ctx = mergeSvc.buildArrangement(shapes);

  // 每格有效面积：排列圈左侧采样点落在视野净区域内时，按圈方向（外正内负）
  // 把圈面积计入该点所在格子——孔洞/嵌套由符号自动处理，格子外接矩形之外的面不计入。
  const areaByIndex = new Float64Array(rows * cols);
  for (const loop of ctx.loops) {
    if (!fieldsSvc.pointInFieldNet(loop.q, field)) continue;
    areaByIndex[gridIndexFor(loop.q, bounds, rows, cols).index] += loop.area;
  }

  // 视野净面积（与逐视野统计同公式）；各格合计必须与其一致（划分穷尽视野净区域）
  const fieldAreaPx = Math.abs(geo.signedArea(field.outer)) -
    holes.reduce((s, h) => s + Math.abs(geo.signedArea(h)), 0);
  let sumAreaPx = 0;
  for (const a of areaByIndex) sumAreaPx += a;
  const residual = fieldAreaPx - sumAreaPx;
  if (Math.abs(residual) > Math.max(AREA_TOLERANCE, fieldAreaPx * 1e-9)) {
    // 理论上不可达：网格线把视野净区域切分到各格，合计必然等于净面积
    throw new Error(`网格密度分析几何校验失败：各格有效面积之和 ${sumAreaPx} 与视野净面积 ${fieldAreaPx} 不一致`);
  }

  // 细胞归属：沿用现有视野统计的净区域质心规则（同一批质心、同一个 pointInFieldNet），
  // 只把计入该视野的细胞分配到质心所在的唯一格子。
  const safeCells = Array.isArray(cells) ? cells : [];
  const centroids = fieldsSvc.computeCentroids(safeCells);
  const keysByIndex = new Map();
  const centroidMarks = [];
  let totalCounted = 0;
  safeCells.forEach((cell, i) => {
    const ctr = centroids[i];
    if (!ctr) return; // 净面积为零的细胞没有良定义质心，不计入任何格子
    if (!fieldsSvc.pointInFieldNet(ctr, field)) return; // 与逐视野统计同一归属规则
    const g = gridIndexFor(ctr, bounds, rows, cols);
    const key = fieldsSvc.cellKey(cell, i);
    if (!keysByIndex.has(g.index)) keysByIndex.set(g.index, []);
    keysByIndex.get(g.index).push(key);
    centroidMarks.push({ key, x: round3(ctr.x), y: round3(ctr.y), row: g.row, col: g.col });
    totalCounted += 1;
  });

  // 不变量：各格计数合计必须等于原视野统计的细胞数（同一归属规则，必然成立）
  const fieldStat = fieldsSvc.statsForField(field, fieldIndex, safeCells, centroids, scale);
  if (fieldStat.cellCount !== totalCounted) {
    throw new Error('网格密度分析内部校验失败：各格计数合计与原视野统计不一致');
  }

  const calibrated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;
  const cellsOut = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c;
      let areaPx = areaByIndex[index];
      if (areaPx < 0 && areaPx > -AREA_TOLERANCE) areaPx = 0; // 数值噪声夹取
      areaPx = round(areaPx);
      const zeroArea = !(areaPx > 0);
      const keys = keysByIndex.get(index) || [];
      const areaMm2 = calibrated ? fieldsSvc.px2ToMm2(areaPx, scale) : null;
      const densityPerMm2 = calibrated && areaMm2 > 0 ? keys.length / areaMm2 : null;
      cellsOut.push({
        row: r,
        col: c,
        index,
        rect: {
          x0: round3(bounds.minX + c * cellW),
          y0: round3(bounds.minY + r * cellH),
          x1: round3(bounds.minX + (c + 1) * cellW),
          y1: round3(bounds.minY + (r + 1) * cellH)
        },
        areaPx,
        areaMm2,
        areaText: calibrated ? String(round(areaMm2)) : PENDING,
        zeroArea,
        cellCount: keys.length,
        countedCellKeys: keys,
        densityPerMm2,
        // 零面积格的密度标为「不可计算」（保留该格，计数必为 0）
        densityText: zeroArea ? NON_COMPUTABLE : (calibrated ? String(round(densityPerMm2, 4)) : PENDING)
      });
    }
  }

  // 叠加几何：网格线（含最外边线）与计入细胞的质心位置，供页面在冻结图片上绘制
  const verticalLines = [];
  for (let c = 0; c <= cols; c++) verticalLines.push(round3(bounds.minX + c * cellW));
  const horizontalLines = [];
  for (let r = 0; r <= rows; r++) horizontalLines.push(round3(bounds.minY + r * cellH));

  return {
    kind: 'field-grid',
    fieldId: field.id,
    fieldName: (field.name && String(field.name).trim()) || '',
    fieldHoles: holes.length,
    rows,
    cols,
    bounds: {
      minX: round3(bounds.minX), minY: round3(bounds.minY),
      maxX: round3(bounds.maxX), maxY: round3(bounds.maxY)
    },
    cellWidthPx: round(cellW),
    cellHeightPx: round(cellH),
    fieldAreaPx,
    fieldAreaMm2: calibrated ? fieldsSvc.px2ToMm2(fieldAreaPx, scale) : null,
    fieldAreaText: calibrated ? String(round(fieldsSvc.px2ToMm2(fieldAreaPx, scale))) : PENDING,
    // 原视野统计细胞数与各格计数合计（不变量：二者相等）
    fieldCellCount: fieldStat.cellCount,
    sumCellCount: totalCounted,
    // 各格有效面积合计（＝视野净面积，数值残差已在上面校验）
    sumAreaPx: round(sumAreaPx),
    cells: cellsOut,
    overlay: {
      verticalLines,
      horizontalLines,
      centroids: centroidMarks
    },
    calibrated
  };
}

module.exports = {
  MAX_GRID,
  NON_COMPUTABLE,
  validateGridDimension,
  resolveGridField,
  gridIndexFor,
  buildFieldGrid,
  round
};
