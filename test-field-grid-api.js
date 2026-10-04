'use strict';

// 视野网格密度分析端到端 HTTP 自测（npm test）：
// 上传 → 定标/圈选/视野 → 发布报告 → 单视野网格密度分析（有效面积/计数/密度/叠加几何）→
// 行列数越界、视野不存在/重名、报告不存在明确报错 → 草稿修改与更正不改变旧报告结果 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8241;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-fieldgrid-'));
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

function gridQuery(reportId, body) {
  return jsend('POST', `/api/reports/${reportId}/field-grid`, body);
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

    // ---------- 切片 A：矩形视野（含孔洞）+ L 形视野 ----------
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 1px=1μm', r.status === 200, r.body);

    // fieldF：100×100 含 10×10 孔洞 (80,80) → 净 9900；fieldL：L 形 → 净 7500
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'fieldF', name: '中心视野', outer: rect(0, 0, 100, 100), holes: [rect(80, 80, 10, 10)] },
        { id: 'fieldL', name: 'L视野', outer: [
          { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
          { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }
        ], holes: [] }
      ]
    });
    check('保存两个视野', r.status === 200, r.body);

    // 细胞：A→格(1,1)；B 质心 (45,50) 在内部横线上→下侧格(2,1)；C→格(2,2)；
    // H 质心在视野孔洞内不计入；O 在视野外不计入
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(10, 10, 20, 20), holes: [] },
        { id: 'cellB', name: '乙', outer: rect(30, 0, 30, 100), holes: [] },
        { id: 'cellC', name: '丙', outer: rect(60, 60, 10, 10), holes: [] },
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

    // ---------- 网格密度分析：2×2 ----------
    let d = await gridQuery(RID, { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('网格密度分析成功', d.status === 200, d.body);
    check('响应基本信息',
      d.body.scope === 'report' && d.body.reportId === RID &&
      d.body.title === '切片A 报告' && d.body.matchedBy === 'id' &&
      d.body.calibrated === true && d.body.scaleUmPerPx === 1 &&
      d.body.snapshotUrl === `/api/reports/${RID}/file`, d.body);
    const G = d.body.grid;
    check('网格元数据',
      G.kind === 'field-grid' && G.fieldId === 'fieldF' && G.fieldName === '中心视野' &&
      G.fieldHoles === 1 && G.rows === 2 && G.cols === 2 &&
      G.bounds.minX === 0 && G.bounds.minY === 0 && G.bounds.maxX === 100 && G.bounds.maxY === 100 &&
      G.cellWidthPx === 50 && G.cellHeightPx === 50, G);
    check('视野净面积 9900 且各格合计相等',
      approx(G.fieldAreaPx, 9900) && approx(G.sumAreaPx, 9900) &&
      approx(G.fieldAreaMm2, 0.0099), G);
    const byIndex = Object.fromEntries(G.cells.map((c) => [c.index, c]));
    check('各格有效面积 2500/2500/2500/2400（孔洞扣除）',
      approx(byIndex[0].areaPx, 2500) && approx(byIndex[1].areaPx, 2500) &&
      approx(byIndex[2].areaPx, 2500) && approx(byIndex[3].areaPx, 2400), G.cells);
    check('各格计数：甲→(1,1)，乙→(2,1)（内部横线归下侧），丙→(2,2)；孔内/视野外不计入',
      JSON.stringify(byIndex[0].countedCellKeys) === '["cellA"]' &&
      JSON.stringify(byIndex[1].countedCellKeys) === '[]' &&
      JSON.stringify(byIndex[2].countedCellKeys) === '["cellB"]' &&
      JSON.stringify(byIndex[3].countedCellKeys) === '["cellC"]', G.cells);
    check('各格计数合计＝原视野统计（3）',
      G.sumCellCount === 3 && G.fieldCellCount === 3 &&
      G.cells.reduce((s, c) => s + c.cellCount, 0) === 3, G);
    check('与报告冻结 fieldStats 的细胞数一致', (() => {
      const fs = pub.body.report.fieldStats.find((s) => s.id === 'fieldF');
      return fs && fs.cellCount === G.sumCellCount;
    })(), pub.body.report.fieldStats);
    check('密度：400 / 0 / 400 / 416.6667 个/mm²',
      approx(byIndex[0].densityPerMm2, 400) &&
      byIndex[1].densityPerMm2 === 0 &&
      approx(byIndex[2].densityPerMm2, 400) &&
      approx(byIndex[3].densityPerMm2, 1 / 0.0024) &&
      byIndex[3].densityText === '416.6667', G.cells);
    check('mm² 有效面积与展示文本',
      approx(byIndex[3].areaMm2, 0.0024) && byIndex[3].areaText === '0.0024' &&
      byIndex[0].areaText === '0.0025', G.cells);
    check('格子矩形与网格线叠加几何',
      byIndex[0].rect.x0 === 0 && byIndex[0].rect.y0 === 0 &&
      byIndex[0].rect.x1 === 50 && byIndex[0].rect.y1 === 50 &&
      JSON.stringify(G.overlay.verticalLines) === '[0,50,100]' &&
      JSON.stringify(G.overlay.horizontalLines) === '[0,50,100]', G);
    check('计入细胞质心标记（乙在内部横线 y=50 上，归第2行第1列）', (() => {
      const m = G.overlay.centroids.find((x) => x.key === 'cellB');
      return G.overlay.centroids.length === 3 && m && m.row === 1 && m.col === 0 && approx(m.y, 50);
    })(), G.overlay.centroids);

    // 按视野名称查询（忽略首尾空白）
    d = await gridQuery(RID, { fieldId: ' 中心视野 ', rows: 2, cols: 2 });
    check('按视野名称分析且 matchedBy=name',
      d.status === 200 && d.body.matchedBy === 'name' &&
      approx(d.body.grid.sumAreaPx, 9900), d.body);

    // ---------- L 形视野：零面积格 ----------
    d = await gridQuery(RID, { fieldId: 'fieldL', rows: 2, cols: 2 });
    check('L 形视野分析成功', d.status === 200, d.body);
    const L = d.body.grid;
    const lByIndex = Object.fromEntries(L.cells.map((c) => [c.index, c]));
    check('L 形视野：第2行第2列为零面积格，保留且密度「不可计算」',
      approx(L.fieldAreaPx, 7500) && approx(L.sumAreaPx, 7500) &&
      lByIndex[3].areaPx === 0 && lByIndex[3].zeroArea === true &&
      lByIndex[3].cellCount === 0 && lByIndex[3].densityPerMm2 === null &&
      lByIndex[3].densityText === '不可计算' && L.cells.length === 4, L);
    check('L 形视野：计数合计＝原视野统计（甲在(1,1)，乙质心(45,50)在 L 内部→(2,1)）',
      L.sumCellCount === 2 && L.fieldCellCount === 2 &&
      JSON.stringify(lByIndex[0].countedCellKeys) === '["cellA"]' &&
      JSON.stringify(lByIndex[2].countedCellKeys) === '["cellB"]', L);

    // ---------- 1×1 与 40×40 ----------
    d = await gridQuery(RID, { fieldId: 'fieldF', rows: 1, cols: 1 });
    check('1×1 网格：唯一格面积＝净面积、计数＝原统计',
      d.status === 200 && d.body.grid.cells.length === 1 &&
      approx(d.body.grid.cells[0].areaPx, 9900) && d.body.grid.cells[0].cellCount === 3, d.body);
    d = await gridQuery(RID, { fieldId: 'fieldF', rows: 40, cols: 40 });
    check('40×40 网格：1600 格、合计不变量保持',
      d.status === 200 && d.body.grid.cells.length === 1600 &&
      approx(d.body.grid.sumAreaPx, 9900, 1e-6) &&
      d.body.grid.cells.reduce((s, c) => s + c.cellCount, 0) === 3, d.body && d.body.grid && {
        sum: d.body.grid.sumAreaPx,
        count: d.body.grid.cells.reduce((s, c) => s + c.cellCount, 0)
      });

    // ---------- 行列数错误语义 ----------
    let e = await gridQuery(RID, { fieldId: 'fieldF', rows: 0, cols: 2 });
    check('行数 0 → 400', e.status === 400 && /超出范围/.test(e.body.error), e.body);
    e = await gridQuery(RID, { fieldId: 'fieldF', rows: 2, cols: 41 });
    check('列数 41 → 400', e.status === 400 && /超出范围/.test(e.body.error), e.body);
    e = await gridQuery(RID, { fieldId: 'fieldF', rows: 2.5, cols: 2 });
    check('行数非整数 → 400', e.status === 400 && /必须是整数/.test(e.body.error), e.body);
    e = await gridQuery(RID, { fieldId: 'fieldF', rows: 'abc', cols: 2 });
    check('行数非数值 → 400', e.status === 400 && /必须是 1～40 的整数/.test(e.body.error), e.body);
    e = await gridQuery(RID, { fieldId: 'fieldF', cols: 2 });
    check('缺少行数 → 400', e.status === 400 && /rows/.test(e.body.error), e.body);
    e = await gridQuery(RID, { fieldId: 'fieldF', rows: 2 });
    check('缺少列数 → 400', e.status === 400 && /cols/.test(e.body.error), e.body);
    e = await gridQuery(RID, { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('合法行列数仍成功（错误请求无副作用）', e.status === 200, e.body);

    // ---------- 视野/报告错误语义 ----------
    e = await gridQuery(RID, { rows: 2, cols: 2 });
    check('缺视野标识 → 400', e.status === 400 && /fieldId/.test(e.body.error), e.body);
    e = await gridQuery(RID, { fieldId: 'ghost', rows: 2, cols: 2 });
    check('视野不存在 → 400', e.status === 400 && /视野标识不存在：ghost/.test(e.body.error), e.body);
    e = await gridQuery('no-such-report', { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('报告不存在 → 404', e.status === 404, e.body);

    // ---------- 视野名称歧义（另一切片发布含两个同名视野的报告） ----------
    const up2 = await upload(png);
    const img2 = up2.body.id;
    r = await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img2}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'dup1', name: '同名', outer: rect(0, 0, 50, 50), holes: [] },
        { id: 'dup2', name: '同名', outer: rect(0, 0, 60, 60), holes: [] }
      ]
    });
    r = await jsend('PUT', `/api/images/${img2}/contours`, {
      version: r.body.version,
      cells: [{ id: 'X', name: 'X', outer: rect(0, 0, 20, 20), holes: [] }]
    });
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, {
      version: r.body.version, title: '切片B 报告'
    });
    const RID2 = pub2.body.report.id;
    e = await gridQuery(RID2, { fieldId: '同名', rows: 2, cols: 2 });
    check('视野名称重名 → 400 并提示改用 id',
      e.status === 400 && /2 个同名视野/.test(e.body.error) && /改用视野 id/.test(e.body.error), e.body);
    d = await gridQuery(RID2, { fieldId: 'dup2', rows: 3, cols: 3 });
    check('重名时按 id 仍可分析（3×3，净面积 3600）',
      d.status === 200 && d.body.matchedBy === 'id' &&
      approx(d.body.grid.sumAreaPx, 3600) &&
      d.body.grid.cells.every((c) => approx(c.areaPx, 400)), d.body);

    // ---------- 无视野报告：明确报错 ----------
    const up3 = await upload(png);
    const img3 = up3.body.id;
    r = await jsend('PUT', `/api/images/${img3}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img3}/contours`, {
      version: r.body.version,
      cells: [{ id: 'Y', name: 'Y', outer: rect(0, 0, 20, 20), holes: [] }]
    });
    const pub3 = await jsend('POST', `/api/images/${img3}/publish`, {
      version: r.body.version, title: '无视野报告'
    });
    e = await gridQuery(pub3.body.report.id, { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('无视野报告 → 400 视野标识不存在',
      e.status === 400 && /视野标识不存在/.test(e.body.error), e.body);

    // ---------- 只读 & 冻结：重复查询幂等；草稿修改与更正不改变旧报告结果 ----------
    const before = await gridQuery(RID, { fieldId: 'fieldF', rows: 2, cols: 2 });
    const again = await gridQuery(RID, { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('查询幂等（结果字节一致）',
      JSON.stringify(again.body) === JSON.stringify(before.body));

    // 草稿追加一个计入 fieldF 的细胞并发起更正；旧报告网格结果不变
    r = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(10, 10, 20, 20), holes: [] },
        { id: 'cellB', name: '乙', outer: rect(30, 0, 30, 100), holes: [] },
        { id: 'cellC', name: '丙', outer: rect(60, 60, 10, 10), holes: [] },
        { id: 'cellH', name: '孔内', outer: rect(82, 82, 6, 6), holes: [] },
        { id: 'cellO', name: '视野外', outer: rect(200, 200, 20, 20), holes: [] },
        { id: 'cellN', name: '新增', outer: rect(55, 5, 10, 10), holes: [] }
      ]
    });
    check('草稿追加细胞', r.status === 200, r.body);
    const trace = await jget(`/api/reports/${RID}/trace`);
    const cor = await jsend('POST', `/api/reports/${RID}/correct`, {
      reason: '新增一个细胞', draftVersion: r.body.version, expectedTipId: trace.body.tipId
    });
    check('更正发布新报告', cor.status === 201, cor.body);

    const frozen = await gridQuery(RID, { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('草稿修改+更正后旧报告网格结果不变（字节一致）',
      JSON.stringify(frozen.body) === JSON.stringify(before.body), frozen.body);
    const dNew = await gridQuery(cor.body.report.id, { fieldId: 'fieldF', rows: 2, cols: 2 });
    check('新报告按新冻结数据计算（计数 4，新增细胞在(1,2)）',
      dNew.status === 200 && dNew.body.grid.sumCellCount === 4 &&
      JSON.stringify(dNew.body.grid.cells[1].countedCellKeys) === '["cellN"]', dNew.body);

    // 报告读取/导出走原路径仍可用
    const rb = await jget(`/api/reports/${RID}`);
    check('旧报告读取正常且 draftVersion 未因查询改变',
      rb.status === 200 && rb.body.draftVersion === pub.body.report.draftVersion, rb.body);
    const csv = await fetch(`${base}/api/reports/${RID}/field-csv`);
    check('视野统计 CSV 导出仍可用', csv.status === 200 &&
      (csv.headers.get('content-type') || '').includes('text/csv'));

  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部视野网格密度分析 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
