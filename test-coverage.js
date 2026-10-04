'use strict';

// 单视野细胞覆盖核对自测（node test-coverage.js）：
// 覆盖面积 = 细胞净区域 ∩ 视野净区域 的几何交集——
// 跨边界细胞只计内部部分、多细胞重叠只计一次、孔洞（细胞/视野）不贡献、
// 仅边界接触不贡献；与按质心计数的密度规则刻意区分。
// 另含标识解析（id/名称/重名/不存在/空）与未定标“待定标”语义。
const assert = require('assert');
const ms = require('./server/merge-stats');

const SCALE = 1; // 1 px = 1 μm → 1 px² = 1e-6 mm²

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const tri = (...pts) => pts;

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ---------- 标识解析 ----------

{
  const fields = [{ id: 'f1', name: '甲' }, { id: 'f2', name: '乙' }];
  assert.strictEqual(ms.resolveFieldIdentifier(fields, 'f1').field.id, 'f1');
  assert.strictEqual(ms.resolveFieldIdentifier(fields, 'f1').matchBy, 'id');
  assert.strictEqual(ms.resolveFieldIdentifier(fields, ' 乙 ').field.id, 'f2');
  assert.strictEqual(ms.resolveFieldIdentifier(fields, ' 乙 ').matchBy, 'name');
  assert.throws(() => ms.resolveFieldIdentifier(fields, '不存在'), /视野标识不存在/);
  assert.throws(() => ms.resolveFieldIdentifier(fields, ''), /fieldId 必须为非空/);
  assert.throws(() => ms.resolveFieldIdentifier(fields, '   '), /fieldId 必须为非空/);
  assert.throws(() => ms.resolveFieldIdentifier(fields, null), /fieldId 必须为非空/);
  assert.throws(() => ms.resolveFieldIdentifier(fields, 42), /fieldId 必须为非空/);
  // id 优先于同名
  const dup = [{ id: 'x', name: '重' }, { id: 'y', name: '重' }];
  assert.strictEqual(ms.resolveFieldIdentifier(dup, 'x').matchBy, 'id');
  assert.throws(() => ms.resolveFieldIdentifier(dup, '重'), /同名视野/);
  console.log('ok 1 视野标识解析：id/名称/重名/不存在/空输入');
}

// ---------- 覆盖面积：基本几何 ----------

// 2. 细胞整体在视野内：覆盖 = 细胞全部净面积
{
  const field = { id: 'F', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [{ id: 'A', name: 'A', outer: rect(10, 10, 40, 40), holes: [] }];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.fieldAreaPx, 10000), JSON.stringify(s));
  assert.ok(approx(s.coveredAreaPx, 1600), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.uncoveredAreaPx, 8400));
  assert.ok(approx(s.coverageRatio, 0.16), `ratio=${s.coverageRatio}`);
  assert.strictEqual(s.coverageText, '16%');
  assert.deepStrictEqual(s.contributingCellKeys, ['A']);
  console.log('ok 2 整体在内：覆盖 1600/10000 = 16%');
}

// 3. 跨越视野边界的细胞只计内部部分；且质心在视野外（密度规则不计，覆盖规则仍计）
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [{ id: 'A', outer: rect(80, 80, 50, 50), holes: [] }]; // 质心 (105,105) 在外
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.coveredAreaPx, 400), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.coverageRatio, 0.04));
  assert.deepStrictEqual(s.contributingCellKeys, ['A']);
  console.log('ok 3 跨边界细胞只计内部 400（质心在视野外仍计）');
}

// 4. 反过来：质心在视野内但大部分面积在外 → 覆盖只计交集，不按整个细胞面积
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [{ id: 'A', outer: rect(20, 20, 100, 100), holes: [] }]; // 质心 (70,70) 在内
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.coveredAreaPx, 80 * 80), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.coveredAreaPx, 6400));
  console.log('ok 4 质心在内但跨边界：覆盖为交集 6400 而非整细胞 10000');
}

// 5. 多个细胞重叠只计一次（3600 + 3600 - 400 = 6800）
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [
    { id: 'A', outer: rect(0, 0, 60, 60), holes: [] },
    { id: 'B', outer: rect(40, 40, 60, 60), holes: [] }
  ];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.coveredAreaPx, 6800), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.uncoveredAreaPx, 3200));
  assert.strictEqual(s.contributingCellCount, 2);
  assert.deepStrictEqual(s.contributingCellKeys, ['A', 'B']);
  console.log('ok 5 重叠细胞去重：覆盖并集 6800');
}

// 6. 完全相同的两个细胞：覆盖不翻倍
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const ring = rect(0, 0, 100, 100);
  const cells = [
    { id: 'A', outer: ring, holes: [] },
    { id: 'B', outer: ring.map((p) => ({ ...p })), holes: [] }
  ];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.coveredAreaPx, 10000), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.coverageRatio, 1));
  assert.strictEqual(s.contributingCellCount, 2);
  console.log('ok 6 完全重叠细胞覆盖仍为 10000（100%）');
}

// 7. 仅边界接触（共享一条边）不贡献面积，也不计入有交集细胞
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [{ id: 'A', outer: rect(100, 0, 40, 40), holes: [] }];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.coveredAreaPx, 0), `covered=${s.coveredAreaPx}`);
  assert.strictEqual(s.contributingCellCount, 0);
  assert.deepStrictEqual(s.contributingCellKeys, []);
  console.log('ok 7 仅边界接触：覆盖 0 且不计入');
}

// 8. 完全在视野外
{
  const field = { id: 'F', outer: rect(0, 0, 10, 10), holes: [] };
  const cells = [{ id: 'A', outer: rect(50, 50, 10, 10), holes: [] }];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.coveredAreaPx, 0));
  assert.strictEqual(s.contributingCellCount, 0);
  console.log('ok 8 视野外细胞不贡献');
}

