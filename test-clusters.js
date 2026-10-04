'use strict';

// 细胞接触簇分析自测（node test-clusters.js）：
// 阈值校验（负数/非有限数/非数值拒绝，0 允许）、净区域距离语义
// （重叠/边界接触为 0、孔洞内未触及净区域不算接触、孔洞边界距离、包含关系）、
// 邻接对与连通簇（链式连通、无邻接时各自独立簇、阈值恰等于间距、μm 换算）、
// 每细胞邻居排序与最短净区域间距。
const assert = require('assert');
const clusters = require('./server/clusters');

const sq = (x, y, w) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }];
const cell = (id, outer, holes = []) => ({ id, name: id, outer, holes });

// ---------- 阈值校验 ----------

assert.strictEqual(clusters.validateThreshold(0), 0);
assert.strictEqual(clusters.validateThreshold(5), 5);
assert.strictEqual(clusters.validateThreshold(0.25), 0.25);
assert.strictEqual(clusters.validateThreshold('3.5'), 3.5); // 数值字符串按数值接受
for (const bad of [-1, -0.5]) {
  assert.throws(() => clusters.validateThreshold(bad), (e) => e.status === 400 && /不能为负数/.test(e.message));
}
for (const bad of [NaN, Infinity, -Infinity]) {
  assert.throws(() => clusters.validateThreshold(bad), (e) => e.status === 400 && /有限数值|必须是数值/.test(e.message));
}
for (const bad of [undefined, null, 'abc', '', {}, [], true]) {
  assert.throws(() => clusters.validateThreshold(bad), (e) => e.status === 400 && /必须是数值/.test(e.message));
}
console.log('ok 1 阈值校验：0 允许，负数/非有限数/非数值明确拒绝');

// ---------- 净区域距离 ----------

const D = clusters.netRegionDistancePx;

// 2. 相离正方形：间距 = 边间水平距离
{
  const a = cell('a', sq(0, 0, 10));
  const b = cell('b', sq(25, 0, 10));
  assert.strictEqual(D(a, b), 15);
  assert.strictEqual(D(b, a), 15); // 对称
  console.log('ok 2 相离细胞间距为边界最短距离');
}

// 3. 边界接触（共享边 / 共享角点）与重叠 → 0
{
  const a = cell('a', sq(0, 0, 10));
  assert.strictEqual(D(a, cell('b', sq(10, 0, 10))), 0);  // 共享边 x=10
  assert.strictEqual(D(a, cell('c', sq(10, 10, 10))), 0); // 共享角点 (10,10)
  assert.strictEqual(D(a, cell('d', sq(5, 0, 10))), 0);   // 部分重叠
  assert.strictEqual(D(a, cell('e', sq(2, 2, 4))), 0);    // 完全包含
  assert.strictEqual(D(cell('e', sq(2, 2, 4)), a), 0);    // 被包含（对称）
  console.log('ok 3 边界接触/角点接触/重叠/包含 → 间距 0');
}

// 4. 孔洞语义：仅落在孔洞内未触及净区域 → 间距 > 0（到孔洞边界的距离），不算接触
{
  const donut = cell('donut', sq(0, 0, 100), [sq(40, 40, 20)]); // 孔洞 (40,40)-(60,60)
  const inside = cell('inside', sq(45, 45, 10));                // 孔洞中央，四周各留 5
  assert.strictEqual(D(donut, inside), 5);
  assert.strictEqual(D(inside, donut), 5);
  assert.strictEqual(clusters.netRegionsTouch(donut, inside), false);
  // 触及孔洞边界（从孔洞内贴边）→ 接触净区域边界 → 0
  assert.strictEqual(D(donut, cell('stick', sq(40, 45, 10))), 0);
  // 跨越孔洞边界（部分在净区域上）→ 重叠 → 0
  assert.strictEqual(D(donut, cell('straddle', sq(35, 45, 10))), 0);
  // 完全落在净区域内部（非孔洞处）→ 0
  assert.strictEqual(D(donut, cell('inner', sq(10, 10, 10))), 0);
  // 孔洞外的细胞：间距按外轮廓计算，不受孔洞影响
  assert.strictEqual(D(donut, cell('outer-cell', sq(105, 40, 10))), 5);
  console.log('ok 4 孔洞内未触及净区域不算接触；触及孔洞边界/跨边界/净区域内为 0');
}

// 5. 点到边 / 点到点的斜向距离
{
  const a = cell('a', sq(0, 0, 10));
  const b = cell('b', sq(13, 4, 10)); // 水平间距 3
  assert.ok(Math.abs(D(a, b) - 3) < 1e-9);
  const c = cell('c', sq(13, 14, 10)); // 角对角：hypot(3,4)=5
  assert.ok(Math.abs(D(a, c) - 5) < 1e-9);
  console.log('ok 5 边距与角对角斜距正确（3-4-5）');
}

// ---------- 邻接对与连通簇 ----------

