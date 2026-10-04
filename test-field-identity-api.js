'use strict';

// 视野 id 身份歧义修复 · 端到端 HTTP 自测（npm test）：
//   1) 整批保存视野：批次内 id 重复 → 400，指出冲突 id 与 1 基位置，整批拒绝、
//      版本不变、不留修订；缺失 id 自动生成；重名但 id 唯一仍允许（名称重名报错契约不变）；
//   2) 既有重复 id 草稿（直接改库模拟修复上线前的历史数据）：GET 草稿如实附 fieldIdConflicts，
//      草稿合并/覆盖核对按重复 id 明确拒绝，按视野唯一名称的单视野分析仍选中对应视野；
//   3) 历史重复 id 已发布报告：冻结、只读、fieldIdConflicts 如实标出；报告侧合并/覆盖/网格/
//      责任区/覆盖变化核对按重复 id 拒绝、按唯一名称照常；旧报告在全部查询后字节不变；
//   4) 修正路径：按当前版本 PUT 唯一 id 的视野 → 成功并追加一条正常 fields 修订；
//      再发布的新报告无冲突，旧报告仍冻结；
//   5) 历史修订含重复 id：预览接口只读标出 fieldIdConflicts，不被改写；
//   6) id 优先于名称的既有契约保持。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const PORT = 8253;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fieldid-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

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

  // 独立连接改库（服务端 WAL，允许并发只读/少量写入测试夹具）
  const db = new Database(path.join(DATA_DIR, 'app.db'));

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();

    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 1px=1μm', r.status === 200, r.body);

    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [{ id: 'cellA', name: '甲', outer: rect(10, 10, 10, 10), holes: [] }]
    });
    check('保存一个细胞（质心 (15,15)）', r.status === 200, r.body);
    const vAfterCells = r.body.version;

    // ---------- 1) 整批保存：重复 id 整批拒绝 ----------
    const dupBatch = [
      { id: 'sameId', name: '视野甲', outer: rect(0, 0, 100, 100), holes: [] },
      { id: 'u2', name: '独有乙', outer: rect(0, 0, 120, 120), holes: [] },
      { id: 'sameId', name: '视野丙', outer: rect(0, 0, 80, 80), holes: [] }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/fields`, { version: vAfterCells, fields: dupBatch });
    check('重复 id → 400',
      r.status === 400 && /id 在本批中不唯一/.test(r.body.error), r.body);
    check('错误指出冲突 id 与 1 基位置（第 1、3 个）',
      /id「sameId」同时用于第 1、3 个视野/.test(r.body.error), r.body && r.body.error);
    check('错误体带 code=FIELD_ID_CONFLICT 与结构化 conflicts',
      r.body.code === 'FIELD_ID_CONFLICT' &&
      JSON.stringify(r.body.conflicts) === JSON.stringify([{ id: 'sameId', positions: [1, 3] }]), r.body);

    const afterReject = await jget(`/api/images/${imgId}`);
    check('整批拒绝后版本不变、fields 仍为空、不留修订入口数据',
      afterReject.body.version === vAfterCells &&
      Array.isArray(afterReject.body.fields) && afterReject.body.fields.length === 0,
      { version: afterReject.body.version, fields: afterReject.body.fields });
    let revCount = (db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId)).n;
    check('整批拒绝不新增修订（仍为定标/轮廓/基线共 3 条）', revCount === 3, { revCount });

    // 几何非法 + id 重复：两种都拒，但这里至少确认整批不写入（几何校验先报也行）
    const badAndDup = [
      { id: 'g', name: '好', outer: rect(0, 0, 10, 10), holes: [] },
      { id: 'g', name: '坏', outer: rect(0, 0, 5, 5), holes: [] }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/fields`, { version: vAfterCells, fields: badAndDup });
    check('非法视野批次同样 400 且不写入', r.status === 400, r.body);
    const stillEmpty = await jget(`/api/images/${imgId}`);
    check('拒绝后仍为空、版本不变', stillEmpty.body.fields.length === 0 && stillEmpty.body.version === vAfterCells);

    // 缺失 id 自动生成，且自动生成的 id 不与批次内显式 id 冲突
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: vAfterCells,
      fields: [
        { name: '自动id1', outer: rect(0, 0, 40, 40), holes: [] },
        { id: 'explicit1', name: '显式id', outer: rect(0, 0, 60, 60), holes: [] },
        { name: '自动id2', outer: rect(0, 0, 30, 30), holes: [] }
      ]
    });
    check('缺失 id 自动生成 → 200', r.status === 200, r.body);
    check('三个 id 均非空且两两不同',
      r.body.fields.length === 3 && new Set(r.body.fields.map((f) => f.id)).size === 3 &&
      r.body.fields.some((f) => f.id === 'explicit1'), r.body.fields.map((f) => f.id));
    check('成功保存后无冲突标记', (r.body.fieldIdConflicts || []).length === 0, r.body.fieldIdConflicts);
    const vGood = r.body.version;
    revCount = (db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId)).n;
    check('成功保存追加一条 fields 修订（共 4 条）', revCount === 4, { revCount });

    // 重名但 id 唯一：保存允许；按该名称的覆盖核对仍按既有契约报「重名」
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: vGood,
      fields: [
        { id: 'n1', name: '同名', outer: rect(0, 0, 40, 40), holes: [] },
        { id: 'n2', name: '同名', outer: rect(0, 0, 60, 60), holes: [] }
      ]
    });
    check('重名但 id 唯一 → 保存允许（既有契约）', r.status === 200, r.body);
    let cov = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: '同名' });
    check('名称重名 → 400 提示改用 id（契约保持）',
      cov.status === 400 && /同名视野/.test(cov.body.error), cov.body);
    cov = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'n2' });
    check('按 id n2 核对成功（id 唯一）', cov.status === 200 && cov.body.matchedBy === 'id', cov.body);

    // id 优先于名称：f1(id=q,name=甲)、f2(id=f2,name=q)；查询 q 必须按 id 命中 f1
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'q', name: '甲', outer: rect(0, 0, 40, 40), holes: [] },
        { id: 'f2', name: 'q', outer: rect(0, 0, 60, 60), holes: [] }
      ]
    });
    check('id 与他人名称相同的批次可保存', r.status === 200, r.body);
    cov = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'q' });
    check('id 优先于名称：q 命中 id=q 的「甲」',
      cov.status === 200 && cov.body.matchedBy === 'id' && cov.body.coverage.fieldName === '甲', cov.body);

    // ---------- 2) 注入修复上线前的「重复 id 草稿」历史数据 ----------
    const dupFields = [
      { id: 'X', name: '视野甲', outer: rect(0, 0, 100, 100), holes: [] },
      { id: 'X', name: '视野丙', outer: rect(0, 0, 120, 120), holes: [] },
      { id: 'u3', name: '独有', outer: rect(0, 0, 50, 50), holes: [] }
    ];
    const imgRow = db.prepare('SELECT * FROM images WHERE id = ?').get(imgId);
    // 同步塞一条含重复 id 的历史修订（模拟上线前快照），稍后验证预览只读标出
    const revSeq = (db.prepare('SELECT COALESCE(MAX(seq),0)+1 s FROM draft_revisions WHERE image_id = ?').get(imgId)).s;
    const legacyRevId = crypto.randomUUID();
    db.prepare(`INSERT INTO draft_revisions
                (id, image_id, seq, rev_type, note, draft_version, width, height,
                 calib, cells, fields, calibrated, cell_count, field_count)
                VALUES (?, ?, ?, 'fields', ?, ?, ?, ?, ?, ?, ?, 1, 1, 3)`)
      .run(legacyRevId, imgId, revSeq, '历史遗留：3 个视野含重复 id（夹具）', imgRow.version,
           imgRow.width, imgRow.height, imgRow.calib, imgRow.cells, JSON.stringify(dupFields));
    db.prepare('UPDATE images SET fields = ? WHERE id = ?').run(JSON.stringify(dupFields), imgId);

    let g = await jget(`/api/images/${imgId}`);
    check('遗留重复 id 草稿：GET 附 fieldIdConflicts',
      JSON.stringify(g.body.fieldIdConflicts) ===
        JSON.stringify([{ id: 'X', positions: [1, 2] }]), g.body.fieldIdConflicts);

    // 遗留草稿：再保存仍按当前版本被拒绝（不能把重复 id“洗白”为新版本）
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: g.body.version,
      fields: dupFields.map((f) => ({ ...f }))
    });
    check('遗留重复 id 草稿再次保存 → 400', r.status === 400 && /不唯一/.test(r.body.error), r.body);

    // 草稿合并：勾选命中重复 id → 400
    let m = await jsend('POST', `/api/images/${imgId}/field-merge`, { fieldIds: ['X', 'u3'] });
    check('草稿合并命中重复 id → 400 身份歧义',
      m.status === 400 && /身份歧义/.test(m.body.error), m.body);

    // 草稿覆盖核对：按重复 id → 400；按唯一名称「独有」→ 200 且选中对应视野
    cov = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'X' });
    check('草稿覆盖核对按重复 id → 400',
      cov.status === 400 && /身份歧义/.test(cov.body.error), cov.body);
    cov = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: ' 独有 ' });
    check('草稿覆盖核对按唯一名称 → 200（不受其它重复 id 影响）',
      cov.status === 200 && cov.body.matchedBy === 'name' &&
      cov.body.coverage.fieldId === 'u3' && cov.body.coverage.fieldName === '独有' &&
      cov.body.coverage.fieldAreaPx === 2500, cov.body);

    // 历史修订预览：只读标出冲突
    const revView = await jget(`/api/images/${imgId}/revisions/${legacyRevId}`);
    check('历史修订预览附 fieldIdConflicts（只读、不被改写）',
      revView.status === 200 &&
      JSON.stringify(revView.body.fieldIdConflicts) ===
        JSON.stringify([{ id: 'X', positions: [1, 2] }]) &&
      revView.body.fields.length === 3, revView.body && revView.body.fieldIdConflicts);

    // ---------- 3) 发布遗留草稿 → 历史重复 id 报告（冻结、只读） ----------
    const pub = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: g.body.version, title: '遗留重复 id 报告'
    });
    check('遗留重复 id 草稿可发布（发布契约不变，冲突在分析侧拒绝）',
      pub.status === 201, pub.body);
    const RID = pub.body.report.id;
    check('报告 GET 附 fieldIdConflicts',
      JSON.stringify(pub.body.report.fieldIdConflicts) ===
        JSON.stringify([{ id: 'X', positions: [1, 2] }]), pub.body.report.fieldIdConflicts);

    // 报告侧合并/覆盖/网格/责任区：按重复 id 全部 400
    m = await jsend('POST', `/api/reports/${RID}/field-merge`, { fieldIds: ['X', 'u3'] });
    check('报告合并命中重复 id → 400', m.status === 400 && /身份歧义/.test(m.body.error), m.body);
    cov = await jsend('POST', `/api/reports/${RID}/field-coverage`, { fieldId: 'X' });
    check('报告覆盖核对按重复 id → 400', cov.status === 400 && /身份歧义/.test(cov.body.error), cov.body);
    let grid = await jsend('POST', `/api/reports/${RID}/field-grid`, { fieldId: 'X', rows: 2, cols: 2 });
    check('报告网格密度按重复 id → 400', grid.status === 400 && /身份歧义/.test(grid.body.error), grid.body);
    let zones = await jsend('POST', `/api/reports/${RID}/field-zones`, { fieldId: 'X' });
    check('报告责任区按重复 id → 400', zones.status === 400 && /身份歧义/.test(zones.body.error), zones.body);

    // 按唯一名称：全部照常
    cov = await jsend('POST', `/api/reports/${RID}/field-coverage`, { fieldId: '独有' });
    check('报告覆盖核对按唯一名称 → 200',
      cov.status === 200 && cov.body.matchedBy === 'name' && cov.body.coverage.fieldId === 'u3', cov.body);
    grid = await jsend('POST', `/api/reports/${RID}/field-grid`, { fieldId: '独有', rows: 2, cols: 2 });
    check('报告网格密度按唯一名称 → 200（净面积 2500，4 格各 625）',
      grid.status === 200 && grid.body.matchedBy === 'name' &&
      grid.body.grid.sumAreaPx === 2500 &&
      grid.body.grid.cells.every((c) => c.areaPx === 625), grid.body);
    zones = await jsend('POST', `/api/reports/${RID}/field-zones`, { fieldId: '独有' });
    check('报告责任区按唯一名称 → 200',
      zones.status === 200 && zones.body.matchedBy === 'name' && zones.body.zones.fieldId === 'u3', zones.body);

    // 错误标识的既有契约：不存在 → 400；报告不存在 → 404
    cov = await jsend('POST', `/api/reports/${RID}/field-coverage`, { fieldId: 'ghost' });
    check('视野标识不存在 → 400（契约保持）', cov.status === 400 && /视野标识不存在：ghost/.test(cov.body.error), cov.body);
    cov = await jsend('POST', `/api/reports/no-such/field-coverage`, { fieldId: 'X' });
    check('报告不存在 → 404（契约保持）', cov.status === 404, cov.body);

    // ---------- 4) 修正草稿：按当前版本保存唯一 id，追加正常修订，再发布无冲突新报告 ----------
    g = await jget(`/api/images/${imgId}`);
    const fixedFields = [
      { id: 'fix1', name: '视野甲', outer: rect(0, 0, 100, 100), holes: [] },
      { id: 'fix2', name: '视野丙', outer: rect(0, 0, 120, 120), holes: [] },
      { id: 'fix3', name: '独有', outer: rect(0, 0, 50, 50), holes: [] }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/fields`, { version: g.body.version, fields: fixedFields });
    check('按当前版本保存唯一 id 视野 → 200', r.status === 200, r.body);
    check('修正后 fieldIdConflicts 清空', (r.body.fieldIdConflicts || []).length === 0, r.body.fieldIdConflicts);
    const revList = await jget(`/api/images/${imgId}/revisions`);
    const latestRevId = revList.body.revisions[0].id;
    const latestRev = await jget(`/api/images/${imgId}/revisions/${latestRevId}`);
    check('修正成功追加一条正常 fields 修订（完整快照 3 视野、无冲突）',
      revList.body.revisions[0].type === 'fields' &&
      latestRev.body.fields.length === 3 &&
      (latestRev.body.fieldIdConflicts || []).length === 0, latestRev.body);
    // 过期版本保存 → 409（契约保持）
    const stale = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: g.body.version, fields: fixedFields
    });
    check('修正后用旧版本保存 → 409 且不写入',
      stale.status === 409 && stale.body.currentVersion === r.body.version, stale.body);

    // 修正后按 id 的分析恢复正常
    m = await jsend('POST', `/api/images/${imgId}/field-merge`, { fieldIds: ['fix1', 'fix2'] });
    check('修正后草稿合并按 id → 200', m.status === 200 && m.body.stats.fieldCount === 2, m.body);

    const pub2 = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '修正后新报告'
    });
    check('修正后发布新报告 → 201', pub2.status === 201, pub2.body);
    const RID2 = pub2.body.report.id;
    check('新报告无冲突标记', (pub2.body.report.fieldIdConflicts || []).length === 0);

    // 覆盖变化核对：基线=遗留重复 id 报告 RID，复测=修正后新报告 RID2（同切片）
    let diff = await jsend('POST', '/api/reports/field-coverage-diff', {
      baselineReportId: RID, retestReportId: RID2, fieldId: 'X'
    });
    check('覆盖变化核对按基线重复 id → 400',
      diff.status === 400 && /身份歧义/.test(diff.body.error), diff.body);
    diff = await jsend('POST', '/api/reports/field-coverage-diff', {
      baselineReportId: RID, retestReportId: RID2, fieldId: '独有'
    });
    check('覆盖变化核对按基线视野唯一名称 → 200', diff.status === 200, diff.body);

    // 新报告按 id 一切正常
    grid = await jsend('POST', `/api/reports/${RID2}/field-grid`, { fieldId: 'fix2', rows: 3, cols: 3 });
    check('新报告网格密度按 id → 200（净面积 14400）',
      grid.status === 200 && grid.body.grid.sumAreaPx === 14400, grid.body);

    // ---------- 5) 旧报告冻结：全部查询后字段/统计字节不变 ----------
    const frozenAgain = await jget(`/api/reports/${RID}`);
    const frozenFresh = {
      fields: frozenAgain.body.fields,
      fieldStats: frozenAgain.body.fieldStats,
      fieldIdConflicts: frozenAgain.body.fieldIdConflicts,
      draftVersion: frozenAgain.body.draftVersion
    };
    check('旧报告在修正/新发布/各类查询后仍冻结（字段/统计/冲突标记/draftVersion 不变）',
      JSON.stringify(frozenFresh) === JSON.stringify({
        fields: pub.body.report.fields,
        fieldStats: pub.body.report.fieldStats,
        fieldIdConflicts: pub.body.report.fieldIdConflicts,
        draftVersion: pub.body.report.draftVersion
      }), frozenFresh);

    // 旧报告导出仍可用（冻结只读，不因冲突失效）
    const csv = await fetch(`${base}/api/reports/${RID}/field-csv`);
    check('旧报告视野统计 CSV 导出仍可用', csv.status === 200);

  } finally {
    db.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部视野 id 身份歧义修复 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
