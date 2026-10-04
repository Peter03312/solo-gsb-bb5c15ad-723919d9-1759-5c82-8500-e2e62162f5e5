'use strict';

// 单视野「最近质心责任区」端到端 HTTP 自测（npm test）：
// 上传 → 定标/圈选/视野 → 发布报告 → 责任区分析（面积/占比/几何/合计＝净面积）→
// 无计入细胞空结果提示 → 视野不存在/重名、报告不存在明确报错（id 优先）→
// 草稿修改与更正不改变旧报告结果 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8247;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-fieldzones-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];
function zonesQuery(reportId, body) {
  return jsend('POST', `/api/reports/${reportId}/field-zones`, body);
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();

    // ---------- 切片 A：矩形视野（含孔洞）+ 四象限细胞 + 孔洞内/外细胞 ----------
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 1px=1μm', r.status === 200, r.body);

    // fieldF：100×100 含 10×10 孔洞 (80,80) → 净 9900
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'fieldF', name: '中心视野', outer: rect(0, 0, 100, 100), holes: [rect(80, 80, 10, 10)] }
      ]
    });
    check('保存视野', r.status === 200, r.body);

    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(10, 10, 10, 10), holes: [] }, // 质心 (15,15)
        { id: 'cellB', name: '乙', outer: rect(60, 10, 10, 10), holes: [] }, // 质心 (65,15)
        { id: 'cellC', name: '丙', outer: rect(10, 60, 10, 10), holes: [] }, // 质心 (15,65)
        { id: 'cellD', name: '丁', outer: rect(60, 60, 10, 10), holes: [] }, // 质心 (65,65)
        { id: 'cellH', name: '孔内', outer: rect(82, 82, 6, 6), holes: [] },
        { id: 'cellO', name: '视野外', outer: rect(200, 200, 20, 20), holes: [] }
      ]
    });
    check('保存轮廓', r.status === 200, r.body);

    const pub = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '切片A 报告'
    });
    check('发布报告', pub.status === 201, pub.body);
    const RID = pub.body.report.id;

    // ---------- 责任区分析 ----------
    let d = await zonesQuery(RID, { fieldId: 'fieldF' });
    check('责任区分析成功', d.status === 200, d.body);
    check('响应基本信息',
      d.body.scope === 'report' && d.body.reportId === RID &&
      d.body.title === '切片A 报告' && d.body.matchedBy === 'id' &&
      d.body.calibrated === true && d.body.scaleUmPerPx === 1 &&
      d.body.snapshotUrl === `/api/reports/${RID}/file`, d.body);
    const Z = d.body.zones;
    check('责任区元数据',
      Z.kind === 'field-zones' && Z.fieldId === 'fieldF' && Z.fieldName === '中心视野' &&
      Z.fieldHoles === 1 && Z.empty === false &&
      Z.countedCellCount === 4 && Z.ownerCellCount === 4 &&
      Z.coincidentCellCount === 0 && Z.excludedCellCount === 2, Z);
    check('视野净面积 9900、各区合计严格相等（像素与 mm²）、占比合计 100',
      approx(Z.fieldAreaPx, 9900) && Z.sumAreaPx === 9900 &&
      approx(Z.fieldAreaMm2, 0.0099) && approx(Z.sumAreaMm2, 0.0099) &&
      Z.sumRatio === 1 && Z.sumPercent === 100, Z);
    const byKey = Object.fromEntries(Z.zones.map((z) => [z.key, z]));
    check('每个计入细胞一条记录，按报告顺序',
      Z.zones.map((z) => z.key).join(',') === 'cellA,cellB,cellC,cellD', Z.zones);
    check('各区面积为正、占比在 (0,1)、几何至少含一个外圈',
      Z.zones.every((z) => z.areaPx > 0 && z.ratio > 0 && z.ratio < 1 &&
        z.coincident === false && z.geometry.pieces.length >= 1 && z.geometry.loops.length >= 1),
      Z.zones);
    check('孔洞位于丁的责任区：丁分区含孔洞内圈',
      byKey.cellD.geometry.holes.length >= 1, byKey.cellD.geometry);
    check('几何圈有向面积之和等于该细胞面积（允许 0.001 px 顶点修约误差）',
      Z.zones.every((z) => {
        const geo = require('./server/geometry');
        const a = z.geometry.loops.reduce((s, l) => s + geo.signedArea(l), 0);
        return Math.abs(a - z.areaPx) <= 0.01;
      }), Z.zones.map((z) => z.areaPx));
    check('质心标记包含全部 4 个计入细胞',
      Z.overlay.centroids.length === 4 &&
      Z.overlay.centroids.some((m) => m.key === 'cellD' && approx(m.x, 65) && approx(m.y, 65)),
      Z.overlay.centroids);
    check('未计入细胞给出原因',
      Z.excludedCells.map((c) => c.key).sort().join(',') === 'cellH,cellO' &&
      Z.excludedCells.every((c) => /视野外部或孔洞/.test(c.reason)), Z.excludedCells);
    check('与报告冻结 fieldStats 的细胞数一致', (() => {
      const fs = pub.body.report.fieldStats.find((s) => s.id === 'fieldF');
      return fs && fs.cellCount === Z.fieldCellCount && fs.cellCount === 4;
    })(), pub.body.report.fieldStats);

    // 按视野名称查询（trim）
    d = await zonesQuery(RID, { fieldId: ' 中心视野 ' });
    check('按视野名称分析且 matchedBy=name',
      d.status === 200 && d.body.matchedBy === 'name' &&
      d.body.zones.sumAreaPx === 9900, d.body);

    // ---------- 无计入细胞：空结果 + 提示 ----------
    const up2 = await upload(png);
    const img2 = up2.body.id;
    r = await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img2}/fields`, {
      version: r.body.version,
      fields: [{ id: 'fEmpty', name: '空野', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    r = await jsend('PUT', `/api/images/${img2}/contours`, {
      version: r.body.version,
      cells: [{ id: 'outside', name: '在外', outer: rect(150, 150, 20, 20), holes: [] }]
    });
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, {
      version: r.body.version, title: '空计入报告'
    });
    const RID2 = pub2.body.report.id;
    d = await zonesQuery(RID2, { fieldId: 'fEmpty' });
    check('无计入细胞：200 空结果',
      d.status === 200 && d.body.zones.empty === true &&
      d.body.zones.zones.length === 0 && d.body.zones.countedCellCount === 0 &&
      /没有计入细胞/.test(d.body.zones.message) &&
      approx(d.body.zones.fieldAreaPx, 10000), d.body);

    // ---------- 质心重合：首个占有 + 零面积记录 ----------
    const up3 = await upload(png);
    const img3 = up3.body.id;
    r = await jsend('PUT', `/api/images/${img3}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img3}/fields`, {
      version: r.body.version,
      fields: [{ id: 'fc', name: '重合野', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    r = await jsend('PUT', `/api/images/${img3}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'P', name: '首', outer: rect(10, 10, 20, 20), holes: [] }, // 质心 (20,20)
        { id: 'Q', name: '重', outer: rect(12, 12, 16, 16), holes: [] }, // 质心 (20,20)
        { id: 'S', name: '独', outer: rect(60, 60, 20, 20), holes: [] }  // 质心 (70,70)
      ]
    });
    const pub3 = await jsend('POST', `/api/images/${img3}/publish`, {
      version: r.body.version, title: '质心重合报告'
    });
    const RID3 = pub3.body.report.id;
    d = await zonesQuery(RID3, { fieldId: 'fc' });
    check('质心重合：counted 3 / owners 2 / 零面积 1，合计仍为净面积',
      d.status === 200 &&
      d.body.zones.countedCellCount === 3 && d.body.zones.ownerCellCount === 2 &&
      d.body.zones.coincidentCellCount === 1 && d.body.zones.sumAreaPx === 10000, d.body);
    {
      const z = Object.fromEntries(d.body.zones.zones.map((x) => [x.key, x]));
      check('首个 P 占有，Q 零面积记录并注明 P，S 正常',
        z.P.areaPx > 0 && z.P.coincident === false &&
        JSON.stringify(z.P.coincidentWith) === '["Q"]' &&
        z.Q.areaPx === 0 && z.Q.zeroArea === true && z.Q.coincident === true &&
        JSON.stringify(z.Q.coincidentWith) === '["P"]' &&
        z.Q.geometry.loops.length === 0 &&
        z.S.areaPx > 0, d.body.zones.zones);
    }

    // ---------- 错误语义 ----------
    let e = await zonesQuery(RID, {});
    check('缺视野标识 → 400', e.status === 400 && /fieldId/.test(e.body.error), e.body);
    e = await zonesQuery(RID, { fieldId: '   ' });
    check('空白视野标识 → 400', e.status === 400 && /非空/.test(e.body.error), e.body);
    e = await zonesQuery(RID, { fieldId: 'ghost' });
    check('视野不存在 → 400', e.status === 400 && /视野标识不存在：ghost/.test(e.body.error), e.body);
    e = await zonesQuery('no-such-report', { fieldId: 'fieldF' });
    check('报告不存在 → 404', e.status === 404, e.body);

    // 视野名称歧义（另一切片两个同名视野）
    const up4 = await upload(png);
    const img4 = up4.body.id;
    r = await jsend('PUT', `/api/images/${img4}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img4}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'dup1', name: '同名', outer: rect(0, 0, 50, 50), holes: [] },
        { id: 'dup2', name: '同名', outer: rect(0, 0, 60, 60), holes: [] }
      ]
    });
    r = await jsend('PUT', `/api/images/${img4}/contours`, {
      version: r.body.version,
      cells: [{ id: 'X', name: 'X', outer: rect(0, 0, 20, 20), holes: [] }]
    });
    const pub4 = await jsend('POST', `/api/images/${img4}/publish`, {
      version: r.body.version, title: '重名视野报告'
    });
    const RID4 = pub4.body.report.id;
    e = await zonesQuery(RID4, { fieldId: '同名' });
    check('视野名称重名 → 400 并提示改用 id',
      e.status === 400 && /2 个同名视野/.test(e.body.error) && /改用视野 id/.test(e.body.error), e.body);
    d = await zonesQuery(RID4, { fieldId: 'dup2' });
    check('重名时按 id 精确匹配仍可分析（净面积 3600）',
      d.status === 200 && d.body.matchedBy === 'id' &&
      d.body.zones.sumAreaPx === 3600, d.body);

    // 无视野报告：明确报错
    const up5 = await upload(png);
    const img5 = up5.body.id;
    r = await jsend('PUT', `/api/images/${img5}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img5}/contours`, {
      version: r.body.version,
      cells: [{ id: 'Y', name: 'Y', outer: rect(0, 0, 20, 20), holes: [] }]
    });
    const pub5 = await jsend('POST', `/api/images/${img5}/publish`, {
      version: r.body.version, title: '无视野报告'
    });
    e = await zonesQuery(pub5.body.report.id, { fieldId: 'fieldF' });
    check('无视野报告 → 400 视野标识不存在',
      e.status === 400 && /视野标识不存在/.test(e.body.error), e.body);

    // ---------- 只读 & 冻结：幂等；草稿修改与更正不改变旧报告结果 ----------
    const before = await zonesQuery(RID, { fieldId: 'fieldF' });
    const again = await zonesQuery(RID, { fieldId: 'fieldF' });
    check('查询幂等（结果字节一致）', JSON.stringify(again.body) === JSON.stringify(before.body));

    r = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(10, 10, 10, 10), holes: [] },
        { id: 'cellB', name: '乙', outer: rect(60, 10, 10, 10), holes: [] },
        { id: 'cellC', name: '丙', outer: rect(10, 60, 10, 10), holes: [] },
        { id: 'cellD', name: '丁', outer: rect(60, 60, 10, 10), holes: [] },
        { id: 'cellH', name: '孔内', outer: rect(82, 82, 6, 6), holes: [] },
        { id: 'cellO', name: '视野外', outer: rect(200, 200, 20, 20), holes: [] },
        { id: 'cellN', name: '新增', outer: rect(45, 45, 10, 10), holes: [] }
      ]
    });
    check('草稿追加细胞', r.status === 200, r.body);
    const trace = await jget(`/api/reports/${RID}/trace`);
    const cor = await jsend('POST', `/api/reports/${RID}/correct`, {
      reason: '新增一个细胞', draftVersion: r.body.version, expectedTipId: trace.body.tipId
    });
    check('更正发布新报告', cor.status === 201, cor.body);

    const frozen = await zonesQuery(RID, { fieldId: 'fieldF' });
    check('草稿修改+更正后旧报告责任区结果不变（字节一致）',
      JSON.stringify(frozen.body) === JSON.stringify(before.body), frozen.body);
    const dNew = await zonesQuery(cor.body.report.id, { fieldId: 'fieldF' });
    check('新报告按新冻结数据计算（5 个计入细胞）',
      dNew.status === 200 && dNew.body.zones.countedCellCount === 5 &&
      dNew.body.zones.sumAreaPx === 9900, dNew.body);

    // 既有接口/启动方式不受影响
    const rb = await jget(`/api/reports/${RID}`);
    check('旧报告读取正常且 draftVersion 未因查询改变',
      rb.status === 200 && rb.body.draftVersion === pub.body.report.draftVersion, rb.body);
    const grid = await jsend('POST', `/api/reports/${RID}/field-grid`, { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('既有网格密度接口仍可用', grid.status === 200 && grid.body.grid.sumAreaPx === 9900, grid.body);
    const csv = await fetch(`${base}/api/reports/${RID}/field-csv`);
    check('视野统计 CSV 导出仍可用', csv.status === 200 &&
      (csv.headers.get('content-type') || '').includes('text/csv'));

  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部最近质心责任区 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