// 6. 链式连通 + 孤立细胞独立成簇；无邻接时全部各自成簇
{
  const cells = [
    cell('A', sq(0, 0, 10)),
    cell('B', sq(15, 0, 10)),  // 距 A 5
    cell('C', sq(30, 0, 10)),  // 距 B 5、距 A 20
    cell('D', sq(100, 0, 10))  // 远离
  ];
  let r = clusters.buildContactAnalysis(cells, 1, 0);
  assert.strictEqual(r.pairCount, 0);
  assert.strictEqual(r.clusterCount, 4);
  assert.strictEqual(r.multiCellClusterCount, 0);
  assert.ok(r.clusters.every((c) => c.size === 1));
  assert.ok(r.cells.every((c) => c.neighborCount === 0 && c.shortestUm === null));

  r = clusters.buildContactAnalysis(cells, 1, 4.9);
  assert.strictEqual(r.pairCount, 0, '阈值小于间距 5 时无邻接');

  r = clusters.buildContactAnalysis(cells, 1, 5);
  assert.strictEqual(r.pairCount, 2, '阈值恰等于间距时计入邻接');
  assert.strictEqual(r.clusterCount, 2);
  assert.strictEqual(r.multiCellClusterCount, 1);
  const big = r.clusters[0];
  assert.strictEqual(big.size, 3);
  assert.deepStrictEqual(big.cellKeys, ['A', 'B', 'C']);
  assert.deepStrictEqual(r.clusters[1].cellKeys, ['D']);
  // 簇 id 回填到每个细胞
  const byKey = Object.fromEntries(r.cells.map((c) => [c.key, c]));
  assert.strictEqual(byKey.A.clusterId, big.id);
  assert.strictEqual(byKey.C.clusterId, big.id);
  assert.notStrictEqual(byKey.D.clusterId, big.id);
  // 邻居与最短净区域间距
  assert.deepStrictEqual(byKey.A.neighbors.map((n) => n.key), ['B']);
  assert.strictEqual(byKey.A.shortestUm, 5);
  assert.deepStrictEqual(byKey.B.neighbors.map((n) => n.key), ['A', 'C']);
  assert.strictEqual(byKey.B.neighborCount, 2);
  assert.strictEqual(byKey.D.neighborCount, 0);
  assert.strictEqual(byKey.D.shortestUm, null);
  console.log('ok 6 链式邻接连通成簇，孤立细胞独立成簇，无邻接时全部各自成簇');
}

// 7. μm 换算：距离按报告冻结定标（μm/px）换算后与阈值比较
{
  const cells = [cell('A', sq(0, 0, 10)), cell('B', sq(15, 0, 10))]; // 间距 5 px
  let r = clusters.buildContactAnalysis(cells, 2, 9.9);  // 5px = 10μm > 9.9
  assert.strictEqual(r.pairCount, 0);
  r = clusters.buildContactAnalysis(cells, 2, 10);       // 恰等于 10μm
  assert.strictEqual(r.pairCount, 1);
  assert.strictEqual(r.pairs[0].distanceUm, 10);
  assert.strictEqual(r.pairs[0].distancePx, 5);
  console.log('ok 7 间距按定标换算为微米后与阈值比较');
}

// 8. 孔洞内的细胞在阈值 0 下不与宿主接触；阈值覆盖间隙后才邻接
{
  const cells = [
    cell('host', sq(0, 0, 100), [sq(40, 40, 20)]),
    cell('guest', sq(45, 45, 10)) // 在 host 孔洞内，四周间隙 5
  ];
  let r = clusters.buildContactAnalysis(cells, 1, 0);
  assert.strictEqual(r.pairCount, 0, '孔洞内未触及净区域：阈值 0 不算接触');
  assert.strictEqual(r.clusterCount, 2);
  r = clusters.buildContactAnalysis(cells, 1, 5);
  assert.strictEqual(r.pairCount, 1, '阈值覆盖到孔洞边界的间隙后邻接');
  assert.strictEqual(r.clusterCount, 1);
  assert.strictEqual(r.pairs[0].distanceUm, 5);
  console.log('ok 8 孔洞内细胞阈值 0 不接触宿主，阈值覆盖间隙后同簇');
}

// 9. 邻居按间距升序；簇按规模降序、同规模按最小序号；pairs 按间距升序
{
  const cells = [
    cell('A', sq(0, 0, 10)),
    cell('B', sq(12, 0, 10)),   // 距 A 2
    cell('C', sq(0, 14, 10)),   // 距 A 4
    cell('E', sq(100, 0, 10)),
    cell('F', sq(112, 0, 10))   // 距 E 2
  ];
  const r = clusters.buildContactAnalysis(cells, 1, 10);
  const byKey = Object.fromEntries(r.cells.map((c) => [c.key, c]));
  assert.deepStrictEqual(byKey.A.neighbors.map((n) => n.key), ['B', 'C']);
  assert.strictEqual(byKey.A.shortestUm, 2);
  assert.strictEqual(r.clusters[0].size, 3); // {A,B,C} 在前
  assert.strictEqual(r.clusters[1].size, 2); // {E,F}
  assert.ok(r.pairs[0].distanceUm <= r.pairs[r.pairs.length - 1].distanceUm);
  console.log('ok 9 邻居/簇/邻接对排序规则正确');
}

// 10. 历史无 id 细胞用 #序号（0 基）兜底；单细胞报告
{
  const noIds = [
    { name: '', outer: sq(0, 0, 10), holes: [] },
    { name: '', outer: sq(12, 0, 10), holes: [] }
  ];
  let r = clusters.buildContactAnalysis(noIds, 1, 5);
  assert.deepStrictEqual(r.cells.map((c) => c.key), ['#0', '#1']);
  assert.deepStrictEqual(r.clusters[0].cellKeys, ['#0', '#1']);

  r = clusters.buildContactAnalysis([cell('only', sq(0, 0, 10))], 1, 100);
  assert.strictEqual(r.cellCount, 1);
  assert.strictEqual(r.pairCount, 0);
  assert.strictEqual(r.clusterCount, 1);
  assert.strictEqual(r.clusters[0].size, 1);
  console.log('ok 10 无 id 细胞按 #序号兜底，单细胞各自成簇');
}

console.log('\n接触簇分析纯逻辑自测全部通过 ✔');
