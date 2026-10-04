'use strict';

// 单视野「最近质心责任区」纯逻辑自测（node test-field-zones.js）：
// 视野标识解析（id/名称/重名/不存在/空标识）、Voronoi 半平面求交、
// 责任区面积（含孔洞扣除、L 形视野、各区合计＝净面积）、最近归属（随机点核验）、
// 等距边界零面积、质心重合（首个占有 + 其余零面积记录）、无计入细胞空结果、
// 未计入细胞原因、占比/百分比修约合计严格为 1/100、mm² 换算与未定标。
const assert = require('assert');
const geo = require('./server/geometry');
const zones = require('./server/field-zones');

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const cell = (id, outer, holes = []) => ({ id, name: id, outer, holes });
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 1. 视野标识解析（与 field-grid 同一语义） ----------

const fields1 = [
  { id: 'f1', name: '中心视野', outer: rect(0, 0, 10, 10), holes: [] },
  { id: 'f2', name: '同名', outer: rect(0, 0, 10, 10), holes: [] },
  { id: 'f3', name: '同名', outer: rect(0, 0, 10, 10), holes: [] }
];
assert.strictEqual(zones.resolveZonesField(fields1, 'f1').field.id, 'f1');
assert.strictEqual(zones.resolveZonesField(fields1, 'f1').matchBy, 'id');
assert.strictEqual(zones.resolveZonesField(fields1, ' 中心视野 ').matchBy, 'name');
assert.strictEqual(zones.resolveZonesField(fields1, 'f2').matchBy, 'id'); // id 优先
assert.throws(() => zones.resolveZonesField(fields1, '同名'),
  (e) => e.status === 400 && /2 个同名视野/.test(e.message) && /改用视野 id/.test(e.message));
assert.throws(() => zones.resolveZonesField(fields1, 'ghost'),
  (e) => e.status === 400 && /视野标识不存在：ghost/.test(e.message));
for (const bad of [undefined, null, '', '   ', 5]) {
  assert.throws(() => zones.resolveZonesField(fields1, bad),
    (e) => e.status === 400 && /非空的视野标识/.test(e.message), `空标识 ${String(bad)}`);
}
console.log('ok 1 视野标识解析：id 优先、名称 trim、重名/不存在/空标识明确报错');

// ---------- 2. 半平面求交：两个位置的平分线把矩形均分 ----------

{
  const box = rect(0, 0, 100, 100);
  const left = zones.voronoiCell({ x: 25, y: 50 }, [{ x: 75, y: 50 }], box);
  assert(approx(Math.abs(geo.signedArea(left)), 5000), `左侧半平面面积 ${Math.abs(geo.signedArea(left))}`);
  // 平分线上的点 (50, y) 恰在多边形上；左侧多边形所有顶点 x <= 50
  assert(left.every((p) => p.x <= 50 + 1e-9), '左侧半平面不过平分线');
  const right = zones.voronoiCell({ x: 75, y: 50 }, [{ x: 25, y: 50 }], box);
  assert(approx(Math.abs(geo.signedArea(right)), 5000), `右侧半平面面积 ${Math.abs(geo.signedArea(right))}`);
  assert(right.every((p) => p.x >= 50 - 1e-9), '右侧半平面不过平分线');
  console.log('ok 2 Voronoi 半平面求交：两点平分线把矩形等分为两半（边界线不计入任一侧内部）');
}

// ---------- 3. 矩形视野（含孔洞）四细胞：面积合计＝净面积，几何随机点核验最近归属 ----------