// ---------- 孔洞 ----------

// 9. 跨边界细胞自带孔洞：交集 = 外环交集 - 孔洞（孔洞在视野内部）
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cell = {
    id: 'A', outer: rect(50, 0, 100, 100), // 交集外环 = 50×100 = 5000
    holes: [rect(70, 40, 20, 20)]          // 孔洞 400 完全在视野内
  };
  const s = ms.buildFieldCoverage(field, [cell], SCALE);
  assert.ok(approx(s.coveredAreaPx, 4600), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.uncoveredAreaPx, 5400));
  console.log('ok 9 跨边界细胞孔洞在视野内：5000 - 400 = 4600');
}

// 10. 视野带孔洞：细胞铺满时覆盖 = 视野净面积（孔洞不贡献）
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] };
  const cells = [{ id: 'A', outer: rect(0, 0, 100, 100), holes: [] }];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.fieldAreaPx, 9600));
  assert.ok(approx(s.coveredAreaPx, 9600), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.uncoveredAreaPx, 0));
  assert.ok(approx(s.coverageRatio, 1));
  console.log('ok 10 视野孔洞不贡献：铺满覆盖 = 净面积 9600（100%）');
}

// 11. 细胞只落在视野孔洞内：覆盖 0
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] };
  const cells = [{ id: 'A', outer: rect(45, 45, 10, 10), holes: [] }];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.coveredAreaPx, 0), `covered=${s.coveredAreaPx}`);
  assert.strictEqual(s.contributingCellCount, 0);
  console.log('ok 11 仅处于视野孔洞内的细胞不贡献');
}

// 12. 小细胞落在大细胞的孔洞里：属于对视野的额外覆盖（9600 + 100 = 9700）；
//     对比第 11 例：若孔洞属于【视野】，同位置细胞贡献为 0
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const big = { id: 'BIG', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] };
  const small = { id: 'SML', outer: rect(45, 45, 10, 10), holes: [] };
  const s = ms.buildFieldCoverage(field, [big, small], SCALE);
  assert.ok(approx(s.coveredAreaPx, 9700), `covered=${s.coveredAreaPx}`);
  assert.ok(approx(s.uncoveredAreaPx, 300));
  // 两个细胞都与视野有正面积交集，均列入贡献名单
  assert.deepStrictEqual(s.contributingCellKeys.sort(), ['BIG', 'SML']);
  console.log('ok 12 大细胞孔洞内的小细胞仍覆盖视野：9600 + 100 = 9700');
}

// ---------- 非轴对齐 ----------

// 13. 三角形细胞斜跨视野边界：x=100 处截断后的三角形 500
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cell = {
    id: 'A',
    outer: tri({ x: 80, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 100 }),
    holes: []
  };
  const s = ms.buildFieldCoverage(field, [cell], SCALE);
  assert.ok(approx(s.coveredAreaPx, 500, 1e-4), `covered=${s.coveredAreaPx}`);
  console.log('ok 13 斜跨边界三角形交集 = 500');
}

// ---------- 单位与未定标 ----------

// 14. 已定标：mm² 换算（1 px² = 1e-6 mm²）与展示文本
{
  const field = { id: 'F', name: '区一', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [{ id: 'A', outer: rect(80, 80, 50, 50), holes: [] }];
  const s = ms.buildFieldCoverage(field, cells, SCALE);
  assert.ok(approx(s.fieldAreaMm2, 0.01), `field=${s.fieldAreaMm2}`);
  assert.ok(approx(s.coveredAreaMm2, 0.0004), `cov=${s.coveredAreaMm2}`);
  assert.ok(approx(s.uncoveredAreaMm2, 0.0096));
  assert.strictEqual(s.fieldAreaText, '0.01');
  assert.strictEqual(s.coveredAreaText, '0.0004');
  assert.strictEqual(s.uncoveredAreaText, '0.0096');
  assert.strictEqual(s.calibrated, true);
  assert.strictEqual(s.fieldName, '区一');
  console.log('ok 14 物理面积 mm² 与展示文本正确');
}

// 15. 未定标：像素面积与覆盖率照常，物理面积与文本“待定标”
{
  const field = { id: 'F', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [{ id: 'A', outer: rect(80, 80, 50, 50), holes: [] }];
  const s = ms.buildFieldCoverage(field, cells, null);
  assert.ok(approx(s.coveredAreaPx, 400));
  assert.ok(approx(s.coverageRatio, 0.04));
  assert.strictEqual(s.coverageText, '4%');
  assert.strictEqual(s.fieldAreaMm2, null);
  assert.strictEqual(s.coveredAreaMm2, null);
  assert.strictEqual(s.uncoveredAreaMm2, null);
  assert.strictEqual(s.fieldAreaText, '待定标');
  assert.strictEqual(s.coveredAreaText, '待定标');
  assert.strictEqual(s.uncoveredAreaText, '待定标');
  assert.strictEqual(s.calibrated, false);
  console.log('ok 15 未定标：像素面积/覆盖率保留，物理面积待定标');
}

// 16. 无细胞：覆盖率 0，不抛错
{
  const field = { id: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const s = ms.buildFieldCoverage(field, [], SCALE);
  assert.ok(approx(s.fieldAreaPx, 10000));
  assert.ok(approx(s.coveredAreaPx, 0));
  assert.ok(approx(s.uncoveredAreaPx, 10000));
  assert.strictEqual(s.coverageText, '0%');
  assert.strictEqual(s.contributingCellCount, 0);
  console.log('ok 16 无细胞时覆盖率 0');
}

console.log('\n全部单视野覆盖核对自测通过 ✔');
