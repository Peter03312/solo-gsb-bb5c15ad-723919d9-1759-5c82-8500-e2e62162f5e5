'use strict';

// 已发布报告 · 单视野「最近质心责任区」分析（只读）
//
// 选择报告冻结的一个取样视野，把视野【净区域】（外环扣除孔洞）按【像素欧氏距离】
// 分配给距离最近的【计入细胞】（沿用现有净区域质心与视野严格归属规则）：
//   - 计入细胞 = 细胞扣除孔洞后的净区域质心【严格】落在该视野净区域内（严格在外环内、
//     不在任何孔洞内或边界上）；与 fields.statsForField 同一批质心、同一个判定；
//   - 每个净区域内部点归唯一的最近计入细胞：Voronoi（半平面逐对求交）天然只产生
//     【内部】归属，等距边界（平分线本身）没有面积、不计入任何细胞；
//   - 视野孔洞内部与视野外部一律不分配；
//   - 质心重合时按【报告细胞顺序】由首个细胞占有该位置，其余细胞保留零面积记录；
//   - 有计入细胞时各区【实际】像素面积合计恒等于视野净面积（外正内负有向面积求和）。
//
// 责任区几何用平面排列精确重建（与多视野合并统计/网格密度/覆盖核对同一实现）：
// 每个细胞位置 Ci 与大边界框、其余位置的平分线构成凸多边形，再与视野（外环+孔洞）
// 做排列；取 Ci 严格在内的面（外正内负有向面积求和）即该细胞的实际责任区。
// 只读取报告发布时冻结的视野/细胞/标尺：草稿后续修改或报告更正都不改变本结果。

const geo = require('./geometry');
const mergeSvc = require('./merge-stats');
const fieldsSvc = require('./fields');

const EPS = 1e-9;
// 各区面积合计与视野净面积的数值残差容忍（坐标精度 1e-3，与网格密度分析一致）
const AREA_TOLERANCE = 1e-6;
// 质心重合判定：报告坐标精度 1e-3，质心由顶点公式算出；1e-6 px 远小于数据精度
const COINCIDENT_EPS = 1e-6;
const PENDING = '待定标';

function round(v, n = 6) {
  // toFixed 再转回：规避 0.1 类二进制浮点尾巴（如 0.009900000000000003）
  return Number(Math.round(v * 10 ** n) / 10 ** n);
}

// 修约后转字符串：先 toFixed 去掉二进制尾巴，再去掉多余的尾零
function roundText(v, n = 6) {
  return Number((Math.round(v * 10 ** n) / 10 ** n).toFixed(n)).toString();
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
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

// ---------- 请求校验：视野标识解析（id 优先精确匹配，再按名称） ----------
//
// 与 field-grid.resolveGridField 同一语义：空标识 / 不存在 / 名称重名均抛出
// {status:400, message}，由接口层返回 400。返回 {field, index, matchBy}。
function resolveZonesField(fields, identifier) {
  const all = Array.isArray(fields) ? fields : [];
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw { status: 400, message: '最近质心责任区分析请求无效：fieldId 必须为非空的视野标识（id 或视野名称）' };
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

// ---------- Voronoi 细胞（半平面逐对求交） ----------

// 半平面 H(si, sj)：距离 si 不大于 sj 的一侧（等距边界包含在内，但边界无面积）。
// 即 2(sj-si)·p <= |sj|²-|si|²。
// Sutherland–Hodgman 逐半平面求交：主体始终为凸多边形；边界点（inside）保留。
function clipByHalfPlane(poly, si, sj) {
  const dx = sj.x - si.x;
  const dy = sj.y - si.y;
  // f(p) = 2(sj-si)·p - (|sj|²-|si|²)；f <= 0 即在 si 一侧
  const rhs = sj.x * sj.x + sj.y * sj.y - si.x * si.x - si.y * si.y;
  const f = (p) => 2 * (dx * p.x + dy * p.y) - rhs;

  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const fa = f(a);
    const fb = f(b);
    const inA = fa <= EPS;
    const inB = fb <= EPS;
    if (inA && inB) {
      out.push(b);
    } else if (inA && !inB) {
      // a 在内侧、b 在外侧：求交（边界点本身也加入，数值上 fa≈0 时 t≈0）
      const t = fa / (fa - fb);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    } else if (!inA && inB) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      out.push(b);
    }
  }
  // 去除连续重复点（退化为 < 3 点时调用方据此判空）
  const cleaned = [];
  for (const p of out) {
    const q = cleaned[cleaned.length - 1];
    if (!q || Math.abs(q.x - p.x) > EPS || Math.abs(q.y - p.y) > EPS) cleaned.push(p);
  }
  if (cleaned.length >= 2) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS) cleaned.pop();
  }
  return cleaned;
}

