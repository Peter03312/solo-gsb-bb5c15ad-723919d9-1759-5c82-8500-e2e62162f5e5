'use strict';

// 视野 id 身份歧义修复 · 端到端 HTTP 自测（npm test）：
//
// 修复内容：整批保存视野前校验本批 id 唯一（冲突指出位置、整批拒绝、版本/修订不变）；
// 既有重复 id 草稿、历史修订与已发布报告不被静默改写；基于重复 id 的合并统计与
// 单视野分析（覆盖核对/网格密度/责任区/覆盖变化核对）明确拒绝；按唯一名称查询仍选中对应视野；
// 编辑页可按现有版本校验修正当前草稿，成功后追加正常修订；旧报告保持冻结、只读、仍可导出；
// 正常 id 优先于名称、名称重名报错；重复 id 草稿不得发布/更正，修正后发布/更正恢复正常。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const PORT = 8251;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fieldid-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function jget(p) { return jsend('GET', p); }

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

// 直接打开运行中服务的 SQLite（仅用于构造“修复前遗留”的重复 id 数据）
function openDb() {
  return new Database(path.join(DATA_DIR, 'app.db'));
}

// 插入一份携带重复 id 视野的“历史已发布报告”（服务修复前可能产生的数据）
function insertLegacyReport(db, { imageId, version, fields, cells, calib, title, storedName }) {
  const reportId = crypto.randomUUID();
  const snapName = `${reportId}${path.extname(storedName)}`;
  fs.copyFileSync(path.join(DATA_DIR, 'images', storedName),
    path.join(DATA_DIR, 'snapshots', snapName));
  db.prepare(`INSERT INTO reports
              (id, image_id, draft_version, title, filename, snapshot_name,
               width, height, calib, cells, fields)
              VALUES (?, ?, ?, ?, ?, ?, 300, 300, ?, ?, ?)`).run(
    reportId, imageId, version, title, 'a.png', snapName,
    JSON.stringify(calib), JSON.stringify(cells), JSON.stringify(fields));
  return reportId;
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
    const CALIB = { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100, scale: 1 };
    const CELLS = [{ id: 'c1', name: '细胞1', outer: rect(5, 5, 10, 10), holes: [], areaUm2: 100, perimeterUm: 40 }];

    // ---------- 1. 正常流程不被影响 ----------
    const up = await upload(png);
    check('上传切片', up.status === 201, up.body);
    const imgId = up.body.id;
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, { version: 1, ...CALIB });
    check('定标成功', r.status === 200, r.body);
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'fA', name: '甲野', outer: rect(0, 0, 100, 100), holes: [] },
        { id: 'fB', name: '乙野', outer: rect(120, 0, 80, 80), holes: [] }
      ]
    });
    check('唯一 id 视野整批保存成功', r.status === 200, r.body);
    const afterSaveVersion = r.body.version;
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: afterSaveVersion, cells: CELLS
    });
    check('保存轮廓成功', r.status === 200, r.body);

    let q = await jsend('POST', `/api/images/${imgId}/field-merge`, { fieldIds: ['fA', 'fB'] });
    check('正常合并统计 200', q.status === 200, q.body);
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'fA' });
    check('正常覆盖核对（id）200', q.status === 200 && q.body.matchedBy === 'id', q.body);
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: ' 乙野 ' });
    check('正常覆盖核对（名称 trim）200', q.status === 200 && q.body.matchedBy === 'name', q.body);

    // ---------- 2. 保存重复 id：整批拒绝、指出位置、版本/修订不变 ----------
    const revsBefore = await jget(`/api/images/${imgId}/revisions`);
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: afterSaveVersion + 1, // 轮廓保存后的当前版本
      fields: [
        { id: 'dup', name: '前野', outer: rect(0, 0, 50, 50), holes: [] },
        { id: 'dup', name: '后野', outer: rect(60, 60, 50, 50), holes: [] }
      ]
    });
    check('重复 id 保存 → 400', r.status === 400, r.body);
    check('错误指出重复 id 与两个位置（第几个+名称）',
      /id 必须唯一/.test(r.body.error) && /id「dup」/.test(r.body.error) &&
      /第 1 个视野（前野）/.test(r.body.error) && /第 2 个视野（后野）/.test(r.body.error) &&
      /整批不生效/.test(r.body.error), r.body.error);

    const imgAfter = await jget(`/api/images/${imgId}`);
    check('整批拒绝后草稿版本不变', imgAfter.body.version === afterSaveVersion + 1, imgAfter.body.version);
    check('整批拒绝后视野内容不变（仍为 fA/fB）',
      imgAfter.body.fields.map((f) => f.id).join(',') === 'fA,fB', imgAfter.body.fields);
    const revsAfter = await jget(`/api/images/${imgId}/revisions`);
    check('整批拒绝后修订条数不变',
      revsAfter.body.revisions.length === revsBefore.body.revisions.length,
      [revsBefore.body.revisions.length, revsAfter.body.revisions.length]);

    // 几何非法优先于 id 唯一性（既有契约：先指出具体几何问题）
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: afterSaveVersion + 1,
      fields: [
        { id: 'dup', name: '坏', outer: rect(0, 0, 10, 10), holes: [] },
        { id: 'dup', name: '好', outer: rect(0, 0, 100000, 10), holes: [] }
      ]
    });
    check('几何非法时报几何错误（不混入 id 冲突）',
      r.status === 400 && /越出图片/.test(r.body.error) && !/id 必须唯一/.test(r.body.error), r.body.error);

    // ---------- 3. 构造修复前遗留数据：重复 id 草稿 + 重复 id 已发布报告 ----------
    const db = openDb();
    const imgRow = db.prepare('SELECT * FROM images WHERE id = ?').get(imgId);
    const legacyFields = [
      { id: 'LEG', name: '前遗留', outer: rect(0, 0, 100, 100), holes: [] },
      { id: 'LEG', name: '后遗留', outer: rect(0, 0, 50, 50), holes: [] } // 面积不同，便于区分
    ];
    db.prepare('UPDATE images SET fields = ? WHERE id = ?').run(JSON.stringify(legacyFields), imgId);

    const legacyReportId = insertLegacyReport(db, {
      imageId: imgId,
      version: imgRow.version,
      fields: legacyFields,
      cells: CELLS,
      calib: CALIB,
      title: '遗留重复 id 报告',
      storedName: imgRow.stored_name
    });

    // 另一张切片 + 一份【唯一 id】报告，用于跨报告/覆盖变化核对
    const up2 = await upload(png);
    const img2 = up2.body.id;
    let rr = await jsend('PUT', `/api/images/${img2}/calibration`, { version: 1, ...CALIB });
    rr = await jsend('PUT', `/api/images/${img2}/fields`, {
      version: rr.body.version,
      fields: [{ id: 'LEG', name: '它切片视野', outer: rect(0, 0, 90, 90), holes: [] }]
    });
    rr = await jsend('PUT', `/api/images/${img2}/contours`, { version: rr.body.version, cells: CELLS });
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, {
      version: rr.body.version, title: '它切片报告'
    });
    check('无重复 id 的切片可正常发布', pub2.status === 201, pub2.body);
    db.close();

    // ---------- 4. 遗留草稿：基于重复 id 的分析明确拒绝；唯一名称仍可用 ----------
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'LEG' });
    check('遗留草稿：按重复 id 覆盖核对 → 400 身份歧义',
      q.status === 400 && /身份歧义/.test(q.body.error) &&
      /第 1 个视野（前遗留）/.test(q.body.error) && /第 2 个视野（后遗留）/.test(q.body.error), q.body.error);
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: '后遗留' });
    check('遗留草稿：按唯一名称覆盖核对 → 200 且选中第二个视野（净面积 2500）',
      q.status === 200 && q.body.matchedBy === 'name' && q.body.coverage.fieldAreaPx === 2500,
      q.body && q.body.coverage && q.body.coverage.fieldAreaPx);
    q = await jsend('POST', `/api/images/${imgId}/field-merge`, { fieldIds: ['LEG', 'whatever'] });
    check('遗留草稿：合并统计选择重复 id → 400 身份歧义',
      q.status === 400 && /身份歧义/.test(q.body.error), q.body.error);

    // ---------- 5. 遗留报告：冻结只读，重复 id 分析拒绝；名称仍可用；导出不变 ----------
    q = await jsend('POST', `/api/reports/${legacyReportId}/field-coverage`, { fieldId: 'LEG' });
    check('遗留报告：按重复 id 覆盖核对 → 400', q.status === 400 && /身份歧义/.test(q.body.error), q.body.error);
    q = await jsend('POST', `/api/reports/${legacyReportId}/field-grid`, { fieldId: 'LEG', rows: 2, cols: 2 });
    check('遗留报告：按重复 id 网格密度 → 400', q.status === 400 && /身份歧义/.test(q.body.error), q.body.error);
    q = await jsend('POST', `/api/reports/${legacyReportId}/field-zones`, { fieldId: 'LEG' });
    check('遗留报告：按重复 id 责任区 → 400', q.status === 400 && /身份歧义/.test(q.body.error), q.body.error);
    q = await jsend('POST', `/api/reports/${legacyReportId}/field-merge`, { fieldIds: ['LEG', 'LEG'] });
    check('遗留报告：合并统计重复选择 → 400（请求内重复）',
      q.status === 400 && /视野标识重复/.test(q.body.error), q.body.error);

    q = await jsend('POST', `/api/reports/${legacyReportId}/field-zones`, { fieldId: '后遗留' });
    check('遗留报告：按唯一名称责任区 → 200 且取净面积 2500 的视野',
      q.status === 200 && q.body.matchedBy === 'name' && q.body.zones.fieldAreaPx === 2500,
      q.body && q.body.zones && q.body.zones.fieldAreaPx);
    q = await jsend('POST', `/api/reports/${legacyReportId}/field-grid`, { fieldId: '前遗留', rows: 1, cols: 1 });
    check('遗留报告：按唯一名称网格密度 → 200 且取净面积 10000 的视野',
      q.status === 200 && q.body.matchedBy === 'name' && q.body.grid.fieldAreaPx === 10000,
      q.body && q.body.grid && q.body.grid.fieldAreaPx);

    // 覆盖变化核对：基线报告重复 id → 400
    q = await jsend('POST', '/api/reports/field-coverage-diff', {
      baselineReportId: legacyReportId, retestReportId: pub2.body.report.id, fieldId: 'LEG'
    });
    check('覆盖变化核对：不同切片 → 400（既有语义优先）',
      q.status === 400 && /不属于同一切片/.test(q.body.error), q.body.error);

    // 旧报告读取与导出保持可用（冻结、只读）
    const rep = await jget(`/api/reports/${legacyReportId}`);
    check('遗留报告读取正常且 fields 未被改写（仍含两个 LEG）',
      rep.status === 200 && rep.body.fields.map((f) => f.id).join(',') === 'LEG,LEG', rep.body);
    const csv = await fetch(`${base}/api/reports/${legacyReportId}/field-csv`);
    check('遗留报告视野统计 CSV 仍可导出', csv.status === 200);
    const pngResp = await fetch(`${base}/api/reports/${legacyReportId}/png`);
    check('遗留报告标注 PNG 仍可导出', pngResp.status === 200);
    const fileResp = await fetch(`${base}/api/reports/${legacyReportId}/file`);
    check('遗留报告快照仍可读取', fileResp.status === 200);

    // ---------- 6. 重复 id 草稿禁止发布与更正 ----------
    let cur = await jget(`/api/images/${imgId}`);
    q = await jsend('POST', `/api/images/${imgId}/publish`, { version: cur.body.version, title: '不该发布' });
    check('遗留重复 id 草稿发布 → 400',
      q.status === 400 && /id 必须唯一/.test(q.body.error) && /第 1 个视野/.test(q.body.error), q.body.error);
    check('被拒发布不推进版本', (await jget(`/api/images/${imgId}`)).body.version === cur.body.version);
    const trace = await jget(`/api/reports/${legacyReportId}/trace`);
    q = await jsend('POST', `/api/reports/${legacyReportId}/correct`, {
      reason: '尝试更正重复 id 草稿', draftVersion: cur.body.version, expectedTipId: trace.body.tipId
    });
    check('遗留重复 id 草稿发起更正 → 400',
      q.status === 400 && /id 必须唯一/.test(q.body.error), q.body.error);
    // 旧报告仍在（未被改写、未生成新报告）
    check('被拒更正后旧报告仍可读', (await jget(`/api/reports/${legacyReportId}`)).status === 200);

    // ---------- 7. 按现有版本校验修正草稿：重新保存成功 + 追加正常修订 ----------
    const fixedFields = [
      { id: 'LEG-1', name: '前遗留', outer: rect(0, 0, 100, 100), holes: [] },
      { id: 'LEG-2', name: '后遗留', outer: rect(0, 0, 50, 50), holes: [] }
    ];
    const revisionsBeforeFix = (await jget(`/api/images/${imgId}/revisions`)).body.revisions.length;
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: cur.body.version, fields: fixedFields
    });
    check('修正重复 id 后整批保存成功（携带当前版本）', r.status === 200, r.body);
    check('修正后视野 id 唯一', r.body.fields.map((f) => f.id).join(',') === 'LEG-1,LEG-2', r.body.fields);
    const revisionsAfterFix = await jget(`/api/images/${imgId}/revisions`);
    check('成功修正后追加一条正常 fields 修订',
      revisionsAfterFix.body.revisions.length === revisionsBeforeFix + 1 &&
      revisionsAfterFix.body.revisions[0].type === 'fields',
      revisionsAfterFix.body.revisions.map((x) => x.type));
    const newVersion = r.body.version;

    // 修正后分析恢复正常
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'LEG-2' });
    check('修正后按新 id 覆盖核对 → 200',
      q.status === 200 && q.body.coverage.fieldAreaPx === 2500, q.body && q.body.coverage);
    // 旧 id 已失效
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'LEG' });
    check('修正后旧重复 id 查询 → 400 不存在',
      q.status === 400 && /视野标识不存在：LEG/.test(q.body.error), q.body.error);

    // 修正后发布成功
    q = await jsend('POST', `/api/images/${imgId}/publish`, { version: newVersion, title: '修正后报告' });
    check('修正后发布成功 201', q.status === 201, q.body);
    const newReportId = q.body.report.id;
    q = await jsend('POST', `/api/reports/${newReportId}/field-zones`, { fieldId: 'LEG-1' });
    check('新报告按新 id 责任区 → 200', q.status === 200, q.body);

    // ---------- 8. 旧报告继续冻结：未因修正而变化 ----------
    const legacyAgain = await jget(`/api/reports/${legacyReportId}`);
    check('草稿修正并重新发布后，遗留报告仍冻结旧 fields（LEG,LEG）',
      legacyAgain.body.fields.map((f) => f.id).join(',') === 'LEG,LEG', legacyAgain.body.fields);
    q = await jsend('POST', `/api/reports/${legacyReportId}/field-zones`, { fieldId: '后遗留' });
    check('遗留报告按唯一名称仍可分析（净面积 2500）',
      q.status === 200 && q.body.zones.fieldAreaPx === 2500, q.body && q.body.zones);

    // 覆盖变化核对：同切片两份报告（遗留基线 + 修正后复测）
    // 基线视野标识重复 id → 400 身份歧义；按基线唯一名称 → 200
    q = await jsend('POST', '/api/reports/field-coverage-diff', {
      baselineReportId: legacyReportId, retestReportId: newReportId, fieldId: 'LEG'
    });
    check('覆盖变化核对：基线重复 id → 400 身份歧义',
      q.status === 400 && /身份歧义/.test(q.body.error) && /前遗留/.test(q.body.error), q.body.error);
    q = await jsend('POST', '/api/reports/field-coverage-diff', {
      baselineReportId: legacyReportId, retestReportId: newReportId, fieldId: '前遗留'
    });
    check('覆盖变化核对：基线按唯一名称 → 200（名称查询仍选中对应视野）',
      q.status === 200 && q.body.matchedBy === 'name' && q.body.diff.fieldAreaPx === 10000,
      q.body && q.body.diff && q.body.diff.fieldAreaPx);

    // ---------- 9. 历史修订不被静默改写：遗留状态可恢复 ----------
    const revList = await jget(`/api/images/${imgId}/revisions`);
    // 构造一条含重复 id 的历史修订（模拟修复前保存留下的修订），不改写既有修订
    const db2 = openDb();
    const dupRevId = crypto.randomUUID();
    db2.prepare(`INSERT INTO draft_revisions
                 (id, image_id, seq, rev_type, note, draft_version, width, height,
                  calib, cells, fields, calibrated, cell_count, field_count)
                 VALUES (?, ?,
                   (SELECT COALESCE(MAX(seq), 0) + 1 FROM draft_revisions WHERE image_id = ?),
                   'fields', '修复前遗留：重复 id 视野修订', ?, 300, 300, ?, ?, ?, 1, 1, 2)`)
      .run(dupRevId, imgId, imgId, newVersion,
        JSON.stringify(CALIB), JSON.stringify(CELLS), JSON.stringify(legacyFields));
    db2.close();

    const revPreview = await jget(`/api/images/${imgId}/revisions/${dupRevId}`);
    check('含重复 id 的历史修订仍可预览（不被改写）',
      revPreview.status === 200 &&
      revPreview.body.fields.map((f) => f.id).join(',') === 'LEG,LEG', revPreview.body);

    cur = await jget(`/api/images/${imgId}`);
    const restore = await jsend('POST', `/api/images/${imgId}/revisions/${dupRevId}/restore`,
      { version: cur.body.version });
    check('恢复遗留修订成功 201（追加 restore 修订，不抹历史）',
      restore.status === 201 && restore.body.revision.type === 'restore', restore.body);
    check('恢复后当前草稿为重复 id 状态（由用户显式恢复，等待再次修正）',
      restore.body.image.fields.map((f) => f.id).join(',') === 'LEG,LEG', restore.body.image.fields);
    // 恢复后再次保存修正仍成功
    cur = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: cur.body.version, fields: fixedFields
    });
    check('恢复冲突状态后仍可按当前版本再次修正保存', r.status === 200, r.body);

    // ---------- 10. 既有 HTTP 契约回归：409/404/名称重名 ----------
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: 999999, fields: fixedFields
    });
    check('过期版本 → 409 + currentVersion',
      r.status === 409 && typeof r.body.currentVersion === 'number', r.body);
    q = await jsend('POST', '/api/images/no-such-image/field-coverage', { fieldId: 'x' });
    check('草稿不存在 → 404', q.status === 404, q.body);
    q = await jsend('POST', '/api/reports/no-such-report/field-zones', { fieldId: 'x' });
    check('报告不存在 → 404', q.status === 404, q.body);
    // 名称重名（id 唯一）仍按原契约报错
    cur = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: cur.body.version,
      fields: [
        { id: 'n1', name: '同名', outer: rect(0, 0, 40, 40), holes: [] },
        { id: 'n2', name: '同名', outer: rect(80, 0, 40, 40), holes: [] }
      ]
    });
    check('跨视野同名（id 唯一）允许保存', r.status === 200, r.body);
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: '同名' });
    check('名称重名 → 400 并提示改用 id',
      q.status === 400 && /2 个同名视野/.test(q.body.error) && /改用视野 id/.test(q.body.error), q.body.error);
    q = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'n2' });
    check('重名时 id 仍优先精确匹配 → 200', q.status === 200 && q.body.matchedBy === 'id', q.body);

  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部视野 id 身份歧义修复 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