// 视野 100×100 含 10×10 孔洞 (80,80)：净面积 9900；质心 (15,15)/(65,15)/(15,65)/(65,65)
const fieldR = { id: 'fR', name: '矩形视野', outer: rect(0, 0, 100, 100), holes: [rect(80, 80, 10, 10)] };
const cells3 = [
  cell('A', rect(10, 10, 10, 10)),
  cell('B', rect(60, 10, 10, 10)),
  cell('C', rect(10, 60, 10, 10)),
  cell('D', rect(60, 60, 10, 10)),
  cell('H', rect(82, 82, 6, 6)),    // 质心在视野孔洞内 → 不计入
  cell('O', rect(200, 200, 10, 10)) // 质心在视野外 → 不计入
];
let r3;
{
  r3 = zones.buildFieldZones(fieldR, 0, cells3, 1); // 1 px = 1 μm
  assert.strictEqual(r3.kind, 'field-zones');
  assert.strictEqual(r3.empty, false);
  assert.strictEqual(r3.countedCellCount, 4);
  assert.strictEqual(r3.ownerCellCount, 4);
  assert.strictEqual(r3.fieldCellCount, 4); // 与原视野统计同口径
  assert.strictEqual(r3.excludedCellCount, 2);
  assert(approx(r3.fieldAreaPx, 9900), `视野净面积 ${r3.fieldAreaPx}`);
  assert(approx(r3.sumAreaPx, 9900), `各区合计 ${r3.sumAreaPx}`);
  assert.strictEqual(r3.sumAreaPx, 9900, '修约后合计严格等于修约净面积');
  assert.strictEqual(r3.sumRatio, 1);
  assert.strictEqual(r3.sumPercent, 100);
  // 孔洞靠近 D：D 的分区几何应带一个内圈（孔洞在其责任区内）
  const byKey = Object.fromEntries(r3.zones.map((z) => [z.key, z]));
  assert(byKey.D.geometry.pieces.length >= 1 && byKey.D.geometry.holes.length >= 1,
    'D 责任区含孔洞内圈');
  // 几何圈的有向面积之和等于该细胞的面积（面积数值用全精度，几何顶点修约到 0.001 px，
  // 100×100 图上误差远小于 0.01 px²；大坐标图上允许 O(周长×1e-3) 的统一坐标精度误差）
  for (const z of r3.zones) {
    const loopsArea = z.geometry.loops.reduce((s, l) => s + geo.signedArea(l), 0);
    assert(Math.abs(loopsArea - z.areaPx) <= 0.01,
      `${z.key} 几何圈面积 ${loopsArea} 与面积 ${z.areaPx} 一致`);
  }
  // mm²：1 px = 1 μm → 1 px² = 1e-6 mm²
  assert(approx(r3.fieldAreaMm2, 0.0099), `fieldAreaMm2 ${r3.fieldAreaMm2}`);
  assert(approx(r3.sumAreaMm2, 0.0099), `sumAreaMm2 ${r3.sumAreaMm2}`);

  // 随机点核验：远离等距边界的净区域点必属于欧氏距离最近的计入细胞
  const sites = r3.zones;
  let seed = 987654, total = 0, mismatch = 0, tries = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  while (total < 30000 && tries < 500000) {
    tries++;
    const x = rnd() * 100, y = rnd() * 100;
    if (!fieldsInNet({ x, y }, fieldR)) continue;
    const dists = sites.map((z) => ({ k: z.key, d: Math.hypot(x - z.centroid.x, y - z.centroid.y) }))
      .sort((a, b) => a.d - b.d);
    if (dists[1].d - dists[0].d < 0.02) continue; // 跳过等距边界邻域
    total++;
    let owner = null;
    for (const z of sites) {
      let inP = false;
      for (const l of z.geometry.loops) if (geo.pointStrictlyInside({ x, y }, l)) inP = !inP;
      if (inP) { owner = z.key; break; }
    }
    if (owner !== dists[0].k) mismatch++;
  }
  assert.strictEqual(mismatch, 0, `最近归属核验 ${mismatch}/${total} 不匹配`);

  // 孔洞内的点不属于任何分区
  const pHole = { x: 85, y: 85 };
  let ownerHole = null;
  for (const z of sites) {
    let inP = false;
    for (const l of z.geometry.loops) if (geo.pointStrictlyInside(pHole, l)) inP = !inP;
    if (inP) { ownerHole = z.key; break; }
  }
  assert.strictEqual(ownerHole, null, '视野孔洞不分配');

  // 未计入细胞原因
  const reasons = Object.fromEntries(r3.excludedCells.map((c) => [c.key, c.reason]));
  assert(/视野外部或孔洞/.test(reasons.H), `H 原因 ${reasons.H}`);
  assert(/视野外部或孔洞/.test(reasons.O), `O 原因 ${reasons.O}`);
  console.log('ok 3 矩形视野（含孔洞）：四分区合计＝净面积、孔洞内圈、随机点最近归属、孔洞不分配、未计入原因');
}