// 位置 p 处的 Voronoi 细胞：与一个覆盖视野的大矩形求交，保证结果有界；
// 再依次与其余位置的平分线求交。others 为去重后的其它计入位置。
function voronoiCell(p, others, clipBox) {
  let poly = clipBox.slice();
  for (const q of others) {
    poly = clipByHalfPlane(poly, p, q);
    if (poly.length < 3) return poly; // 已为空（防御；位置在视野内时不应发生）
  }
  return poly;
}

// ---------- 实际责任区：Voronoi 细胞 ∩ 视野净区域（平面排列精确重建） ----------
//
// 一次排列同时给出面积与几何：位置 p 严格在 Voronoi 细胞内、且在视野净区域内的圈
// 归该细胞（外正内负有向面积求和，孔洞自动扣除；落在平分线上的圈不归属）。
// 返回 {areaPx, loops}（loops 为实际圈顶点数组，方向外正内负）。
function intersectCellWithField(cellPoly, field) {
  // 形状 0 = 视野；形状 1 = 该位置的 Voronoi 凸多边形
  const ctx = mergeSvc.buildArrangement([field, { outer: cellPoly, holes: [] }]);
  const allLoops = mergeSvc.traceFaceLoops(ctx);
  let areaPx = 0;
  const loops = [];
  ctx.loops.forEach((loop, i) => {
    if (!fieldsSvc.pointInFieldNet(loop.q, field)) return;
    // Voronoi 细胞内部（严格）：落在线上的面（等距边界）不归属任何细胞
    if (!geo.pointStrictlyInside(loop.q, cellPoly)) return;
    areaPx += loop.area; // 有向面积自带符号：外圈 CCW +、孔洞内圈 CW −
    if (allLoops[i]) loops.push(allLoops[i]);
  });
  return { areaPx, loops };
}

