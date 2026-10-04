'use strict';

// 草稿修订时间线与恢复的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，走
// 上传(基线) → 定标 → 轮廓 → 视野 → 时间线/详情预览 → 409/404/400 拒绝 →
// 恢复生成新版本新修订且不抹历史 → 按恢复标尺重算测量与视野统计 → 失败不留记录 →
// 已发布报告与更正链不受恢复影响 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8237;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-rev-'));

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

const square = (x, y, w) => ({
  outer: [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }
  ], holes: []
});

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

    // 上传即有一条基线修订（空草稿，v1）
    let tl = (await jget(`/api/images/${imgId}/revisions`)).body;
    check('上传后即有 1 条基线修订', tl.revisions.length === 1 && tl.currentVersion === 1, tl);
    check('基线类型与内容', tl.revisions[0].type === 'baseline' &&
      tl.revisions[0].cellCount === 0 && tl.revisions[0].fieldCount === 0 &&
      tl.revisions[0].calibrated === false, tl.revisions[0]);
    const baseRev = tl.revisions[0];

    // 定标 v2
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 200', r.status === 200, r.body && r.body.error);

    // 轮廓 v3：100x100 正方形在 scale=1 下面积 10000
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2, cells: [{ id: 'cell-1', name: '细胞1', ...square(10, 10, 100) }]
    });
    check('保存轮廓 200', r.status === 200, r.body && r.body.error);
    check('轮廓修订后测量值', r.body.cells[0].areaUm2 === 10000, r.body.cells[0]);

    // 视野 v4：覆盖整个区域，质心在内，细胞计数 1
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: 3, fields: [{ id: 'f-1', name: '视野1', ...square(0, 0, 200) }]
    });
    check('保存视野 200', r.status === 200, r.body && r.body.error);
    check('视野统计已计算', r.body.fieldStats[0].cellCount === 1, r.body.fieldStats);

    // 失败请求不留修订：非法轮廓（越界）整批拒绝，修订数不增加
    tl = (await jget(`/api/images/${imgId}/revisions`)).body;
    const countAfterOk = tl.revisions.length; // baseline + calib + contours + fields = 4
    check('四次写入后共 4 条修订', countAfterOk === 4, tl.revisions.map((x) => x.seq + ':' + x.type));
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 4, cells: [{ id: 'bad', name: '越界', ...square(0, 0, 400) }]
    });
    check('非法轮廓被拒 400', r.status === 400, r.body);
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 99, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('过期定标被拒 409', r.status === 409 && r.body.currentVersion === 4, r.body);
    tl = (await jget(`/api/images/${imgId}/revisions`)).body;
    check('失败请求不留修订（仍 4 条）', tl.revisions.length === 4, tl.revisions.length);

    // 时间线由新到旧、seq 连续、类型与版本快照正确
    const seqTypes = tl.revisions.map((x) => x.type);
    check('时间线顺序 fields→contours→calibration→baseline',
      JSON.stringify(seqTypes) === JSON.stringify(['fields', 'contours', 'calibration', 'baseline']), seqTypes);
    const calibRev = tl.revisions.find((x) => x.type === 'calibration');
    check('定标修订记录 v2', calibRev.draftVersion === 2 && calibRev.calibrated === true);
    const contoursRev = tl.revisions.find((x) => x.type === 'contours');
    check('轮廓修订记录 v3、1 细胞、0 视野',
      contoursRev.draftVersion === 3 && contoursRev.cellCount === 1 && contoursRev.fieldCount === 0);

    // 详情预览：定标修订快照应是“已定标但还没有细胞/视野”
    let det = (await jget(`/api/images/${imgId}/revisions/${calibRev.id}`)).body;
    check('定标修订详情：有标尺无细胞无视野',
      det.calib && det.calib.scale === 1 && det.cells.length === 0 && det.fields.length === 0, det);
    check('详情 isCurrent=false（当前 v4）', det.isCurrent === false);
    det = (await jget(`/api/images/${imgId}/revisions/${tl.revisions[0].id}`)).body;
    check('最新修订详情 isCurrent=true', det.isCurrent === true);

    // 404：修订不存在 / 不属于该切片
    check('未知修订详情 404', (await jget(`/api/images/${imgId}/revisions/nope`)).status === 404);
    const up2 = await upload(png);
    const img2 = up2.body.id;
    check('跨切片读取修订 404', (await jget(`/api/images/${img2}/revisions/${calibRev.id}`)).status === 404);
    check('未知图片时间线 404', (await jget('/api/images/nope/revisions')).status === 404);

    // 恢复缺版本号 → 400
    r = await jsend('POST', `/api/images/${imgId}/revisions/${calibRev.id}/restore`, {});
    check('恢复缺 version → 400', r.status === 400, r.body);
    // 恢复版本过期 → 409 且返回当前版本，不写入
    const beforeRestore = (await jget(`/api/images/${imgId}/revisions`)).body.revisions.length;
    r = await jsend('POST', `/api/images/${imgId}/revisions/${calibRev.id}/restore`, { version: 1 });
    check('恢复版本过期 → 409', r.status === 409 && r.body.currentVersion === 4, r.body);
    const afterStale = (await jget(`/api/images/${imgId}/revisions`)).body.revisions.length;
    check('过期恢复不写入', beforeRestore === afterStale && afterStale === 4, { beforeRestore, afterStale });
    // 恢复跨切片修订 → 404
    r = await jsend('POST', `/api/images/${img2}/revisions/${calibRev.id}/restore`, { version: 1 });
    check('跨切片恢复 → 404', r.status === 404, r.body);
    // 恢复不存在修订 → 404
    r = await jsend('POST', `/api/images/${imgId}/revisions/nope/restore`, { version: 4 });
    check('恢复不存在修订 → 404', r.status === 404, r.body);

    // 先发布一份报告（v4 内容），验证恢复后报告与更正链不受影响
    let pub = await jsend('POST', `/api/images/${imgId}/publish`, { version: 4, title: '恢复前报告' });
    check('恢复前发布 201', pub.status === 201, pub.body && pub.body.error);
    const reportBefore = pub.body.report;
    // 发布推进版本到 5，但不产生修订（仍 4 条）
    check('发布不产生修订', (await jget(`/api/images/${imgId}/revisions`)).body.revisions.length === 4);

    // 合法恢复：把 v2 定标修订（无细胞无视野）恢复为当前草稿，需携带当前版本 5
    r = await jsend('POST', `/api/images/${imgId}/revisions/${calibRev.id}/restore`, { version: 5 });
    check('恢复 201', r.status === 201, r.body && r.body.error);
    check('恢复生成新版本 v6', r.body.image.version === 6, r.body.image);
    check('恢复后草稿=快照：无细胞无视野',
      r.body.image.cells.length === 0 && r.body.image.fields.length === 0, r.body.image);
    check('恢复生成 restore 修订且指向来源 #2',
      r.body.revision.type === 'restore' && r.body.revision.seq === 5 &&
      r.body.revision.restoredFromSeq === 2 && r.body.revision.restoredFromId === calibRev.id, r.body.revision);
    check('恢复返回来源信息', r.body.restoredFrom.id === calibRev.id && r.body.restoredFrom.seq === 2);

    // 后来历史不抹掉：时间线 5 条，原 fields/contours 修订仍在
    tl = (await jget(`/api/images/${imgId}/revisions`)).body;
    check('恢复后 5 条修订且历史完整',
      tl.revisions.length === 5 &&
      tl.revisions.some((x) => x.type === 'fields') &&
      tl.revisions.some((x) => x.type === 'contours'),
      tl.revisions.map((x) => x.seq + ':' + x.type));
    check('新 restore 修订在最前', tl.revisions[0].type === 'restore' && tl.revisions[0].draftVersion === 6);

    // 已发布报告不受恢复影响：冻结内容仍是 v4 的 cell-1 / 10000
    const repStill = (await jget(`/api/reports/${reportBefore.id}`)).body;
    check('已发布报告冻结内容不变',
      repStill.cells.length === 1 && repStill.cells[0].id === 'cell-1' &&
      repStill.cells[0].areaUm2 === 10000 && repStill.fields.length === 1, repStill);

    // 按恢复的标尺重算：当前是 scale=1；重定标为 scale=2，再恢复“轮廓修订 v3”，
    // 其细胞面积应按恢复快照所带标尺（scale=1）重算为 10000，而非 40000。
    // 先加回细胞（基于当前 scale=1 的空草稿）：保存轮廓 → v7
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 6, cells: [{ id: 'cell-1', name: '细胞1', ...square(10, 10, 100) }]
    });
    check('重新加回轮廓 200', r.status === 200, r.body && r.body.error); // v7, area 10000
    // 重定标 scale=2（50px=100μm）→ v8，面积变 40000
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 7, p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 }, distanceUm: 100
    });
    check('重定标 scale=2', r.status === 200 && r.body.calib.scale === 2, r.body);
    check('重定标后面积按新比例 40000', r.body.cells[0].areaUm2 === 40000, r.body.cells[0]);
    // 找到“scale=1、含 1 细胞、0 视野”的旧轮廓修订（seq 3）并恢复
    const contoursStill = (await jget(`/api/images/${imgId}/revisions`)).body.revisions
      .find((x) => x.type === 'contours' && x.draftVersion === 3);
    r = await jsend('POST', `/api/images/${imgId}/revisions/${contoursStill.id}/restore`, { version: 8 });
    check('恢复旧轮廓修订 201', r.status === 201, r.body && r.body.error);
    check('恢复后标尺回到 scale=1', r.body.image.calib.scale === 1, r.body.image.calib);
    check('恢复后测量按恢复标尺重算为 10000',
      r.body.image.cells[0].areaUm2 === 10000, r.body.image.cells[0]);
    check('恢复后视野回到该快照（0 个）', r.body.image.fields.length === 0, r.body.image.fields);
    check('恢复再次追加 restore 修订（不抹历史）',
      r.body.revision.type === 'restore' && r.body.revision.restoredFromSeq === 3, r.body.revision);

    // 视野统计按恢复标尺/快照重算：恢复一条带视野的修订（seq 4，scale=1、1 细胞 1 视野）
    const fieldsRev = (await jget(`/api/images/${imgId}/revisions`)).body.revisions
      .find((x) => x.type === 'fields' && x.draftVersion === 4);
    const curVer = (await jget(`/api/images/${imgId}`)).body.version; // 9
    r = await jsend('POST', `/api/images/${imgId}/revisions/${fieldsRev.id}/restore`, { version: curVer });
    check('恢复视野修订 201', r.status === 201, r.body && r.body.error);
    check('恢复后视野统计随快照重算（计数 1）',
      r.body.image.fieldStats.length === 1 && r.body.image.fieldStats[0].cellCount === 1,
      r.body.image.fieldStats);

    // 迁移成功也留修订：给 img2 定标+细胞并发布作为来源，再迁移到 imgId
    await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    await jsend('PUT', `/api/images/${img2}/contours`, {
      version: 2, cells: [{ id: 'z', name: 'z', ...square(10, 10, 40) }]
    });
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, { version: 3, title: '来源报告' });
    check('来源报告发布', pub2.status === 201, pub2.body);
    const imgNow = (await jget(`/api/images/${imgId}`)).body;
    const pv = await jsend('POST', `/api/images/${imgId}/migrate/preview`, {
      reportId: pub2.body.report.id,
      sourcePoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
      targetPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]
    });
    check('迁移预览通过', pv.status === 200 && pv.body.ok, pv.body);
    const mig = await jsend('POST', `/api/images/${imgId}/migrate`, {
      version: imgNow.version, reportId: pub2.body.report.id,
      sourcePoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
      targetPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]
    });
    check('确认迁移 201', mig.status === 201, mig.body && mig.body.error);
    const lastRev = (await jget(`/api/images/${imgId}/revisions`)).body.revisions[0];
    check('迁移成功留下 migration 修订',
      lastRev.type === 'migration' && lastRev.cellCount === 2 && /来源报告/.test(lastRev.note), lastRev);

    // 恢复基线（空草稿）也允许：携带当前版本，恢复成无标尺无细胞无视野
    const verBeforeBase = (await jget(`/api/images/${imgId}`)).body.version;
    r = await jsend('POST', `/api/images/${imgId}/revisions/${baseRev.id}/restore`, { version: verBeforeBase });
    check('恢复基线 201', r.status === 201, r.body && r.body.error);
    check('恢复基线后为空草稿',
      !r.body.image.calib && r.body.image.cells.length === 0 && r.body.image.fields.length === 0,
      { calib: !!r.body.image.calib, cells: r.body.image.cells.length });

  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  if (failures) { console.error(`\n${failures} 项失败 ✖`); process.exit(1); }
  console.log('\n草稿修订时间线端到端自测全部通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