function fieldsInNet(p, field) {
  if (!geo.pointStrictlyInside(p, field.outer)) return false;
  return !(field.holes || []).some((h) => geo.pointInsideOrOn(p, h));
}

// ---------- 4. L 形视野：外部不分配，合计仍等于净面积 ----------

{
  const fieldL = {
    id: 'fL', name: 'L',
    outer: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
      { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }
    ],
    holes: []
  };
  const r = zones.buildFieldZones(fieldL, 0, [
    cell('A', rect(10, 10, 5, 5)),
    cell('B', rect(80, 10, 5, 5)),
    cell('C', rect(10, 80, 5, 5))
  ], 1);
  assert(approx(r.fieldAreaPx, 7500));
  assert(approx(r.sumAreaPx, 7500), `L 各区合计 ${r.sumAreaPx}`);
  // 采样：L 形缺角 (75,75) 不在任何分区
  const owner = zoneOwnerAt(r.zones, { x: 75, y: 75 });
  assert.strictEqual(owner, null, 'L 形缺角（视野外部）不分配');
  // L 形内部点 (25,75) 必被某个分区覆盖
  assert.notStrictEqual(zoneOwnerAt(r.zones, { x: 25, y: 75 }), null, 'L 形内部已分配');
  console.log('ok 4 L 形视野：非矩形外环、外部不分配、合计＝净面积');
}

function zoneOwnerAt(list, p) {
  for (const z of list) {
    let inP = false;
    for (const l of z.geometry.loops) if (geo.pointStrictlyInside(p, l)) inP = !inP;
    if (inP) return z.key;
  }
  return null;
}

// ---------- 5. 等距边界不计面积：共线等距三点，中间位置仍有正面积楔形 ----------

{
  // 三质心水平等距分布：中间细胞的责任区是 x∈(50-1e? , 平分带) 实际为两条平分线之间的条带
  const field = { id: 'f', outer: rect(0, 0, 300, 100), holes: [] };
  const r = zones.buildFieldZones(field, 0, [
    cell('L', rect(20, 45, 10, 10)),  // 质心 (25,50)
    cell('M', rect(145, 45, 10, 10)), // 质心 (150,50)
    cell('R', rect(270, 45, 10, 10))  // 质心 (275,50)
  ], 1);
  const by = Object.fromEntries(r.zones.map((z) => [z.key, z]));
  assert(approx(by.L.areaPx, 8750), `L 区 ${by.L.areaPx}`); // x<87.5 → 87.5*100
  assert(approx(by.M.areaPx, 12500), `M 区 ${by.M.areaPx}`); // 87.5<x<212.5
  assert(approx(by.R.areaPx, 8750), `R 区 ${by.R.areaPx}`);
  assert(approx(r.sumAreaPx, 30000));
  console.log('ok 5 共线等距三质心：平分线条带，等距边界无面积，合计＝净面积');
}

// ---------- 6. 质心重合：报告顺序首个占有，其余零面积记录，合计不变 ----------

