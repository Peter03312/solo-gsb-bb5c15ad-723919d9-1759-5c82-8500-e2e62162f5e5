'use strict';

// 单视野细胞覆盖核对的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，
// 走 上传 → 定标 → 圈选/视野 → 覆盖查询（id/名称/错误语义/未定标）→ 发布 →
// 报告冻结查询 → 草稿后续修改/更正不改变旧报告 → 查询不写回 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8238;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-coverage-'));

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
    const up = await upload(png);
    check('上传图片成功', up.status === 200 || up.status === 201, up);
    const imgId = up.body.id;

    // ---------- 未定标阶段：先存细胞与视野，核对像素面积 + 待定标 ----------
    let r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 1,
      cells: [
        // A 跨越视野右边界：交集 50×40 = 2000（质心 (70,25) 在视野内）
        { id: 'cellA', name: '甲', outer: rect(50, 0, 40, 50), holes: [] },
        // B 只与视野共享边界（左边 x=100）：交集 0
        { id: 'cellB', name: '乙', outer: rect(100, 60, 40, 40), holes: [] }
      ]
    });
    check('未定标保存轮廓成功', r.status === 200, r.body);
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [{ id: 'fieldF', name: '中心视野', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    check('保存视野成功', r.status === 200, r.body);
    const vAfterFields = r.body.version;

    // 空标识 / 非字符串 → 400
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: '' });
    check('空视野标识 → 400', r.status === 400, r.body);
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, {});
    check('缺 fieldId → 400', r.status === 400, r.body);
    // 不存在 → 400（明确报错）
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'no-such-id' });
    check('不存在的视野标识 → 400', r.status === 400 && /视野标识不存在/.test(r.body.error), r.body);

    // 按 id 核对（未定标）
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'fieldF' });
    check('按 id 查询草稿覆盖成功', r.status === 200, r.body);
    check('scope=draft 且返回版本', r.body.scope === 'draft' && r.body.version === vAfterFields);
    check('matchedBy=id', r.body.matchedBy === 'id', r.body);
    check('未定标像素面积给出：10000/2000',
      approx(r.body.coverage.fieldAreaPx, 10000) && approx(r.body.coverage.coveredAreaPx, 2000),
      r.body.coverage);
    check('未覆盖 8000、覆盖率 20%',
      approx(r.body.coverage.uncoveredAreaPx, 8000) && approx(r.body.coverage.coverageRatio, 0.2),
      r.body.coverage);
    check('物理面积待定标',
      r.body.coverage.fieldAreaMm2 === null &&
      r.body.coverage.coveredAreaText === '待定标' &&
      r.body.coverage.calibrated === false,
      r.body.coverage);
    check('乙仅边界接触不贡献，名单只有甲',
      r.body.coverage.contributingCellKeys.length === 1 &&
      r.body.coverage.contributingCellKeys[0] === 'cellA',
      r.body.coverage);

    // 按名称核对（trim 后精确匹配）
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: ' 中心视野 ' });
    check('按名称查询草稿覆盖成功且 matchedBy=name',
      r.status === 200 && r.body.matchedBy === 'name' &&
      approx(r.body.coverage.coveredAreaPx, 2000), r.body);

    // 覆盖核对为只读：草稿版本不变
    const imgAfter = await jget(`/api/images/${imgId}`);
    check('查询不改动草稿版本', imgAfter.body.version === vAfterFields);
    const revs = await jget(`/api/images/${imgId}/revisions`);
    check('查询不新增修订（仍为 baseline/calib?/contours/fields）',
      Array.isArray(revs.body.revisions) && revs.body.revisions.length === 3, revs.body.revisions);

    // 草稿不存在 → 404
    r = await jsend('POST', '/api/images/does-not-exist/field-coverage', { fieldId: 'x' });
    check('草稿不存在 → 404', r.status === 404, r.body);

    // ---------- 定标（1 px = 1 μm → 1 px² = 1e-6 mm²） ----------
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: vAfterFields,
      p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标成功', r.status === 200, r.body);
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'fieldF' });
    check('定标后物理面积 mm²：0.01/0.002/0.008',
      approx(r.body.coverage.fieldAreaMm2, 0.01) &&
      approx(r.body.coverage.coveredAreaMm2, 0.002) &&
      approx(r.body.coverage.uncoveredAreaMm2, 0.008),
      r.body.coverage);
    check('定标后覆盖率仍 20%', r.body.coverage.coverageText === '20%', r.body.coverage);

    // ---------- 发布冻结 ----------
    const pub = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '切片A 报告'
    });
    check('发布成功', pub.status === 201, pub.body);
    const reportId = pub.body.report.id;

    // 报告覆盖查询：冻结数据
    let rr = await jsend('POST', `/api/reports/${reportId}/field-coverage`, { fieldId: 'fieldF' });
    check('报告按 id 覆盖查询成功',
      rr.status === 200 && rr.body.scope === 'report' &&
      rr.body.draftVersion === pub.body.report.draftVersion, rr.body);
    check('报告冻结结果 = 2000 px / 0.002 mm² / 20%',
      approx(rr.body.coverage.coveredAreaPx, 2000) &&
      approx(rr.body.coverage.coveredAreaMm2, 0.002) &&
      rr.body.coverage.coverageText === '20%', rr.body.coverage);

    // 报告侧错误语义：不存在 → 400；报告不存在 → 404
    rr = await jsend('POST', `/api/reports/${reportId}/field-coverage`, { fieldId: 'ghost' });
    check('报告内不存在的视野标识 → 400', rr.status === 400 && /视野标识不存在/.test(rr.body.error), rr.body);
    rr = await jsend('POST', '/api/reports/no-report/field-coverage', { fieldId: 'fieldF' });
    check('报告不存在 → 404', rr.status === 404, rr.body);

    // ---------- 草稿后续修改不改变旧报告 ----------
    // 把细胞换成完全铺满视野的大细胞（覆盖变为 100%），仅改草稿
    let cur = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: cur.body.version,
      cells: [{ id: 'cellC', name: '丙', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    check('后续轮廓修改成功', r.status === 200, r.body);
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'fieldF' });
    check('草稿覆盖实时变为 100%（10000 px）',
      approx(r.body.coverage.coveredAreaPx, 10000) && r.body.coverage.coverageText === '100%',
      r.body.coverage);
    rr = await jsend('POST', `/api/reports/${reportId}/field-coverage`, { fieldId: 'fieldF' });
    check('旧报告覆盖仍为冻结的 20%（2000 px）',
      approx(rr.body.coverage.coveredAreaPx, 2000) && rr.body.coverage.coverageText === '20%',
      rr.body.coverage);

    // ---------- 报告更正：新报告反映新草稿，旧报告仍不变 ----------
    cur = await jget(`/api/images/${imgId}`);
    const trace = await jsend('GET', `/api/reports/${reportId}/trace`);
    const cor = await jsend('POST', `/api/reports/${reportId}/correct`, {
      reason: '补全标注后重发',
      draftVersion: cur.body.version,
      expectedTipId: trace.body.tipId
    });
    check('更正发布成功', cor.status === 201, cor.body);
    const newReportId = cor.body.report.id;
    let nr = await jsend('POST', `/api/reports/${newReportId}/field-coverage`, { fieldId: 'fieldF' });
    check('新报告覆盖为 100%（更正后冻结）',
      nr.status === 200 && nr.body.coverage.coverageText === '100%', nr.body && nr.body.coverage);
    rr = await jsend('POST', `/api/reports/${reportId}/field-coverage`, { fieldId: 'fieldF' });
    check('被更正旧报告覆盖仍为 20%', rr.body.coverage.coverageText === '20%', rr.body.coverage);
    // 查询不写回报告：同一份报告重复查询结果完全一致（幂等）
    const nr2 = await jsend('POST', `/api/reports/${newReportId}/field-coverage`, { fieldId: 'fieldF' });
    check('覆盖查询幂等、不写回报告',
      JSON.stringify(nr2.body.coverage) === JSON.stringify(nr.body.coverage));

  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部单视野覆盖核对 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
