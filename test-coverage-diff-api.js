'use strict';

// 同切片两报告 · 单视野细胞覆盖变化核对的端到端 HTTP 自测（npm test）：
// 上传 → 定标/圈选/视野 → 发布基线报告 → 改正草稿后更正发布复测报告 →
// 四类划分（共同/仅复测/仅基线/始终未覆盖）像素面积、占比、mm²、图形几何一致性 →
// 相同报告/不同切片/报告或视野不存在/视野重名歧义报错 → 只读、旧报告冻结不变 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8239;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-covdiff-'));
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

function diff(body) {
  return jsend('POST', '/api/reports/field-coverage-diff', body);
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

    // ---------- 切片 A：基线/复测/更正链三份报告 ----------
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('切片A定标 1px=1μm', r.status === 200, r.body);

    // 视野固定为 100×100（净面积 10000），含一个 10×10 孔洞 (80,80)→净 9900
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [{ id: 'fieldF', name: '中心视野', outer: rect(0, 0, 100, 100), holes: [rect(80, 80, 10, 10)] }]
    });
    check('保存带孔洞视野', r.status === 200, r.body);

    // 基线细胞：
    // A 左条 0..30 × 0..100 → 3000（复测保留 → 共同）
    // B 中条 30..60 × 0..100 → 3000（复测删除 → 仅基线）
    // H 完全落在视野孔洞 (80..90,80..90) 内（82..88）→ 与视野净区域交集为 0，不贡献
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(0, 0, 30, 100), holes: [] },
        { id: 'cellB', name: '乙', outer: rect(30, 0, 30, 100), holes: [] },
        { id: 'cellH', name: '孔内', outer: rect(82, 82, 6, 6), holes: [] }
      ]
    });
    check('保存基线轮廓', r.status === 200, r.body);

    const pub1 = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '切片A 基线报告'
    });
    check('基线报告发布', pub1.status === 201, pub1.body);
    const baseReport = pub1.body.report.id;

    // 复测草稿：A 保留，B 删除，新增 C 右条 60..90（3000，仅复测）；
    // 两个重叠细胞 D/E 覆盖 60..90 区域的一部分，重叠处只计一次（并集）
    r = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(0, 0, 30, 100), holes: [] },
        // C/D 重叠：C 60..90 × 0..100 = 3000（其中 80..90×80..90 为视野孔洞，扣 100 → 2900）
        { id: 'cellC', name: '丙', outer: rect(60, 0, 30, 100), holes: [] },
        // D 与 C 重叠 60..75 × 0..50，只新增 75..90×0..50 = 750？超出 C 部分
        // C 已铺满 60..90×0..100（孔洞除外），D 全部落在 C 内 → 并集不增加
        { id: 'cellD', name: '丁重叠', outer: rect(60, 0, 15, 50), holes: [] },
        // E 跨越视野右边界：100..120 × 0..50，仅边界（x=100）接触 → 不贡献
        { id: 'cellE', name: '跨界外', outer: rect(100, 0, 20, 50), holes: [] }
      ]
    });
    check('保存复测轮廓', r.status === 200, r.body);

    // 以「更正链」方式发布复测（历史报告 baseReport 与新报告同一切片）
    let trace = await jsend('GET', `/api/reports/${baseReport}/trace`);
    const cor = await jsend('POST', `/api/reports/${baseReport}/correct`, {
      reason: '修正标注：删除乙、补丙',
      draftVersion: r.body.version,
      expectedTipId: trace.body.tipId
    });
    check('更正发布复测报告', cor.status === 201, cor.body);
    const retestReport = cor.body.report.id;

    // ---------- 核对：四类面积 / 占比 / mm² ----------
    let d = await diff({ baselineReportId: baseReport, retestReportId: retestReport, fieldId: 'fieldF' });
    check('覆盖变化核对成功', d.status === 200, d.body);
    const D = d.body.diff;
    check('scope/报告信息/快照地址',
      d.body.scope === 'report-diff' &&
      d.body.baseline.reportId === baseReport &&
      d.body.retest.reportId === retestReport &&
      d.body.sameSliceImageId === imgId &&
      d.body.baseline.snapshotUrl === `/api/reports/${baseReport}/file`, d.body);
    check('matchedBy=id', d.body.matchedBy === 'id');
    check('视野净面积 9900（扣除 10×10 孔洞）', approx(D.fieldAreaPx, 9900), D);

    // 共同：A=3000；仅基线：B=3000；
    // 仅复测：C 2900（孔洞扣 100），D 全在 C 内并集面积不增加，E 仅边界不贡献；
    // 始终未覆盖：9900-3000-3000-2900 = 1000
    check('共同覆盖 3000 / 3000/9900',
      approx(D.classes.common.areaPx, 3000) &&
      approx(D.classes.common.ratio, 3000 / 9900, 1e-8), D.classes.common);
    check('仅基线覆盖 3000', approx(D.classes.baseline.areaPx, 3000), D.classes.baseline);
    check('仅复测覆盖 2900（孔洞扣 100，重叠 D 不重复计）',
      approx(D.classes.retest.areaPx, 2900), D.classes.retest);
    check('始终未覆盖 1000', approx(D.classes.never.areaPx, 1000), D.classes.never);
    check('四类像素面积之和 = 视野净面积', approx(D.sumAreaPx, 9900, 1e-6), D.sumAreaPx);
    check('四类占比之和 = 100%', approx(D.sumPercent, 100, 1e-6), D.sumPercent);

    // 物理面积按基线标尺 1px=1μm：1 px² = 1e-6 mm²
    check('mm² 按基线标尺：0.003/0.003/0.0029/0.001，视野 0.0099',
      approx(D.classes.common.areaMm2, 0.003) &&
      approx(D.classes.baseline.areaMm2, 0.003) &&
      approx(D.classes.retest.areaMm2, 0.0029) &&
      approx(D.classes.never.areaMm2, 0.001) &&
      approx(D.fieldAreaMm2, 0.0099), D);
    check('贡献名单：基线甲/乙（孔内 H 与视野净区域交集为 0 不算）；' +
          '复测甲/丙/丁（丁在丙内仍与视野有正面积交集故列入，但并集面积不重复计；跨界戊不列入）',
      JSON.stringify(D.baselineContributingKeys.slice().sort()) === JSON.stringify(['cellA', 'cellB']) &&
      JSON.stringify(D.retestContributingKeys.slice().sort()) === JSON.stringify(['cellA', 'cellC', 'cellD']), D);

    // 图形几何与数值对应：各类 regionLoops 鞋带面积（含孔洞方向）≈ 该类像素面积
    const geo2 = require('./server/geometry');
    function loopsArea(loops) {
      return loops.reduce((s, ring) => s + geo2.signedArea(ring), 0);
    }
    for (const k of ['common', 'retest', 'baseline', 'never']) {
      const a = Math.abs(loopsArea(D.classes[k].regionLoops));
      check(`图形区域面积与数值对应（${k}）`, approx(a, D.classes[k].areaPx, 1e-3),
        { geom: a, value: D.classes[k].areaPx });
    }
    // 边界边均落在视野内且 between 是不同类
    let boundaryOk = true;
    for (const k of ['common', 'retest', 'baseline', 'never']) {
      for (const e of D.classes[k].boundaryEdges) {
        if (e.between[0] === e.between[1]) boundaryOk = false;
      }
    }
    check('边界 between 两侧必不同类', boundaryOk);

    // 按视野名称查询
    d = await diff({ baselineReportId: baseReport, retestReportId: retestReport, fieldId: ' 中心视野 ' });
    check('按视野名称核对成功且 matchedBy=name',
      d.status === 200 && d.body.matchedBy === 'name' &&
      approx(d.body.diff.classes.common.areaPx, 3000), d.body);

    // ---------- 错误语义 ----------
    let e400 = await diff({ baselineReportId: baseReport, retestReportId: baseReport, fieldId: 'fieldF' });
    check('相同报告 → 400', e400.status === 400 && /两份不同的报告/.test(e400.body.error), e400.body);

    e400 = await diff({ baselineReportId: baseReport, retestReportId: retestReport, fieldId: '' });
    check('缺视野标识 → 400', e400.status === 400 && /fieldId/.test(e400.body.error), e400.body);

    e400 = await diff({ baselineReportId: baseReport, retestReportId: retestReport, fieldId: 'ghost' });
    check('基线报告内视野不存在 → 400', e400.status === 400 && /视野标识不存在/.test(e400.body.error), e400.body);

    let e404 = await diff({ baselineReportId: 'no-such-report', retestReportId: retestReport, fieldId: 'fieldF' });
    check('基线报告不存在 → 404', e404.status === 404, e404.body);
    e404 = await diff({ baselineReportId: baseReport, retestReportId: 'no-such-report', fieldId: 'fieldF' });
    check('复测报告不存在 → 404', e404.status === 404, e404.body);

    // ---------- 不同切片 ----------
    const up2 = await upload(png);
    const img2 = up2.body.id;
    r = await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img2}/fields`, {
      version: r.body.version,
      fields: [{ id: 'fieldF', name: '中心视野', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    r = await jsend('PUT', `/api/images/${img2}/contours`, {
      version: r.body.version,
      cells: [{ id: 'X', outer: rect(0, 0, 40, 40), holes: [] }]
    });
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, {
      version: r.body.version, title: '切片B 报告'
    });
    const otherSliceReport = pub2.body.report.id;
    const eSlice = await diff({ baselineReportId: baseReport, retestReportId: otherSliceReport, fieldId: 'fieldF' });
    check('不同切片的两份报告 → 400',
      eSlice.status === 400 && /不属于同一切片/.test(eSlice.body.error), eSlice.body);

    // ---------- 视野名称歧义 ----------
    // 给切片 B 的报告造两个同名视野（直接在发布前草稿）
    const up3 = await upload(png);
    const img3 = up3.body.id;
    r = await jsend('PUT', `/api/images/${img3}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img3}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'dup1', name: '同名', outer: rect(0, 0, 50, 50), holes: [] },
        { id: 'dup2', name: '同名', outer: rect(0, 0, 60, 60), holes: [] }
      ]
    });
    r = await jsend('PUT', `/api/images/${img3}/contours`, {
      version: r.body.version,
      cells: [{ id: 'X', outer: rect(0, 0, 20, 20), holes: [] }]
    });
    const pub3 = await jsend('POST', `/api/images/${img3}/publish`, {
      version: r.body.version, title: '切片C 报告'
    });
    const ambReport = pub3.body.report.id;
    const eAmb = await diff({ baselineReportId: ambReport, retestReportId: retestReport, fieldId: '同名' });
    // retest 是切片 A；这里基线选 amb（切片C），复测必须同切片，故先造同切片第二份报告
    check('不同切片时优先报切片错误（换下面的同切片歧义用例）', eAmb.status === 400, eAmb.body);

    // 对切片 C 再发一份普通报告（同切片第二份），用它复测基线 amb
    r = await jget(`/api/images/${img3}`);
    const pub3b = await jsend('POST', `/api/images/${img3}/publish`, {
      version: r.body.version, title: '切片C 报告二'
    });
    check('同切片第二份报告发布', pub3b.status === 201, pub3b.body);
    const ambReport2 = pub3b.body.report.id;
    const eAmb2 = await diff({ baselineReportId: ambReport, retestReportId: ambReport2, fieldId: '同名' });
    check('视野名称歧义（重名）→ 400 并提示改用 id',
      eAmb2.status === 400 && /存在 2 个同名视野/.test(eAmb2.body.error) && /改用视野 id/.test(eAmb2.body.error),
      eAmb2.body);
    // id 精确匹配不受重名影响
    const okId = await diff({ baselineReportId: ambReport, retestReportId: ambReport2, fieldId: 'dup1' });
    check('重名时按 id 仍可核对', okId.status === 200 && okId.body.matchedBy === 'id', okId.body);

    // ---------- 两份标尺不同：物理面积按基线，且明确提示换算依据 ----------
    // 切片 A 草稿重定标为 1px=2μm 后更正发布第三份报告
    r = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: r.body.version,
      p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 200
    });
    check('重定标 1px=2μm', r.status === 200, r.body);
    trace = await jsend('GET', `/api/reports/${retestReport}/trace`);
    const cor2 = await jsend('POST', `/api/reports/${retestReport}/correct`, {
      reason: '标尺修正为 2μm/px',
      draftVersion: r.body.version,
      expectedTipId: trace.body.tipId
    });
    check('第三份（标尺不同）更正发布', cor2.status === 201, cor2.body);
    const retest2 = cor2.body.report.id;

    d = await diff({ baselineReportId: baseReport, retestReportId: retest2, fieldId: 'fieldF' });
    check('标尺不同时仍核对成功', d.status === 200, d.body);
    check('scale.same=false 且给出两侧标尺',
      d.body.diff.scale.same === false &&
      d.body.diff.scale.baselineScaleUmPerPx === 1 &&
      d.body.diff.scale.retestScaleUmPerPx === 2 &&
      /基线报告冻结标尺/.test(d.body.diff.scale.note), d.body.diff.scale);
    check('物理面积仍按基线标尺换算（共同 3000px² → 0.003 mm²）',
      approx(d.body.diff.classes.common.areaMm2, 0.003) &&
      approx(d.body.diff.fieldAreaMm2, 0.0099), d.body.diff);

    // ---------- 只读 & 冻结：重复查询幂等；草稿再改、再更正不改变旧报告核对 ----------
    const again = await diff({ baselineReportId: baseReport, retestReportId: retestReport, fieldId: 'fieldF' });
    check('查询幂等（结果字节一致）',
      JSON.stringify(again.body.diff) === JSON.stringify(D));

    // 再改正草稿（铺满视野 9900），旧两份报告核对结果不变
    r = await jget(`/api/images/${imgId}`);
    await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [{ id: 'big', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    const frozen = await diff({ baselineReportId: baseReport, retestReportId: retestReport, fieldId: 'fieldF' });
    check('草稿后续修改不改变旧报告核对（仍共同 3000）',
      approx(frozen.body.diff.classes.common.areaPx, 3000), frozen.body.diff);
    // 报告本身冻结字段未被写回
    const rb = await jget(`/api/reports/${baseReport}`);
    check('基线报告 draftVersion 未因查询改变',
      rb.body.draftVersion === pub1.body.report.draftVersion, rb.body);

  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部覆盖变化核对 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
