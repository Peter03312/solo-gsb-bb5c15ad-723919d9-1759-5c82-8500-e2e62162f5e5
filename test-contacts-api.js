'use strict';

// 细胞接触簇分析的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，
// 走 上传 → 定标 → 圈选（含孔洞）→ 发布 → 多阈值查询 → 错误语义 →
// 草稿修改/报告更正后旧报告结果不变 → 阈值不写回报告 全流程。
// 纯逻辑（距离语义/连通簇）见 test-clusters.js。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8232;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-contacts-'));

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

const sq = (x, y, w) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }
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

    // 定标：(0,0)-(100,0)=100μm → 1 px = 1 μm
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 200', r.status === 200, r.body && r.body.error);

    // 细胞布局（间距单位即 μm）：
    //   c1(10,10) —5→ c2(25,10) —5→ c3(40,10)；c4(200,200) 远离；
    //   c5 为环带（外 100,100 60×60，孔 120,120 20×20），c6(125,125,10) 在 c5 孔洞内、间隙 5
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2,
      cells: [
        { id: 'c1', name: 'c1', outer: sq(10, 10, 10), holes: [] },
        { id: 'c2', name: 'c2', outer: sq(25, 10, 10), holes: [] },
        { id: 'c3', name: 'c3', outer: sq(40, 10, 10), holes: [] },
        { id: 'c4', name: 'c4', outer: sq(200, 200, 20), holes: [] },
        { id: 'c5', name: 'c5', outer: sq(100, 100, 60), holes: [sq(120, 120, 20)] },
        { id: 'c6', name: 'c6', outer: sq(125, 125, 10), holes: [] }
      ]
    });
    check('保存轮廓 200', r.status === 200, r.body && r.body.error);

    r = await jsend('POST', `/api/images/${imgId}/publish`, { version: 3, title: '接触簇切片' });
    check('发布 201', r.status === 201, r.body && r.body.error);
    const rep = r.body.report;
    const contacts = (t) => jsend('POST', `/api/reports/${rep.id}/contacts`, { thresholdUm: t });

    // ---- 阈值 0：孔洞内 c6 不算接触，无任何邻接 → 6 个独立簇 ----
    r = await contacts(0);
    check('阈值 0 → 200', r.status === 200, r.body && r.body.error);
    check('阈值 0 无邻接对', r.body.pairCount === 0, r.body.pairs);
    check('阈值 0 各细胞独立簇', r.body.clusterCount === 6 && r.body.clusters.every((c) => c.size === 1));
    check('阈值 0 无多细胞簇', r.body.multiCellClusterCount === 0);
    check('响应回显阈值与定标', r.body.thresholdUm === 0 && r.body.scaleUmPerPx === 1);
    check('响应标识报告', r.body.scope === 'report' && r.body.reportId === rep.id);

    // ---- 阈值 5：c1-c2、c2-c3、c5-c6 邻接 → 簇 {c1,c2,c3}、{c5,c6}、{c4} ----
    r = await contacts(5);
    check('阈值 5 → 200', r.status === 200, r.body && r.body.error);
    check('阈值 5 三对邻接', r.body.pairCount === 3, r.body.pairs);
    const pairKeys = r.body.pairs.map((p) => [p.a, p.b].sort().join('~')).sort();
    check('邻接对为 c1c2/c2c3/c5c6', pairKeys.join() === ['c1~c2', 'c2~c3', 'c5~c6'].join(), pairKeys);
    check('邻接距离均为 5μm', r.body.pairs.every((p) => p.distanceUm === 5));
    check('阈值 5 三个簇', r.body.clusterCount === 3 && r.body.multiCellClusterCount === 2);
    const clusterSets = r.body.clusters.map((c) => c.cellKeys.slice().sort().join('~')).sort();
    check('簇成员正确', clusterSets.join() === ['c1~c2~c3', 'c4', 'c5~c6'].join(), clusterSets);
    const byKey = Object.fromEntries(r.body.cells.map((c) => [c.key, c]));
    check('c2 邻居为 c1/c3 且最短间距 5',
      byKey.c2.neighborCount === 2 && byKey.c2.shortestUm === 5 &&
      byKey.c2.neighbors.map((n) => n.key).join() === 'c1,c3', byKey.c2);
    check('c4 无邻居、最短间距 null', byKey.c4.neighborCount === 0 && byKey.c4.shortestUm === null);
    check('同簇细胞 clusterId 一致',
      byKey.c1.clusterId === byKey.c3.clusterId && byKey.c5.clusterId === byKey.c6.clusterId &&
      byKey.c1.clusterId !== byKey.c5.clusterId && byKey.c4.clusterId !== byKey.c1.clusterId);

    // ---- 阈值 4.9：小于间隙 5 → 无邻接 ----
    r = await contacts(4.9);
    check('阈值 4.9 无邻接', r.status === 200 && r.body.pairCount === 0 && r.body.clusterCount === 6);

    // ---- 阈值不写回报告：报告内容与发布时一致 ----
    const before = (await jget(`/api/reports/${rep.id}`)).body;
    check('报告无阈值字段', !('thresholdUm' in before) && !('contacts' in before));
    check('报告细胞未被改动', before.cells.map((c) => c.id).join() === 'c1,c2,c3,c4,c5,c6');

    // ---- 错误语义 ----
    r = await jsend('POST', `/api/reports/${rep.id}/contacts`, { thresholdUm: -1 });
    check('负阈值 → 400', r.status === 400 && /不能为负数/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/contacts`, { thresholdUm: 'abc' });
    check('非数值阈值 → 400', r.status === 400 && /必须是数值/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/reports/${rep.id}/contacts`, {});
    check('缺阈值 → 400', r.status === 400, r.body);
    // JSON.stringify(Infinity) 会得到 null，这里手工构造 1e999 让服务端解析出 Infinity
    {
      const res = await fetch(`${base}/api/reports/${rep.id}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"thresholdUm":1e999}'
      });
      const body = await res.json().catch(() => null);
      check('非有限阈值（Infinity）→ 400', res.status === 400 && /有限数值/.test(body && body.error), body);
    }
    r = await jsend('POST', '/api/reports/nope/contacts', { thresholdUm: 5 });
    check('报告不存在 → 404', r.status === 404 && /报告不存在/.test(r.body.error), r.body);

    // ---- 冻结性：修改草稿（移动细胞 + 重定标）后旧报告分析不变 ----
    const frozen = await contacts(5);
    let img = (await jget(`/api/images/${imgId}`)).body;
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: img.version,
      cells: [
        { id: 'n1', name: 'n1', outer: sq(10, 10, 10), holes: [] },
        { id: 'n2', name: 'n2', outer: sq(60, 10, 10), holes: [] } // 间距 40
      ]
    });
    check('草稿改轮廓 200', r.status === 200, r.body && r.body.error);
    img = r.body;
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: img.version, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 200 // 1px=2μm
    });
    check('草稿重定标 200', r.status === 200, r.body && r.body.error);
    const after = await contacts(5);
    check('草稿修改后旧报告阈值 5 结果不变',
      JSON.stringify(after.body.pairs) === JSON.stringify(frozen.body.pairs) &&
      JSON.stringify(after.body.clusters) === JSON.stringify(frozen.body.clusters) &&
      JSON.stringify(after.body.cells) === JSON.stringify(frozen.body.cells),
      { before: frozen.body.pairs, after: after.body.pairs });

    // ---- 更正：新报告反映新草稿，旧报告仍冻结 ----
    img = (await jget(`/api/images/${imgId}`)).body;
    r = await jsend('POST', `/api/reports/${rep.id}/correct`, {
      reason: '重画细胞', draftVersion: img.version, expectedTipId: rep.id
    });
    check('更正 201', r.status === 201, r.body && r.body.error);
    const rep2 = r.body.report;
    r = await jsend('POST', `/api/reports/${rep2.id}/contacts`, { thresholdUm: 5 });
    check('新报告按新轮廓/定标分析（间距 40px=80μm → 无邻接）',
      r.status === 200 && r.body.pairCount === 0 && r.body.clusterCount === 2, r.body);
    check('新报告定标为 2μm/px', r.body.scaleUmPerPx === 2);
    r = await jsend('POST', `/api/reports/${rep2.id}/contacts`, { thresholdUm: 80 });
    check('新报告阈值 80 → 一对邻接、一个簇',
      r.status === 200 && r.body.pairCount === 1 && r.body.clusterCount === 1 &&
      r.body.clusters[0].size === 2, r.body);
    const oldAgain = await contacts(5);
    check('更正后旧报告（历史）分析仍不变',
      oldAgain.status === 200 && oldAgain.body.pairCount === 3 &&
      JSON.stringify(oldAgain.body.clusters) === JSON.stringify(frozen.body.clusters));

  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  if (failures) { console.error(`\n${failures} 项失败 ✖`); process.exit(1); }
  console.log('\n接触簇分析端到端自测全部通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