// ---------- 主分析 ----------
//
// field：目标视野（已解析）；fieldIndex：视野序号（用于原视野统计对照）；
// cells：报告冻结的全部细胞；scale：μm/px（报告冻结定标）。
// 只读，不写任何数据。
function buildFieldZones(field, fieldIndex, cells, scale) {
  const holes = Array.isArray(field.holes) ? field.holes : [];
  const safeCells = Array.isArray(cells) ? cells : [];

  // 计入细胞：与逐视野统计同一批净区域质心、同一个严格归属判定
  const centroids = fieldsSvc.computeCentroids(safeCells);
  const counted = []; // {index, cell, centroid}
  safeCells.forEach((cell, i) => {
    const ctr = centroids[i];
    if (!ctr) return; // 净面积非正的细胞没有良定义质心
    if (fieldsSvc.pointInFieldNet(ctr, field)) counted.push({ index: i, cell, centroid: ctr });
  });

  // 视野净面积（与逐视野统计/网格密度同公式）
  const fieldAreaPx = Math.abs(geo.signedArea(field.outer)) -
    holes.reduce((s, h) => s + Math.abs(geo.signedArea(h)), 0);

  const calibrated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;

  // 无计入细胞：返回空结果（不分配任何区域），由接口层附带空结果提示
  if (counted.length === 0) {
    return {
      kind: 'field-zones',
      fieldId: field.id,
      fieldName: (field.name && String(field.name).trim()) || '',
      fieldHoles: holes.length,
      fieldAreaPx: round(fieldAreaPx),
      fieldAreaMm2: calibrated ? round(fieldsSvc.px2ToMm2(fieldAreaPx, scale)) : null,
      fieldAreaText: calibrated ? roundText(fieldsSvc.px2ToMm2(fieldAreaPx, scale)) : PENDING,
      countedCellCount: 0,
      empty: true,
      message: '该视野净区域内没有计入细胞（没有任何细胞的净区域质心严格落在其中），视野净区域不分配，结果为空。',
      zones: [],
      sumAreaPx: 0,
      sumAreaMm2: calibrated ? 0 : null,
      calibrated
    };
  }

  // 质心重合分组：按报告细胞顺序，首个位置为占有者，其余保留零面积记录
  const sites = []; // 占有位置：{index, cell, centroid, followers:[]}
  counted.forEach((entry) => {
    const owner = sites.find((s) =>
      Math.abs(s.centroid.x - entry.centroid.x) <= COINCIDENT_EPS &&
      Math.abs(s.centroid.y - entry.centroid.y) <= COINCIDENT_EPS);
    if (owner) owner.followers.push(entry);
    else sites.push({ ...entry, followers: [] });
  });

  // 覆盖视野的大矩形：取视野外环包围盒外扩一倍尺寸（平分线只在视野内部相交，
  // 边界框只负责把 Voronoi 细胞限制为有界凸多边形），坐标量级仍为图像像素量级。
  const b = ringBBox(field.outer);
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const margin = Math.max(bw, bh) + 1;
  const clipBox = [
    { x: b.minX - margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.maxY + margin },
    { x: b.minX - margin, y: b.maxY + margin }
  ];

  // 逐占有位置：Voronoi 细胞 → 与视野排列 → 实际责任区面积与几何
  const zoneEntries = [];
  sites.forEach((site) => {
    const others = sites
      .filter((s) => s !== site)
      .map((s) => s.centroid);
    const cellPoly = voronoiCell(site.centroid, others, clipBox);
    if (cellPoly.length < 3) {
      // 防御：占有位置在视野内时其 Voronoi 细胞必有包含该点的正面积邻域
      zoneEntries.push({ site, cellPoly, areaPx: 0, loops: [] });
      return;
    }
    const hit = intersectCellWithField(cellPoly, field);
    let areaPx = hit.areaPx;
    if (areaPx < 0 && areaPx > -AREA_TOLERANCE) areaPx = 0; // 数值噪声夹取
    zoneEntries.push({ site, cellPoly, areaPx, loops: hit.loops });
  });

  // 不变量：各占有区面积合计必须等于视野净面积（内部按距离穷举划分；等距边界无面积）
  const sumAreaRaw = zoneEntries.reduce((s, z) => s + z.areaPx, 0);
  const residual = fieldAreaPx - sumAreaRaw;
  if (Math.abs(residual) > Math.max(AREA_TOLERANCE, fieldAreaPx * 1e-9)) {
    // 理论上不可达：平分线把视野净区域切分给各最近位置，孔洞内外由有向面积自动处理
    throw new Error(`最近质心责任区几何校验失败：各区面积之和 ${sumAreaPx} 与视野净面积 ${fieldAreaPx} 不一致`);
  }

  // 原视野统计细胞数（同一归属规则），用于响应中的对照
  const fieldStat = fieldsSvc.statsForField(field, fieldIndex, safeCells, centroids, scale);

  // ---- 输出：先按全精度组装，再统一修约，最大余额法保证修约后合计严格相等 ----
  const rawZones = [];
  sites.forEach((site, si) => {
    const entry = zoneEntries[si];
    const pieces = [];
    const holeLoops = [];
    for (const loop of entry.loops) {
      const signed = geo.signedArea(loop);
      if (Math.abs(signed) <= AREA_TOLERANCE) continue; // 数值退化圈不输出
      const pts = loop.map(roundPoint);
      if (signed > 0) pieces.push(pts);
      else holeLoops.push(pts);
    }
    rawZones.push({
      site,
      areaPx: entry.areaPx,
      pieces,
      holes: holeLoops,
      followers: site.followers
    });
  });

  // 像素面积修约：最大余额法保证修约后 ΣareaPx 严格等于修约后的视野净面积
  const fieldAreaPxRounded = round(fieldAreaPx, 6);
  const roundedPx = largestRemainder(rawZones.map((z) => z.areaPx), fieldAreaPxRounded, 6);
  // mm² 面积同样独立按最大余额法修约（mm² 与 px 成固定比例），
  // 保证 ΣareaMm2 严格等于修约后的视野净面积 mm²（不受各区 px 修约 + 再换算的误差影响）
  const fieldAreaMm2Value = calibrated ? fieldsSvc.px2ToMm2(fieldAreaPx, scale) : null;
  const roundedMm2 = calibrated
    ? largestRemainder(rawZones.map((z) => fieldsSvc.px2ToMm2(z.areaPx, scale)),
        round(fieldAreaMm2Value, 6), 6)
    : null;

  const zoneOut = rawZones.map((z, i) => {
    const areaPx = roundedPx[i];
    const areaMm2 = calibrated ? roundedMm2[i] : null;
    return {
      key: fieldsSvc.cellKey(z.site.cell, z.site.index),
      name: z.site.cell.name || '',
      seq: z.site.index + 1,                 // 报告细胞顺序（1 基）
      cellIndex: z.site.index,              // 0 基，与报告 cells 数组对应
      centroid: { x: round3(z.site.centroid.x), y: round3(z.site.centroid.y) },
      areaPx,
      areaMm2,
      areaText: calibrated ? roundText(areaMm2) : PENDING,
      // 占比在拿到全部分区面积后统一填（下方最大余额法）
      ratio: null,
      ratioText: null,
      percent: null,
      percentText: null,
      zeroArea: !(areaPx > 0),
      coincident: false,
      coincidentWith: [],
      geometry: { pieces: z.pieces, holes: z.holes, loops: z.pieces.concat(z.holes) }
    };
  });

  // 质心重合的跟随细胞：保留零面积记录（按报告细胞顺序排在占有者之后）
  const followerOut = [];
  rawZones.forEach((z, i) => {
    z.followers.forEach((f) => {
      followerOut.push({
        ownerZoneIndex: i,
        key: fieldsSvc.cellKey(f.cell, f.index),
        name: f.cell.name || '',
        seq: f.index + 1,
        cellIndex: f.index,
        centroid: { x: round3(f.centroid.x), y: round3(f.centroid.y) },
        areaPx: 0,
        areaMm2: calibrated ? 0 : null,
        areaText: calibrated ? '0' : PENDING,
        ratio: 0,
        ratioText: '0',
        percent: 0,
        percentText: '0',
        zeroArea: true,
        coincident: true,
        coincidentWith: [zoneOut[i].key],
        geometry: { pieces: [], holes: [], loops: [] }
      });
      zoneOut[i].coincidentWith.push(fieldsSvc.cellKey(f.cell, f.index));
    });
  });

  // 占比 = 区面积 / 视野净面积；最大余额法保证修约后合计严格为 1（/100）
  const rawRatios = rawZones.map((z) => (fieldAreaPx > 0 ? z.areaPx / fieldAreaPx : 0));
  const roundedRatios = largestRemainder(rawRatios, 1, 6);
  const roundedPercents = largestRemainder(rawRatios.map((v) => v * 100), 100, 2);
  zoneOut.forEach((z, i) => {
    z.ratio = roundedRatios[i];
    z.ratioText = String(roundedRatios[i]); // largestRemainder 已按 toFixed 去浮点尾巴
    z.percent = roundedPercents[i];
    z.percentText = `${roundedPercents[i]}%`;
  });

  // 最终返回顺序：按报告细胞顺序（占有者按其位置，跟随者紧跟其后），便于与表格对照
  const allOut = zoneOut.concat(followerOut);
  allOut.sort((a, b) => a.cellIndex - b.cellIndex);

  // 给前端叠加用的紧凑几何（占有者才有）；质心标记含全部计入细胞
  const ownerZones = allOut.filter((z) => !z.coincident);
  const overlay = {
    zones: ownerZones.map((z, i) => ({
      key: z.key,
      colorIndex: zoneOut.findIndex((x) => x.key === z.key),
      loops: z.geometry.loops,
      centroid: z.centroid
    })),
    centroids: counted.map((entry) => ({
      key: fieldsSvc.cellKey(entry.cell, entry.index),
      x: round3(entry.centroid.x),
      y: round3(entry.centroid.y)
    }))
  };

  // 像素面积合计（按修约整数单位重算，保证严格等于 fieldAreaPx，规避浮点累加误差）
  const sumAreaPx = Number((roundedPx.reduce((s, v) => s + Math.round(v * 1e6), 0) / 1e6).toFixed(6));
  // mm² 合计直接取各区修约值的整数单位之和，保证严格等于 fieldAreaMm2
  const sumAreaMm2 = calibrated
    ? Number((roundedMm2.reduce((s, v) => s + Math.round(v * 1e6), 0) / 1e6).toFixed(6))
    : null;
  // 未计入细胞（质心缺失或不在视野净区域内）：仅给摘要，不给分区
  const excluded = [];
  safeCells.forEach((cell, i) => {
    const ctr = centroids[i];
    if (counted.some((e) => e.index === i)) return;
    excluded.push({
      key: fieldsSvc.cellKey(cell, i),
      name: cell.name || '',
      seq: i + 1,
      cellIndex: i,
      reason: !ctr ? '净面积非正，无良定义质心，不计入任何视野'
        : '净区域质心在视野外部或孔洞/边界上，未计入该视野'
    });
  });

  return {
    kind: 'field-zones',
    fieldId: field.id,
    fieldName: (field.name && String(field.name).trim()) || '',
    fieldHoles: holes.length,
    fieldAreaPx: round(fieldAreaPx),
    fieldAreaMm2: calibrated ? round(fieldsSvc.px2ToMm2(fieldAreaPx, scale)) : null,
    fieldAreaText: calibrated ? roundText(fieldsSvc.px2ToMm2(fieldAreaPx, scale)) : PENDING,
    fieldCellCount: fieldStat.cellCount,   // 原视野统计细胞数（含质心重合的每个细胞）
    countedCellCount: counted.length,
    ownerCellCount: sites.length,
    coincidentCellCount: counted.length - sites.length,
    excludedCellCount: excluded.length,
    empty: false,
    message: null,
    // 每个计入细胞一条记录（占有者有实际分区；质心重合的跟随者零面积）；
    // 有计入细胞时各区面积合计 === 视野净面积
    zones: allOut,
    excludedCells: excluded,
    sumAreaPx,
    sumAreaMm2,
    sumAreaText: calibrated ? roundText(sumAreaMm2) : PENDING,
    // 修约后的占比合计：直接按修约整数单位给出，规避 JS 浮点累加误差（如 33.33+33.33+33.34）
    sumRatio: Number(roundedRatios.reduce((s, v) => s + Math.round(v * 1e6), 0) / 1e6),
    sumPercent: Number(roundedPercents.reduce((s, v) => s + Math.round(v * 100), 0) / 100),
    overlay,
    calibrated
  };
}

