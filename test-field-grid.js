'use strict';

// 视野网格密度分析纯逻辑自测（node test-field-grid.js）：
// 行列数校验（1～40 整数，越界/非整数/非数值拒绝）、视野标识解析（id/名称/重名/不存在）、
// 格子归属边界规则（内部网格线归右/下侧、最外边线归末格）、
// 网格有效面积（矩形 ∩ 视野净区域，含孔洞扣除、L 形视野零面积格、合计＝净面积）、
// 细胞按净区域质心分配到唯一格子（沿用视野统计规则；质心落网格线归右/下侧）、
// 密度（零面积格「不可计算」）与 mm² 换算。
const assert = require('assert');
const grid = require('./server/field-grid');

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const cell = (id, outer, holes = []) => ({ id, name: id, outer, holes });
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 1. 行列数校验 ----------

assert.strictEqual(grid.validateGridDimension(1, 'rows'), 1);
assert.strictEqual(grid.validateGridDimension(40, 'rows'), 40);
assert.strictEqual(grid.validateGridDimension('7', 'cols'), 7); // 数值字符串按数值接受
for (const bad of [0, -1, 41, 100]) {
  assert.throws(() => grid.validateGridDimension(bad, 'rows（行数）'),
    (e) => e.status === 400 && /超出范围/.test(e.message), `越界 ${bad}`);
}
for (const bad of [1.5, 2.000001]) {
  assert.throws(() => grid.validateGridDimension(bad, 'cols（列数）'),
    (e) => e.status === 400 && /必须是整数/.test(e.message), `非整数 ${bad}`);
}
for (const bad of [undefined, null, NaN, Infinity, 'abc', '', {}, [], true]) {
  assert.throws(() => grid.validateGridDimension(bad, 'rows（行数）'),
    (e) => e.status === 400 && /必须是 1～40 的整数/.test(e.message), `非数值 ${String(bad)}`);
}
console.log('ok 1 行列数校验：1～40 整数，越界/非整数/非数值明确拒绝');

// ---------- 2. 视野标识解析 ----------

const fields2 = [
  { id: 'f1', name: '中心视野', outer: rect(0, 0, 10, 10), holes: [] },
  { id: 'f2', name: '同名', outer: rect(0, 0, 10, 10), holes: [] },
  { id: 'f3', name: '同名', outer: rect(0, 0, 10, 10), holes: [] }
];
assert.strictEqual(grid.resolveGridField(fields2, 'f1').field.id, 'f1');
assert.strictEqual(grid.resolveGridField(fields2, 'f1').matchBy, 'id');
assert.strictEqual(grid.resolveGridField(fields2, ' 中心视野 ').matchBy, 'name'); // 名称忽略首尾空白
assert.strictEqual(grid.resolveGridField(fields2, 'f2').matchBy, 'id'); // 重名时 id 优先精确匹配
assert.throws(() => grid.resolveGridField(fields2, '同名'),
  (e) => e.status === 400 && /2 个同名视野/.test(e.message) && /改用视野 id/.test(e.message));
assert.throws(() => grid.resolveGridField(fields2, 'ghost'),
  (e) => e.status === 400 && /视野标识不存在：ghost/.test(e.message));
for (const bad of [undefined, null, '', '   ', 5]) {
  assert.throws(() => grid.resolveGridField(fields2, bad),
    (e) => e.status === 400 && /非空的视野标识/.test(e.message), `空标识 ${String(bad)}`);
}
console.log('ok 2 视野标识解析：id/名称/重名/不存在/空标识');

// ---------- 3. 格子归属边界规则 ----------

const B = { minX: 0, minY: 0, maxX: 100, maxY: 100 }; // 2×2 网格，格线 x=50 / y=50
{
  const g = (x, y) => grid.gridIndexFor({ x, y }, B, 2, 2);
  assert.deepStrictEqual(g(25, 25), { row: 0, col: 0, index: 0 });
  assert.deepStrictEqual(g(75, 25), { row: 0, col: 1, index: 1 });
  assert.deepStrictEqual(g(25, 75), { row: 1, col: 0, index: 2 });
  assert.deepStrictEqual(g(75, 75), { row: 1, col: 1, index: 3 });
  // 内部网格线上的点归右侧/下侧
  assert.deepStrictEqual(g(50, 25), { row: 0, col: 1, index: 1 });  // 竖线 → 右格
  assert.deepStrictEqual(g(25, 50), { row: 1, col: 0, index: 2 });  // 横线 → 下格
  assert.deepStrictEqual(g(50, 50), { row: 1, col: 1, index: 3 });  // 交点 → 右下格
  // 最外边线归末格；左/上边线自然归首格
  assert.deepStrictEqual(g(100, 75), { row: 1, col: 1, index: 3 }); // 右边线 → 末列
  assert.deepStrictEqual(g(75, 100), { row: 1, col: 1, index: 3 }); // 下边线 → 末行
  assert.deepStrictEqual(g(100, 100), { row: 1, col: 1, index: 3 });
  assert.deepStrictEqual(g(0, 25), { row: 0, col: 0, index: 0 });   // 左边线 → 首列
  assert.deepStrictEqual(g(25, 0), { row: 0, col: 0, index: 0 });   // 上边线 → 首行
  console.log('ok 3 格子归属：内部网格线归右/下侧，最外边线归末格');
}