{
  const field = { id: 'f', outer: rect(0, 0, 100, 100), holes: [] };
  // A(20,20)、B 与 A 同心（外框不同，净质心同为 20,20）、C(70,70)
  const r = zones.buildFieldZones(field, 0, [
    cell('A', rect(10, 10, 20, 20)),
    cell('B', rect(12, 12, 16, 16)),
    cell('C', rect(60, 60, 20, 20))
  ], 1);
  assert.strictEqual(r.countedCellCount, 3);
  assert.strictEqual(r.ownerCellCount, 2);
  assert.strictEqual(r.coincidentCellCount, 1);
  const by = Object.fromEntries(r.zones.map((z) => [z.key, z]));
  assert(by.A.areaPx > 0 && by.A.coincident === false, 'A 占有该位置');
  assert.deepStrictEqual(by.A.coincidentWith, ['B']);
  assert.strictEqual(by.B.areaPx, 0, 'B 零面积');
  assert.strictEqual(by.B.zeroArea, true);
  assert.strictEqual(by.B.coincident, true);
  assert.deepStrictEqual(by.B.coincidentWith, ['A']);
  assert.strictEqual(by.B.geometry.loops.length, 0, 'B 无分区几何');
  assert(by.C.areaPx > 0, 'C 正常分区');
  assert(approx(by.A.areaPx + by.C.areaPx, 10000), '两占有区合计＝净面积');
  assert(approx(r.sumAreaPx, 10000), '结果合计（零面积记录不影响）');
  // 表格顺序按报告细胞顺序：A、B、C
  assert.deepStrictEqual(r.zones.map((z) => z.key), ['A', 'B', 'C']);
  console.log('ok 6 质心重合：首个按报告顺序占有、其余零面积记录且注明占有者、合计不变');
}

// ---------- 7. 无计入细胞：空结果 + 提示 ----------

{
  const field = { id: 'f', outer: rect(0, 0, 100, 100), holes: [] };
  const r = zones.buildFieldZones(field, 0, [], 1);
  assert.strictEqual(r.empty, true);
  assert.strictEqual(r.zones.length, 0);
  assert.strictEqual(r.countedCellCount, 0);
  assert.strictEqual(r.sumAreaPx, 0);
  assert(/没有计入细胞/.test(r.message));
  assert(approx(r.fieldAreaPx, 10000), '视野净面积照常给出');

  // 全部质心在孔洞内
  const r2 = zones.buildFieldZones(
    { id: 'fh', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] },
    0, [cell('X', rect(45, 45, 10, 10))], 1);
  assert.strictEqual(r2.empty, true);
  assert.strictEqual(r2.countedCellCount, 0);
  assert(/没有计入细胞/.test(r2.message));

  // 全部质心在视野外
  const r3b = zones.buildFieldZones(field, 0, [cell('X', rect(150, 150, 10, 10))], 1);
  assert.strictEqual(r3b.empty, true);
  console.log('ok 7 无计入细胞（空报告/质心全在孔洞/全在外部）：空结果、空 zones 与明确提示');
}

// ---------- 8. 净面积非正的细胞无良定义质心：不参与、给原因 ----------

{
  // 孔洞面积等于外环的细胞无法通过保存校验，但纯逻辑需容错：netCentroid 返回 null
  const field = { id: 'f', outer: rect(0, 0, 100, 100), holes: [] };
  const weird = { id: 'W', name: 'W', outer: rect(0, 0, 10, 10), holes: [rect(0, 0, 10, 10)] };
  const r = zones.buildFieldZones(field, 0, [weird, cell('A', rect(40, 40, 10, 10))], 1);
  assert.strictEqual(r.countedCellCount, 1);
  const w = r.excludedCells.find((c) => c.key === 'W');
  assert(w && /净面积非正/.test(w.reason), `W 原因 ${w && w.reason}`);
  assert(approx(r.sumAreaPx, 10000), '唯一正常细胞占有整个视野净区域');
  console.log('ok 8 净面积非正细胞无质心：不计入、原因明确、其余细胞分区合计仍＝净面积');
}

// ---------- 9. 占比/百分比修约合计严格为 1 / 100（最大余额法） ----------