// 最大余额法：把 rawValues 按 decimals 位修约，并把「目标值修约后 − 各项修约值之和」
// 的残差（整数个修约单位）按小数余额从大到小逐项补/扣，保证返回值之和严格等于目标修约值。
function largestRemainder(rawValues, target, decimals) {
  const f = 10 ** decimals;
  const t = Math.round(target * f);
  const floors = rawValues.map((v) => Math.floor(v * f)); // 向下取整后的整数单位
  let remainderUnits = t - floors.reduce((s, v) => s + v, 0);
  // 各项小数余额（0～1 个单位），从大到小补单位；残差为负时从小到大扣单位
  const order = rawValues
    .map((v, i) => ({ i, frac: v * f - floors[i] }))
    .sort((a, b) => b.frac - a.frac)
    .map((x) => x.i);
  const units = floors.slice();
  if (remainderUnits >= 0) {
    for (let k = 0; k < remainderUnits && k < order.length; k++) units[order[k]] += 1;
  } else {
    for (let k = 0; k < -remainderUnits && k < order.length; k++) units[order[order.length - 1 - k]] -= 1;
  }
  // 直接按修约小数位转字符串再转回，避免 0.1+0.2 类二进制累加误差
  return units.map((u) => Number((u / f).toFixed(decimals)));
}

function roundPoint(p) {
  return { x: round3(p.x), y: round3(p.y) };
}

module.exports = {
  PENDING,
  COINCIDENT_EPS,
  resolveZonesField,
  clipByHalfPlane,
  voronoiCell,
  intersectCellWithField,
  buildFieldZones,
  largestRemainder,
  round
};