// ---------- 4. 矩形视野（含孔洞）2×2 网格 ----------

// 视野 100×100 含 10×10 孔洞 (80,80)：净面积 9900
const fieldR = { id: 'fR', name: '矩形视野', outer: rect(0, 0, 100, 100), holes: [rect(80, 80, 10, 10)] };
const cells4 = [
  cell('A', rect(10, 10, 20, 20)),   // 质心 (20,20) → 第1行第1列
  cell('B', rect(30, 0, 30, 100)),   // 质心 (45,50)：在内部横线 y=50 上 → 归下侧（第2行第1列）
  cell('C', rect(60, 60, 10, 10)),   // 质心 (65,65) → 第2行第2列
  cell('H', rect(82, 82, 6, 6)),     // 质心落在视野孔洞内 → 不计入
  cell('O', rect(200, 200, 20, 20))  // 质心在视野外 → 不计入
];
{
  const g = grid.buildFieldGrid(fieldR, 0, cells4, 1, 2, 2); // 1 px = 1 μm
  assert.strictEqual(g.rows, 2);
  assert.strictEqual(g.cols, 2);
  assert.deepStrictEqual(g.bounds, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
  assert.strictEqual(g.cellWidthPx, 50);
  assert.strictEqual(g.cellHeightPx, 50);
  assert(approx(g.fieldAreaPx, 9900), `视野净面积 ${g.fieldAreaPx}`);
  // 各格有效面积：孔洞 (80,80)-(90,90) 完全落在第2行第2列 → 该格 2400，其余 2500
  const byIndex = Object.fromEntries(g.cells.map((c) => [c.index, c]));
  assert(approx(byIndex[0].areaPx, 2500), `格0面积 ${byIndex[0].areaPx}`);
  assert(approx(byIndex[1].areaPx, 2500), `格1面积 ${byIndex[1].areaPx}`);
  assert(approx(byIndex[2].areaPx, 2500), `格2面积 ${byIndex[2].areaPx}`);
  assert(approx(byIndex[3].areaPx, 2400), `格3面积（扣孔洞）${byIndex[3].areaPx}`);
  assert(approx(g.sumAreaPx, 9900), `各格合计 ${g.sumAreaPx} = 视野净面积`);
  // 计数：A→格0，B→格2（质心在内部横线上归下侧），C→格3；H/O 不计入
  assert.deepStrictEqual(byIndex[0].countedCellKeys, ['A']);
  assert.deepStrictEqual(byIndex[1].countedCellKeys, []);
  assert.deepStrictEqual(byIndex[2].countedCellKeys, ['B']);
  assert.deepStrictEqual(byIndex[3].countedCellKeys, ['C']);
  assert.strictEqual(g.sumCellCount, 3);
  assert.strictEqual(g.fieldCellCount, 3); // 与原视野统计一致
  assert.strictEqual(g.cells.reduce((s, c) => s + c.cellCount, 0), g.fieldCellCount);
  // 密度：1 px² = 1e-6 mm² → 格0/格2 = 1/0.0025 = 400；格3 = 1/0.0024
  assert(approx(byIndex[0].densityPerMm2, 400), `格0密度 ${byIndex[0].densityPerMm2}`);
  assert.strictEqual(byIndex[1].densityPerMm2, 0); // 有面积无细胞 → 密度 0（可计算）
  assert(approx(byIndex[3].densityPerMm2, 1 / 0.0024), `格3密度 ${byIndex[3].densityPerMm2}`);
  assert.strictEqual(byIndex[0].densityText, '400');
  // mm² 换算
  assert(approx(byIndex[3].areaMm2, 0.0024), `格3 mm² ${byIndex[3].areaMm2}`);
  assert.strictEqual(byIndex[3].areaText, '0.0024');
  // 叠加几何
  assert.deepStrictEqual(g.overlay.verticalLines, [0, 50, 100]);
  assert.deepStrictEqual(g.overlay.horizontalLines, [0, 50, 100]);
  assert.strictEqual(g.overlay.centroids.length, 3);
  const markB = g.overlay.centroids.find((m) => m.key === 'B');
  assert(markB && markB.row === 1 && markB.col === 0 && approx(markB.y, 50), 'B 质心标记在第2行第1列');
  console.log('ok 4 矩形视野 2×2：有效面积扣孔洞、质心落线归下侧、计数合计＝原统计、密度换算');
}

// ---------- 5. L 形视野：零面积格保留且密度「不可计算」 ----------

// L 形：(0,0)-(100,0)-(100,50)-(50,50)-(50,100)-(0,100)，净面积 7500；第2行第2列完全在视野外
const fieldL = { id: 'fL', name: 'L视野', outer: [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
  { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }
], holes: [] };
{
  const g = grid.buildFieldGrid(fieldL, 0, [cell('A', rect(10, 10, 20, 20))], 1, 2, 2);
  const byIndex = Object.fromEntries(g.cells.map((c) => [c.index, c]));
  assert(approx(g.fieldAreaPx, 7500), `L 视野净面积 ${g.fieldAreaPx}`);
  assert(approx(byIndex[0].areaPx, 2500), `格0 ${byIndex[0].areaPx}`);
  assert(approx(byIndex[1].areaPx, 2500), `格1 ${byIndex[1].areaPx}`);
  assert(approx(byIndex[2].areaPx, 2500), `格2 ${byIndex[2].areaPx}`);
  assert.strictEqual(byIndex[3].areaPx, 0, '格3 零面积');
  assert.strictEqual(byIndex[3].zeroArea, true);
  assert.strictEqual(byIndex[3].cellCount, 0, '零面积格计数为 0');
  assert.strictEqual(byIndex[3].densityPerMm2, null);
  assert.strictEqual(byIndex[3].densityText, '不可计算');
  assert.strictEqual(g.cells.length, 4, '零面积格保留在结果中');
  assert(approx(g.sumAreaPx, 7500), `各格合计 ${g.sumAreaPx}`);
  assert.strictEqual(g.sumCellCount, 1);
  assert.strictEqual(g.fieldCellCount, 1);
  console.log('ok 5 L 形视野：零面积格保留、密度「不可计算」、合计仍等于净面积');
}

// ---------- 6. 1×1 网格与 40×40 上限 ----------

{
  const g1 = grid.buildFieldGrid(fieldR, 0, cells4, 1, 1, 1);
  assert.strictEqual(g1.cells.length, 1);
  assert(approx(g1.cells[0].areaPx, 9900), '1×1 唯一格面积＝视野净面积');
  assert.strictEqual(g1.cells[0].cellCount, 3, '1×1 唯一格计数＝原视野统计');

  const g40 = grid.buildFieldGrid(fieldR, 0, cells4, 1, 40, 40);
  assert.strictEqual(g40.cells.length, 1600);
  assert(approx(g40.sumAreaPx, 9900, 1e-6), `40×40 合计 ${g40.sumAreaPx}`);
  assert.strictEqual(g40.cells.reduce((s, c) => s + c.cellCount, 0), 3, '40×40 计数合计');
  // 质心 (20,20)：格宽 2.5 → 第9行第9列（0 基 8,8）
  const a = g40.cells.find((c) => c.countedCellKeys.includes('A'));
  assert(a && a.row === 8 && a.col === 8, `A 在 40×40 中的位置 (${a && a.row},${a && a.col})`);
  console.log('ok 6 1×1 与 40×40 边界规模：合计不变量保持');
}

// ---------- 7. 未定标：面积/密度「待定标」，零面积格仍「不可计算」 ----------

{
  const g = grid.buildFieldGrid(fieldL, 0, [cell('A', rect(10, 10, 20, 20))], null, 2, 2);
  const byIndex = Object.fromEntries(g.cells.map((c) => [c.index, c]));
  assert.strictEqual(g.calibrated, false);
  assert.strictEqual(byIndex[0].areaMm2, null);
  assert.strictEqual(byIndex[0].areaText, '待定标');
  assert.strictEqual(byIndex[0].densityText, '待定标');
  assert.strictEqual(byIndex[3].densityText, '不可计算', '零面积格优先标「不可计算」');
  assert(approx(byIndex[0].areaPx, 2500), '像素面积照常给出');
  assert.strictEqual(g.sumCellCount, 1, '计数不依赖定标');
  console.log('ok 7 未定标：像素面积与计数照常，mm²/密度「待定标」，零面积格「不可计算」');
}

console.log('\n全部视野网格密度分析纯逻辑自测通过 ✔');