{
  // 3 个位置把视野分成不易整除的比例
  const field = { id: 'f', outer: rect(0, 0, 100, 100), holes: [] };
  const r = zones.buildFieldZones(field, 0, [
    cell('A', rect(5, 5, 1, 1)),
    cell('B', rect(37, 50, 1, 1)),
    cell('C', rect(90, 90, 1, 1))
  ], 1);
  // 合计字段按修约整数单位给出，严格为 1 / 100（不受 JS 浮点累加误差影响）
  assert.strictEqual(r.sumRatio, 1, 'ratio 合计严格为 1');
  assert.strictEqual(r.sumPercent, 100, 'percent 合计严格为 100');
  assert(approx(r.zones.reduce((s, z) => s + z.ratio, 0), 1, 1e-12));
  assert(approx(r.zones.reduce((s, z) => s + z.percent, 0), 100, 1e-12));
  // largestRemainder 直接验证（修约单位整数和）
  const a = zones.largestRemainder([1 / 3, 1 / 3, 1 / 3], 1, 6);
  assert.strictEqual(a.reduce((s, v) => s + Math.round(v * 1e6), 0), 1e6);
  const b = zones.largestRemainder([1 / 3, 1 / 3, 1 / 3].map((v) => v * 100), 100, 2);
  assert.strictEqual(b.reduce((s, v) => s + Math.round(v * 100), 0), 10000);
  console.log('ok 9 占比/百分比修约：最大余额法保证合计严格 1 与 100（整数单位核验）');
}

// ---------- 10. 未定标：像素面积/占比照常，mm² 与展示文本「待定标」 ----------

{
  const field = { id: 'f', name: '矩形视野', outer: rect(0, 0, 100, 100), holes: [] };
  const r = zones.buildFieldZones(field, 0, [
    cell('A', rect(10, 10, 10, 10)), cell('B', rect(60, 60, 10, 10))
  ], null);
  assert.strictEqual(r.calibrated, false);
  assert.strictEqual(r.fieldAreaMm2, null);
  assert.strictEqual(r.sumAreaMm2, null);
  assert.strictEqual(r.fieldAreaText, '待定标');
  assert(r.zones.every((z) => z.areaMm2 === null && z.areaText === '待定标'), '分区 mm² 待定标');
  assert(approx(r.sumAreaPx, 10000) && r.sumPercent === 100, '像素面积与占比不依赖定标');
  console.log('ok 10 未定标：像素面积/占比照常给出，mm² 与展示文本「待定标」');
}

// ---------- 11. scale 换算：2 px = 1 μm 时 mm² 与冻结标尺一致 ----------

{
  const field = { id: 'f', outer: rect(0, 0, 100, 100), holes: [] };
  const r = zones.buildFieldZones(field, 0, [
    cell('A', rect(10, 10, 10, 10)), cell('B', rect(60, 60, 10, 10))
  ], 0.5); // 1 px = 0.5 μm
  // 净面积 10000 px² → 2500 μm² = 0.0025 mm²
  assert(approx(r.fieldAreaMm2, 0.0025), `fieldAreaMm2 ${r.fieldAreaMm2}`);
  assert(approx(r.sumAreaMm2, 0.0025), `sumAreaMm2 ${r.sumAreaMm2}`);
  console.log('ok 11 物理面积按冻结标尺换算（px²→mm²）');
}

// ---------- 12. 单细胞：整个视野净区域归它（含孔洞扣除） ----------

{
  const field = { id: 'f', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] };
  const r = zones.buildFieldZones(field, 0, [cell('A', rect(10, 10, 5, 5))], 1);
  assert.strictEqual(r.ownerCellCount, 1);
  assert(approx(r.zones[0].areaPx, 9600), `单细胞区面积 ${r.zones[0].areaPx}`);
  assert.strictEqual(r.zones[0].percent, 100);
  assert(r.zones[0].geometry.holes.length >= 1, '单细胞分区保留孔洞内圈');
  console.log('ok 12 单计入细胞：占有整个视野净区域（孔洞扣除为内圈）');
}

console.log('\n全部最近质心责任区纯逻辑自测通过 ✔');
