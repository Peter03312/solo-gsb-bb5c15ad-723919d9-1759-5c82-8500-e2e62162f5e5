'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { initDb } = require('./db');
const geo = require('./geometry');
const cmp = require('./compare');
const fieldsSvc = require('./fields');
const mergeSvc = require('./merge-stats');
const transfer = require('./transfer');
const corrections = require('./corrections');
const clustersSvc = require('./clusters');
const revisionsSvc = require('./revisions');
const coverageDiffSvc = require('./coverage-diff');
const fieldGridSvc = require('./field-grid');
const fieldZonesSvc = require('./field-zones');
const { renderAnnotatedPng } = require('./render');
const { buildReportCsv, buildCombinedCsv, buildComparisonCsv, buildFieldStatsCsv, streamZip } = require('./exporter');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = parseInt(process.env.PORT || '8080', 10);
const IMG_DIR = path.join(DATA_DIR, 'images');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');

const db = initDb(DATA_DIR);
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// 合并统计模块为服务端/页端共用的同一份几何实现（UMD），直接按脚本暴露给浏览器
app.get('/merge-stats.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'merge-stats.js'));
});

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

// ---------- helpers ----------

function getImageOr404(id) {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateImage(row);
}

function hydrateImage(row) {
  const calib = row.calib ? JSON.parse(row.calib) : null;
  const cells = JSON.parse(row.cells);
  const fields = JSON.parse(row.fields || '[]');
  return {
    id: row.id,
    filename: row.filename,
    width: row.width,
    height: row.height,
    version: row.version,
    calib,
    cells,
    fields,
    fieldStats: fieldsSvc.buildFieldStats(fields, cells, calib ? calib.scale : null),
    published: !!row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateReport(row) {
  const calib = JSON.parse(row.calib);
  const cells = JSON.parse(row.cells);
  const fields = JSON.parse(row.fields || '[]'); // 旧报告无视野列：按空列表读取
  return {
    id: row.id,
    imageId: row.image_id,
    draftVersion: row.draft_version,
    title: row.title,
    filename: row.filename,
    width: row.width,
    height: row.height,
    calib,
    cells,
    fields,
    fieldStats: fieldsSvc.buildFieldStats(fields, cells, calib ? calib.scale : null),
    correctsReportId: row.corrects_report_id || null, // 更正链：前一份报告（普通发布为 null）
    correctionReason: row.correction_reason || null,   // 本次更正原因（普通发布为 null）
    createdAt: row.created_at
  };
}

// 为报告附上更正链位置标记（chainId=链根 id；isChainTip 是否当前有效报告）。
// rows 为同一批水合报告时只需构建一次索引：传入可选 index 复用。
function attachChainFlags(report, index) {
  if (!report) return report;
  const idx = index || corrections.buildChainIndex([report]);
  const chain = idx.chains.find((c) => c.members.some((m) => m.id === report.id));
  report.chainId = chain ? chain.rootId : report.id;
  report.isChainTip = chain ? report.id === chain.tipId : true;
  return report;
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// 校验客户端携带的草稿版本；过期返回 null（调用方回 409）
function checkVersion(img, version) {
  return Number.isInteger(version) && version === img.version;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
function roundPoint(p) { return { x: round3(p.x), y: round3(p.y) }; }

// 重算整份草稿中所有细胞的测量值（未定标时结果为 null）
function recompute(cells, calib) {
  const scale = calib ? calib.scale : null;
  return cells.map((c) => {
    if (scale === null) {
      return { ...c, areaUm2: null, perimeterUm: null };
    }
    const m = geo.measureCell(c.outer, c.holes, scale);
    return { ...c, areaUm2: m.areaUm2, perimeterUm: m.perimeterUm };
  });
}

// 一次成功的草稿写入：同一事务内更新 images（推进版本）并追加一条完整快照修订，
// 保证「写入成功即留下完整一致的修订」。失败在进入本函数之前已被校验拦截，不留任何记录。
// patch 为待覆盖的列（calib/cells/fields 中给出哪些就写哪些，其余沿用 current）。
// 返回水合后的最新草稿。
function commitDraft(current, patch, type, meta = {}) {
  const nextCalib = Object.prototype.hasOwnProperty.call(patch, 'calib') ? patch.calib : current.calib;
  const nextCells = Object.prototype.hasOwnProperty.call(patch, 'cells') ? patch.cells : current.cells;
  const nextFields = Object.prototype.hasOwnProperty.call(patch, 'fields') ? patch.fields : current.fields;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE images SET calib = ?, cells = ?, fields = ?, version = version + 1,
                updated_at = datetime('now') WHERE id = ?`)
      .run(nextCalib ? JSON.stringify(nextCalib) : null,
           JSON.stringify(nextCells), JSON.stringify(nextFields), current.id);
    const row = db.prepare('SELECT version FROM images WHERE id = ?').get(current.id);
    revisionsSvc.appendRevision(db, current.id, type, {
      width: current.width,
      height: current.height,
      calib: nextCalib,
      cells: nextCells,
      fields: nextFields
    }, row.version, meta);
  });
  tx();
  return getImageOr404(current.id);
}

// ---------- 图片 ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: IMG_DIR,
    filename: (_req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype];
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('仅支持 PNG / JPEG / WebP 格式的图片'));
    }
    cb(null, true);
  }
});

app.get('/api/images', (_req, res) => {
  const rows = db.prepare('SELECT * FROM images ORDER BY created_at DESC').all();
  res.json(rows.map(hydrateImage));
});

app.post('/api/images', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return badRequest(res, err.message);
    if (!req.file) return badRequest(res, '缺少上传文件（字段名须为 image）');
    const filePath = path.join(IMG_DIR, req.file.filename);
    let meta;
    try {
      meta = await sharp(filePath).metadata();
    } catch {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '图片文件已损坏或格式无法识别');
    }
    if (!meta.width || !meta.height) {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '无法读取图片尺寸');
    }
    const id = crypto.randomUUID();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO images (id, filename, stored_name, mime, width, height)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, req.file.originalname, req.file.filename, req.file.mimetype, meta.width, meta.height);
      // 空状态基线修订：新切片的第一条可恢复记录
      revisionsSvc.appendRevision(db, id, 'baseline', {
        width: meta.width, height: meta.height, calib: null, cells: [], fields: []
      }, 1, { note: '上传切片：空草稿基线' });
    });
    tx();
    res.status(201).json(getImageOr404(id));
  });
});

app.get('/api/images/:id', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  res.json(img);
});

app.get('/api/images/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '图片不存在' });
  res.sendFile(path.join(IMG_DIR, row.stored_name));
});

// ---------- 定标 ----------

app.put('/api/images/:id/calibration', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const { p1, p2, distanceUm } = req.body || {};
  const numErr = (m) => badRequest(res, m);
  if (!p1 || !p2 || typeof p1.x !== 'number' || typeof p1.y !== 'number' ||
      typeof p2.x !== 'number' || typeof p2.y !== 'number' ||
      !Number.isFinite(p1.x) || !Number.isFinite(p1.y) ||
      !Number.isFinite(p2.x) || !Number.isFinite(p2.y)) {
    return numErr('标尺无效：必须在原图上选择两个像素点 p1、p2（坐标 {x, y}）');
  }
  if (p1.x < 0 || p1.y < 0 || p2.x < 0 || p2.y < 0 ||
      p1.x > img.width || p1.y > img.height || p2.x > img.width || p2.y > img.height) {
    return numErr(`标尺无效：定标点越出图片范围（图片尺寸 ${img.width}×${img.height} 像素）`);
  }
  const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (pxDist < 1) {
    return numErr('标尺无效：两个定标点必须是不同的像素点（间距至少 1 像素）');
  }
  const dist = Number(distanceUm);
  if (!Number.isFinite(dist) || dist <= 0) {
    return numErr('标尺无效：实际距离必须是大于 0 的数值（微米）');
  }

  const calib = {
    p1: roundPoint(p1), p2: roundPoint(p2),
    distanceUm: dist,
    scale: dist / pxDist // μm / px
  };

  // 重新定标：草稿中的全部测量按新比例重算；同一事务留下定标修订
  const cells = recompute(img.cells, calib);

  const updated = commitDraft(img, { calib, cells }, 'calibration',
    { note: `${dist} μm / ${pxDist.toFixed(2)} px = 1 px ${(dist / pxDist).toFixed(6)} μm` });
  res.json(updated);
});

// ---------- 轮廓（整批替换，任一对象非法则整次修改不生效） ----------

app.put('/api/images/:id/contours', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const rawCells = req.body.cells;
  if (!Array.isArray(rawCells)) return badRequest(res, '轮廓数据无效：cells 必须是数组');

  let next;
  try {
    // 先全部校验，任何一个细胞/孔洞失败都会抛出，数据库不发生任何写入
    next = rawCells.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`第 ${i + 1} 个细胞数据格式错误`);
      const { outer, holes } = geo.validateCell({ ...c, _seq: i + 1 }, img.width, img.height);
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, 50) : '';
      return {
        id: typeof c.id === 'string' && c.id ? c.id : crypto.randomUUID(),
        name,
        outer: outer.map(roundPoint),
        holes: holes.map((h) => h.map(roundPoint))
      };
    });
  } catch (e) {
    return badRequest(res, e.message);
  }

  next = recompute(next, img.calib);

  const updated = commitDraft(img, { cells: next }, 'contours',
    { note: `${next.length} 个细胞轮廓整批保存` });
  res.json(updated);
});

// ---------- 细胞迁移（已发布报告 → 另一张图片草稿，三点对应仿射变换） ----------
// 预览与确认提交共用 transfer.buildMigration：同一变换、同一几何校验；
// 任一失败整批不写入，目标原有细胞/标尺/视野、来源报告与已发布报告均不改变。

// 解析迁移请求：来源报告 + 两侧对应点 → 迁移计划；失败抛出 {status, message}
function resolveMigration(img, body) {
  const reportId = body && body.reportId;
  if (typeof reportId !== 'string' || !reportId) {
    throw { status: 400, message: '请选择作为迁移来源的已发布报告（reportId）' };
  }
  const report = getReportOr404(reportId);
  if (!report) throw { status: 404, message: `来源报告不存在（id ${reportId}），请重新选择已发布报告` };

  const plan = transfer.buildMigration(report, img, body && body.sourcePoints, body && body.targetPoints);
  return { report, plan };
}

function migrationPayload(img, report, plan) {
  return {
    target: { id: img.id, version: img.version, width: img.width, height: img.height },
    source: {
      reportId: report.id, title: report.title,
      width: report.width, height: report.height, cellCount: report.cells.length
    },
    transform: plan.transform,
    sourcePoints: plan.sourcePoints,
    targetPoints: plan.targetPoints,
    ok: plan.ok,
    okCount: plan.okCount,
    failCount: plan.failCount,
    cells: plan.cells.map((c) => ({
      key: c.key, name: c.name, seq: c.seq, label: c.label,
      ok: c.ok, error: c.error, outer: c.outer, holes: c.holes,
      // 按目标标尺预算测量值（未定标为 null），与确认迁移后的结果一致
      areaUm2: img.calib ? geo.measureCell(c.outer, c.holes, img.calib.scale).areaUm2 : null,
      perimeterUm: img.calib ? geo.measureCell(c.outer, c.holes, img.calib.scale).perimeterUm : null
    }))
  };
}

app.post('/api/images/:id/migrate/preview', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '目标图片草稿不存在，请刷新后重新选择目标' });
  let ctx;
  try {
    ctx = resolveMigration(img, req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  res.json(migrationPayload(img, ctx.report, ctx.plan));
});

app.post('/api/images/:id/migrate', (req, res) => {
  const body = req.body || {};
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '目标图片草稿不存在，请刷新后重新选择目标' });
  // 必须携带预览时读取的目标草稿版本；过期拒绝写入并提示刷新
  if (!checkVersion(img, body.version)) {
    return res.status(409).json({
      error: `目标草稿已过期：你携带的版本为 ${body.version}，当前版本为 ${img.version}，请刷新后重新预览再迁移`,
      currentVersion: img.version
    });
  }

  let ctx;
  try {
    ctx = resolveMigration(img, body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  const { report, plan } = ctx;

  if (!plan.ok) {
    const first = plan.cells.find((c) => !c.ok);
    return badRequest(res,
      `迁移被拒绝：${plan.failCount} 个细胞映射到目标后不满足几何规则（${first.error}），整批未写入`);
  }

  // 追加到目标现有细胞之后：生成不与现有标识冲突的新 id，保留来源名称
  const usedIds = new Set(img.cells.map((c) => c.id).filter(Boolean));
  const appended = plan.cells.map((c) => {
    let id = crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    usedIds.add(id);
    return { id, name: c.name, outer: c.outer, holes: c.holes };
  });
  // 按目标标尺重算追加细胞的测量值；目标原有细胞与标尺原样保留
  const next = img.cells.concat(recompute(appended, img.calib));

  const updated = commitDraft(img, { cells: next }, 'migration', {
    note: `从报告《${report.title}》迁移 ${appended.length} 个细胞（追加）`
  });

  res.status(201).json({
    image: updated,
    appendedCount: appended.length,
    appended: appended.map((c, i) => ({ id: c.id, name: c.name, seq: plan.cells[i].seq })),
    source: { reportId: report.id, title: report.title },
    transform: plan.transform
  });
});

// ---------- 取样视野（整批替换，任一视野非法则整次修改不生效） ----------

const MAX_FIELDS = 200;

app.put('/api/images/:id/fields', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const rawFields = req.body.fields;
  if (!Array.isArray(rawFields)) return badRequest(res, '视野数据无效：fields 必须是数组');
  if (rawFields.length > MAX_FIELDS) return badRequest(res, `视野数据无效：单张图片最多 ${MAX_FIELDS} 个视野`);

  let next;
  try {
    // 先全部校验：越界/自交/孔洞不严格在内或互相接触重叠/净面积非正都会抛出，数据库不写入
    next = rawFields.map((f, i) => {
      if (!f || typeof f !== 'object') throw new Error(`第 ${i + 1} 个视野数据格式错误`);
      const { outer, holes } = geo.validateField(f, img.width, img.height, i + 1);
      const name = typeof f.name === 'string' ? f.name.trim().slice(0, 50) : '';
      return {
        id: typeof f.id === 'string' && f.id ? f.id : crypto.randomUUID(),
        name,
        outer: outer.map(roundPoint),
        holes: holes.map((h) => h.map(roundPoint))
      };
    });
  } catch (e) {
    return badRequest(res, e.message);
  }

  // 身份校验：本批视野 id 必须唯一。两个不同视野共用同一 id 时，按 id 取视野的各分析
  // 会分别取到不同的一个（合并统计取后一个、覆盖核对/网格密度/责任区取第一个），
  // 使同一标识的结果互相矛盾。冲突时指出具体位置（第几个、名称）并整批拒绝，
  // 不写入、不推进版本、不留修订。
  if (mergeSvc.duplicateFieldIds(next).length) {
    return badRequest(res, mergeSvc.duplicateFieldIdsSaveError(next));
  }

  const updated = commitDraft(img, { fields: next }, 'fields',
    { note: `${next.length} 个取样视野整批保存` });
  res.json(updated);
});

// ---------- 多视野合并统计（只读；按当前草稿实时计算） ----------
//
// 请求体：{ fieldIds: string[] }。至少 2 个、同一草稿内、不重复、必须存在。
// 不修改任何草稿/报告数据；细胞轮廓、视野或标尺改变后按当前数据重算。
app.post('/api/images/:id/field-merge', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  const body = req.body || {};
  let selected;
  try {
    selected = mergeSvc.resolveMergeSelection(img.fields, body.fieldIds);
  } catch (e) {
    return badRequest(res, e.message);
  }
  const stats = mergeSvc.buildMergeStats(selected, img.cells, img.calib ? img.calib.scale : null);
  res.json({
    scope: 'draft',
    imageId: img.id,
    version: img.version, // 返回计算时的草稿版本，便于调用方识别是否已是最新数据
    calibrated: !!img.calib,
    stats
  });
});

// ---------- 单视野细胞覆盖核对（只读；按当前草稿实时计算） ----------
//
// 请求体：{ fieldId: string }，视野 id 或名称均可。
// 覆盖面积 = 细胞净区域与视野净区域的几何交集面积（跨边界细胞只计内部部分、
// 多细胞重叠只计一次、孔洞与仅边界接触不贡献），不沿用按质心计数的密度规则。
// 查询不修改草稿、修订与报告；未定标时像素面积与覆盖率照常给出，物理面积为“待定标”。
app.post('/api/images/:id/field-coverage', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  const body = req.body || {};
  let resolved;
  try {
    resolved = mergeSvc.resolveFieldIdentifier(img.fields, body.fieldId);
  } catch (e) {
    return badRequest(res, e.message);
  }
  const coverage = mergeSvc.buildFieldCoverage(
    resolved.field, img.cells, img.calib ? img.calib.scale : null);
  res.json({
    scope: 'draft',
    imageId: img.id,
    version: img.version, // 返回计算时的草稿版本，便于调用方识别是否已是最新数据
    calibrated: !!img.calib,
    matchedBy: resolved.matchBy,
    coverage
  });
});

// ---------- 草稿修订时间线（只追加）与恢复 ----------
//
// 每次成功写入（定标/轮廓/视野/迁移/恢复）都已在同一事务留下完整快照修订；
// 下列接口只读时间线与快照、或以乐观并发恢复。恢复会【追加】一条 restore 修订，
// 后来的历史一条都不抹掉；已发布报告与更正链完全不受影响。

app.get('/api/images/:id/revisions', (req, res) => {
  if (!getImageOr404(req.params.id)) return res.status(404).json({ error: '图片不存在' });
  res.json({
    imageId: req.params.id,
    currentVersion: db.prepare('SELECT version FROM images WHERE id = ?').get(req.params.id).version,
    revisions: revisionsSvc.listRevisions(db, req.params.id)
  });
});

app.get('/api/images/:id/revisions/:revId', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  // 修订不存在或不属于该切片：同样明确拒绝，不泄露其它切片修订的存在
  const rev = revisionsSvc.getOwnedRevision(db, req.params.id, req.params.revId, true);
  if (!rev) return res.status(404).json({ error: '修订不存在，或不属于该切片' });
  // 按该修订自己的标尺重算测量与视野统计：预览即为恢复后所见的一致结果
  rev.fieldStats = fieldsSvc.buildFieldStats(rev.fields, rev.cells, rev.calib ? rev.calib.scale : null);
  rev.isCurrent = img.version === rev.draftVersion;
  res.json(rev);
});

// 恢复：请求体 {version} 必须是【读取时间线/快照时】的当前草稿版本。
app.post('/api/images/:id/revisions/:revId/restore', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  // 先判定目标修订（不存在/不属于切片 → 404），再做并发判定；任何失败都不写入
  const target = revisionsSvc.getOwnedRevision(db, req.params.id, req.params.revId, true);
  if (!target) return res.status(404).json({ error: '修订不存在，或不属于该切片，无法恢复' });

  const version = req.body && req.body.version;
  if (!Number.isInteger(version)) {
    return badRequest(res, '恢复必须携带读取时的草稿版本号 version（整数）');
  }
  if (version !== img.version) {
    return res.status(409).json({
      error: `草稿已过期：你携带的版本为 v${version}，当前版本为 v${img.version}，请重新读取时间线后再恢复`,
      currentVersion: img.version
    });
  }

  // 按恢复的标尺重算测量值（与「重新定标」同一套重算）；视野统计在水合时按新数据给出
  const cells = recompute(target.cells, target.calib);
  const updated = commitDraft(img,
    { calib: target.calib, cells, fields: target.fields },
    'restore',
    {
      restoredFromId: target.id,
      restoredFromSeq: target.seq,
      note: `恢复自第 ${target.seq} 条修订（${target.typeLabel}${target.note ? `：${target.note}` : ''}）`
    });

  const created = db.prepare('SELECT * FROM draft_revisions WHERE image_id = ? ORDER BY seq DESC LIMIT 1')
    .get(img.id);
  res.status(201).json({
    image: updated,
    revision: revisionsSvc.hydrateRevision(created, { withGeometry: false }),
    restoredFrom: { id: target.id, seq: target.seq, type: target.type, typeLabel: target.typeLabel }
  });
});

// ---------- 发布（乐观并发：携带读取时草稿版本） ----------

// 固化一份报告：复制图片快照 + 事务内插入报告、推进草稿版本。
// correctsReportId/correctionReason 仅更正发布时给出；失败时清理已复制的快照，
// 不留下报告记录或图片文件。
function freezeReport({ img, title, correctsReportId = null, correctionReason = null }) {
  const reportId = crypto.randomUUID();
  const srcRow = db.prepare('SELECT stored_name FROM images WHERE id = ?').get(img.id);
  const snapExt = path.extname(srcRow.stored_name);
  const snapName = `${reportId}${snapExt}`;
  // 先固化图片快照：报告永远保留发布当时的图片文件
  fs.copyFileSync(path.join(IMG_DIR, srcRow.stored_name), path.join(SNAP_DIR, snapName));

  try {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO reports
                  (id, image_id, draft_version, title, filename, snapshot_name,
                   width, height, calib, cells, fields, corrects_report_id, correction_reason)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(reportId, img.id, img.version, title, img.filename, snapName,
             img.width, img.height, JSON.stringify(img.calib), JSON.stringify(img.cells),
             JSON.stringify(img.fields || []), correctsReportId, correctionReason);
      db.prepare(`UPDATE images SET published = 1, version = version + 1,
                  updated_at = datetime('now') WHERE id = ?`).run(img.id);
    });
    tx();
  } catch (e) {
    fs.rmSync(path.join(SNAP_DIR, snapName), { force: true });
    throw e;
  }
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
}

app.post('/api/images/:id/publish', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `发布被拒绝：草稿已过期（携带版本 ${req.body.version}，当前版本 ${img.version}）。请重新读取最新草稿后再发布`, currentVersion: img.version });
  }
  if (!img.calib) return badRequest(res, '尚不能发布：请先完成标尺定标');
  if (img.cells.length === 0) return badRequest(res, '尚不能发布：请至少圈出一个细胞外轮廓');
  for (const c of img.cells) {
    if (typeof c.areaUm2 !== 'number') return badRequest(res, '尚不能发布：存在未按当前标尺计算测量值的轮廓，请重新保存轮廓');
  }
  // 身份歧义防护：修复前遗留的重复 id 草稿不得再冻结为新报告（只读分析会互相矛盾）。
  // 既有已发布报告保持冻结不变；请在编辑页修正当前草稿（重新保存视野，追加正常修订）后再发布。
  if (mergeSvc.duplicateFieldIds(img.fields).length) {
    return badRequest(res, `尚不能发布：${mergeSvc.describeDuplicateFieldIds(img.fields)}。` +
      '同一批视野 id 必须唯一，请在编辑页修正冲突视野并重新保存视野（成功后追加正常修订）后再发布；' +
      '既有已发布报告保持冻结，不会被改写');
  }

  const title = (typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : `${img.filename.replace(/\.[^.]+$/, '')} 报告 ${new Date().toISOString().slice(0, 10)}`;

  const row = freezeReport({ img, title });

  res.status(201).json({
    report: attachChainFlags(hydrateReport(row)),
    image: getImageOr404(img.id)
  });
});

// ---------- 报告 ----------

app.get('/api/reports', (_req, res) => {
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  const reports = rows.map(hydrateReport);
  // 列表同时给出每条更正链的位置标记（isChainTip=false 即已被后续更正取代）
  const index = corrections.buildChainIndex(reports);
  reports.forEach((r) => attachChainFlags(r, index));
  res.json(reports);
});

function getReportOr404(id) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return row ? hydrateReport(row) : null;
}

app.get('/api/reports/:id', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const index = corrections.buildChainIndex(
    db.prepare('SELECT * FROM reports').all().map(hydrateReport));
  res.json(attachChainFlags(report, index));
});

// ---------- 更正链列表 / 追溯（只读） ----------
//
// 每条链以链根（最早一份普通发布）标识，链末端即当前有效报告；历史报告按原标识保留。
function allReportChains() {
  const reports = db.prepare('SELECT * FROM reports').all().map(hydrateReport);
  const idx = corrections.buildChainIndex(reports);
  // 列表按链末端发布时间倒序（同秒时用链根 id 兜底，保证顺序稳定）
  return idx.chains
    .map(corrections.summarizeChain)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1
      : a.rootId < b.rootId ? 1 : a.rootId > b.rootId ? -1 : 0));
}

app.get('/api/report-chains', (_req, res) => {
  res.json({ chains: allReportChains() });
});

app.get('/api/reports/:id/trace', (req, res) => {
  const reports = db.prepare('SELECT * FROM reports').all().map(hydrateReport);
  const view = corrections.traceChain(reports, req.params.id);
  if (!view) return res.status(404).json({ error: '报告不存在，无法追溯更正链' });
  res.json(view);
});

// ---------- 发起更正（链末端 + 当前草稿 + 现有发布校验；乐观并发） ----------
//
// 请求体：{ reason, draftVersion, expectedTipId, title? }
// 仅当所选报告仍为链末端、草稿版本未变且草稿通过既有发布校验时，
// 才复制新快照并生成新的不可变报告，记录 correctsReportId 与更正原因；
// 任何失败都不留下报告记录或快照文件。
app.post('/api/reports/:id/correct', (req, res) => {
  const target = getReportOr404(req.params.id);
  if (!target) return res.status(404).json({ error: '被更正的报告不存在' });

  const img = getImageOr404(target.imageId);
  let parsed;
  try {
    parsed = corrections.validateCorrectionRequest(target, img, req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  // 计算当前链末端，进行版本/链末端乐观冲突判定
  const reports = db.prepare('SELECT * FROM reports').all().map(hydrateReport);
  const trace = corrections.traceChain(reports, target.id);
  const currentTipId = trace ? trace.tipId : target.id;
  const conflict = corrections.detectConflict({
    img,
    draftVersion: parsed.draftVersion,
    target,
    expectedTipId: parsed.expectedTipId,
    currentTipId
  });
  if (conflict) {
    // 拒绝并返回最新信息：当前草稿版本、链末端、当前草稿
    return res.status(409).json({
      error: conflict.message,
      currentVersion: img.version,
      currentTipId,
      tip: corrections.summarizeReport(
        reports.find((r) => r.id === currentTipId) || target),
      image: getImageOr404(img.id)
    });
  }

  // 乐观校验通过后再套用既有发布校验（定标/细胞/测量值）
  try {
    corrections.assertPublishable(img);
  } catch (e) {
    return badRequest(res, e.message);
  }

  // 标题：显式给出则使用；否则沿用被更正报告标题（原因单独记录在 correctionReason）
  const title = (typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : target.title;

  const row = freezeReport({
    img,
    title,
    correctsReportId: target.id,
    correctionReason: parsed.reason
  });
  const newReport = hydrateReport(row);
  const newReports = db.prepare('SELECT * FROM reports').all().map(hydrateReport);
  const newTrace = corrections.traceChain(newReports, newReport.id);

  res.status(201).json({
    report: attachChainFlags(newReport, corrections.buildChainIndex(newReports)),
    image: getImageOr404(img.id),
    correctedReportId: target.id,
    reason: parsed.reason,
    trace: newTrace
  });
});


// ---------- 报告内多视野合并统计（只读；只使用发布时冻结数据） ----------
//
// 请求体：{ fieldIds: string[] }。标识必须来自该报告发布时冻结的 fields。
// 草稿后续的轮廓/视野/标尺改动不影响本接口结果。
app.post('/api/reports/:id/field-merge', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const body = req.body || {};
  let selected;
  try {
    selected = mergeSvc.resolveMergeSelection(report.fields, body.fieldIds);
  } catch (e) {
    return badRequest(res, e.message);
  }
  const stats = mergeSvc.buildMergeStats(selected, report.cells, report.calib ? report.calib.scale : null);
  res.json({
    scope: 'report',
    reportId: report.id,
    draftVersion: report.draftVersion,
    calibrated: !!report.calib,
    stats
  });
});

// ---------- 报告内单视野细胞覆盖核对（只读；只使用发布时冻结数据） ----------
//
// 请求体：{ fieldId: string }，视野 id 或名称均可，且必须来自该报告冻结的 fields。
// 只取发布时冻结的轮廓/视野/标尺：后续草稿修改或报告更正不改变旧报告结果。
// 视野标识不存在或不属于该报告 → 400；报告不存在 → 404；查询不写回报告。
app.post('/api/reports/:id/field-coverage', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const body = req.body || {};
  let resolved;
  try {
    resolved = mergeSvc.resolveFieldIdentifier(report.fields, body.fieldId);
  } catch (e) {
    return badRequest(res, e.message);
  }
  const coverage = mergeSvc.buildFieldCoverage(
    resolved.field, report.cells, report.calib ? report.calib.scale : null);
  res.json({
    scope: 'report',
    reportId: report.id,
    title: report.title,
    draftVersion: report.draftVersion,
    calibrated: !!report.calib,
    matchedBy: resolved.matchBy,
    coverage
  });
});

// ---------- 报告单视野网格密度分析（只读；只使用发布时冻结数据） ----------
//
// 请求体：{ fieldId, rows, cols }。fieldId 为视野 id 或名称（必须来自该报告冻结的 fields），
// rows/cols 各为 1～40 的整数。把视野外接矩形等分为网格：每格有效面积为格子与视野净区域
// （扣除孔洞）的几何交集，零面积格保留且密度标为「不可计算」；计入该视野的细胞按现有
// 净区域质心归属规则分配到唯一格子（内部网格线归右/下侧，最外边线归末格），
// 各格计数合计等于原视野统计。只取发布时冻结的视野/细胞/标尺：
// 后续草稿修改或报告更正不改变旧报告结果；查询不写回任何数据。
app.post('/api/reports/:id/field-grid', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const body = req.body || {};

  let rows, cols;
  try {
    rows = fieldGridSvc.validateGridDimension(body.rows, 'rows（行数）');
    cols = fieldGridSvc.validateGridDimension(body.cols, 'cols（列数）');
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  let resolved;
  try {
    resolved = fieldGridSvc.resolveGridField(report.fields, body.fieldId);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  let grid;
  try {
    grid = fieldGridSvc.buildFieldGrid(
      resolved.field, resolved.index, report.cells,
      report.calib ? report.calib.scale : null, rows, cols);
  } catch (e) {
    return res.status(500).json({ error: `网格密度分析失败：${e.message}` });
  }

  res.json({
    scope: 'report',
    reportId: report.id,
    title: report.title,
    draftVersion: report.draftVersion,
    calibrated: !!report.calib,
    scaleUmPerPx: report.calib ? report.calib.scale : null,
    matchedBy: resolved.matchBy,
    snapshotUrl: `/api/reports/${report.id}/file`,
    grid
  });
});

// ---------- 报告单视野「最近质心责任区」分析（只读；只使用发布时冻结数据） ----------
//
// 请求体：{ fieldId }，视野 id 或名称（必须来自该报告冻结的 fields），id 优先精确匹配。
// 把视野净区域（外环扣除孔洞）按像素欧氏距离分给最近的计入细胞（沿用净区域质心与
// 视野严格归属规则）；视野孔洞及外部不分配；等距边界不计面积；质心重合按报告细胞
// 顺序由首个占有，其余保留零面积记录。返回每个细胞的实际分区几何、像素/mm² 面积与
// 占比（有计入细胞时各区合计＝视野净面积）；无计入细胞时返回空结果并提示。
// 视野标识不存在或名称歧义 → 400；报告不存在 → 404；查询不写回任何数据。
app.post('/api/reports/:id/field-zones', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const body = req.body || {};

  let resolved;
  try {
    resolved = fieldZonesSvc.resolveZonesField(report.fields, body.fieldId);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  let zones;
  try {
    zones = fieldZonesSvc.buildFieldZones(
      resolved.field, resolved.index, report.cells,
      report.calib ? report.calib.scale : null);
  } catch (e) {
    return res.status(500).json({ error: `最近质心责任区分析失败：${e.message}` });
  }

  res.json({
    scope: 'report',
    reportId: report.id,
    title: report.title,
    draftVersion: report.draftVersion,
    calibrated: !!report.calib,
    scaleUmPerPx: report.calib ? report.calib.scale : null,
    matchedBy: resolved.matchBy,
    snapshotUrl: `/api/reports/${report.id}/file`,
    zones
  });
});

// ---------- 同切片两报告 · 单视野细胞覆盖变化核对（只读；只使用发布时冻结数据） ----------
//
// 请求体：{ baselineReportId, retestReportId, fieldId }
// 指定基线报告冻结的一个取样视野，按两份报告冻结的细胞净区域（重叠细胞先取并集）
// 与基线视野净区域，把视野精确分为：共同覆盖 / 仅复测覆盖 / 仅基线覆盖 / 始终未覆盖。
// 返回各类像素面积、占视野净面积比例、按基线冻结标尺换算的物理面积（mm²），
// 以及可在基线图片快照上叠加、逐类切换的实际区域与边界几何。
// 相同报告、不同切片、报告不存在、视野不存在或名称歧义均明确报错；查询不写回任何数据。
app.post('/api/reports/field-coverage-diff', (req, res) => {
  let resolved;
  try {
    resolved = coverageDiffSvc.resolveDiffQuery(req.body || {}, getReportOr404);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  const { baseline, retest, field, matchedBy } = resolved;

  let diff;
  try {
    diff = coverageDiffSvc.buildCoverageDiff(baseline, retest, field);
  } catch (e) {
    return res.status(500).json({ error: `覆盖变化核对失败：${e.message}` });
  }

  res.json({
    scope: 'report-diff',
    baseline: {
      reportId: baseline.id,
      title: baseline.title,
      filename: baseline.filename,
      imageId: baseline.imageId,
      draftVersion: baseline.draftVersion,
      width: baseline.width,
      height: baseline.height,
      scaleUmPerPx: baseline.calib ? baseline.calib.scale : null,
      snapshotUrl: `/api/reports/${baseline.id}/file`,
      correctsReportId: baseline.correctsReportId || null,
      createdAt: baseline.createdAt
    },
    retest: {
      reportId: retest.id,
      title: retest.title,
      filename: retest.filename,
      imageId: retest.imageId,
      draftVersion: retest.draftVersion,
      scaleUmPerPx: retest.calib ? retest.calib.scale : null,
      correctsReportId: retest.correctsReportId || null,
      createdAt: retest.createdAt
    },
    sameSliceImageId: baseline.imageId,
    matchedBy,
    diff
  });
});

app.get('/api/reports/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  res.sendFile(path.join(SNAP_DIR, row.snapshot_name));
});

// ---------- 报告细胞接触簇分析（只读；只使用发布时冻结数据） ----------
//
// 请求体：{ thresholdUm }（微米，可为 0）。按报告冻结的轮廓与定标计算
// 细胞两两净区域间距、阈值内邻接对与连通簇；阈值仅影响本次查询，不写回报告，
// 草稿后续修改或报告更正都不影响本接口对旧报告的分析结果。
app.post('/api/reports/:id/contacts', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  let thresholdUm;
  try {
    thresholdUm = clustersSvc.validateThreshold(req.body && req.body.thresholdUm);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  const analysis = clustersSvc.buildContactAnalysis(
    report.cells, report.calib.scale, thresholdUm);
  res.json({
    scope: 'report',
    reportId: report.id,
    title: report.title,
    draftVersion: report.draftVersion,
    scaleUmPerPx: report.calib.scale,
    ...analysis
  });
});

app.get('/api/reports/:id/png', async (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  try {
    const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), {
      width: row.width, height: row.height,
      calib: JSON.parse(row.calib), cells: JSON.parse(row.cells)
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${row.id}_annotated.png"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: `标注图片生成失败：${e.message}` });
  }
});

app.get('/api/reports/:id/csv', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}_measurements.csv"`);
  res.send(buildReportCsv(report));
});

// 视野统计 CSV：与报告页显示同一份冻结结果（旧报告视野为空 → 仅表头）
app.get('/api/reports/:id/field-csv', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}_fields.csv"`);
  res.send(buildFieldStatsCsv(report));
});

// 多份选定报告导出：{ ids: string[], format: 'csv' | 'png' | 'zip' }
app.post('/api/reports/export', async (req, res) => {
  const { ids, format } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, '请至少选择一份报告');
  const reports = [];
  for (const id of ids.slice(0, 50)) {
    const r = getReportOr404(id);
    if (!r) return badRequest(res, `报告 ${id} 不存在或已被删除`);
    reports.push(r);
  }

  try {
    if (format === 'csv') {
      if (reports.length === 1) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_measurements.csv"`);
        return res.send(buildReportCsv(reports[0]));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="measurements_combined.csv"');
      return res.send(buildCombinedCsv(reports));
    }

    if (format === 'png') {
      if (reports.length !== 1) return badRequest(res, 'PNG 导出仅支持单份报告，多份请选择 ZIP');
      const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(reports[0].id);
      const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), reports[0]);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_annotated.png"`);
      return res.send(buf);
    }

    if (format === 'zip') {
      const pngByName = {};
      for (const r of reports) {
        const row = db.prepare('SELECT snapshot_name FROM reports WHERE id = ?').get(r.id);
        pngByName[r.id] = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), r);
      }
      return streamZip(reports, pngByName, res);
    }

    return badRequest(res, "format 必须是 'csv'、'png' 或 'zip'");
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `导出失败：${e.message}` });
  }
});

// ---------- 报告比较（两份不同报告的冻结数据，手动一对一配对） ----------

function hydrateComparisonRow(row) {
  return {
    id: row.id,
    title: row.title,
    baselineReportId: row.baseline_report_id,
    retestReportId: row.retest_report_id,
    pairs: JSON.parse(row.pairs),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getComparisonOr404(id) {
  const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id);
  return row ? hydrateComparisonRow(row) : null;
}

// 组装比较结果视图；记录引用的报告若已被删除则返回 null
function getComparisonViewOr404(id) {
  const record = getComparisonOr404(id);
  if (!record) return null;
  const baseline = getReportOr404(record.baselineReportId);
  const retest = getReportOr404(record.retestReportId);
  if (!baseline || !retest) return { missing: true, record };
  return cmp.buildComparisonView(record, baseline, retest);
}

app.get('/api/comparisons', (_req, res) => {
  const rows = db.prepare('SELECT * FROM comparisons ORDER BY created_at DESC').all();
  res.json(rows.map((r) => cmp.summarizeRecord(hydrateComparisonRow(r))));
});

// 读取两报告并校验：报告存在、两侧不同、配对合法。任一不满足返回 {error, status}
function resolveComparisonInput(body) {
  const baselineId = body && body.baselineReportId;
  const retestId = body && body.retestReportId;
  if (typeof baselineId !== 'string' || !baselineId ||
      typeof retestId !== 'string' || !retestId) {
    return { error: '请分别选择基线报告 baselineReportId 与复测报告 retestReportId', status: 400 };
  }
  const baseline = getReportOr404(baselineId);
  if (!baseline) return { error: `基线报告 ${baselineId} 不存在`, status: 400 };
  const retest = getReportOr404(retestId);
  if (!retest) return { error: `复测报告 ${retestId} 不存在`, status: 400 };
  if (baselineId === retestId) return { error: '基线与复测必须选择两份不同的报告，整次保存未生效', status: 400 };

  let checked;
  try {
    checked = cmp.validatePairing(body.pairs, baseline, retest);
  } catch (e) {
    return { error: `${e.message}，整次保存未生效`, status: 400 };
  }
  return { baseline, retest, pairs: checked.pairs };
}

function comparisonTitle(input, baseline, retest) {
  const t = typeof input === 'string' ? input.trim() : '';
  if (t) return t.slice(0, 100);
  return `比较：${baseline.title} ↔ ${retest.title}`.slice(0, 100);
}

app.post('/api/comparisons', (req, res) => {
  const input = resolveComparisonInput(req.body || {});
  if (input.error) return res.status(input.status).json({ error: input.error });
  const { baseline, retest, pairs } = input;

  const id = crypto.randomUUID();
  const title = comparisonTitle(req.body.title, baseline, retest);
  // 全部校验通过后才写库：报告不存在/两侧相同/配对重复/细胞不存在时不会有任何写入
  db.prepare(`INSERT INTO comparisons
              (id, title, baseline_report_id, retest_report_id, pairs)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, title, baseline.id, retest.id, JSON.stringify(pairs));

  const view = cmp.buildComparisonView(getComparisonOr404(id), baseline, retest);
  res.status(201).json(view);
});

app.get('/api/comparisons/:id', (req, res) => {
  const view = getComparisonViewOr404(req.params.id);
  if (!view) return res.status(404).json({ error: '比较记录不存在' });
  if (view.missing) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法重建比较结果' });
  }
  res.json(view);
});

// 修改比较记录：必须携带读取时版本；过期返回 409 与当前版本，整次修改不生效
app.put('/api/comparisons/:id', (req, res) => {
  const record = getComparisonOr404(req.params.id);
  if (!record) return res.status(404).json({ error: '比较记录不存在' });

  const version = req.body && req.body.version;
  if (!Number.isInteger(version)) {
    return badRequest(res, '修改比较记录必须携带读取时版本号 version');
  }
  if (version !== record.version) {
    return res.status(409).json({
      error: `比较记录已过期：你携带的版本为 v${version}，当前版本为 v${record.version}，请重新读取后再修改`,
      currentVersion: record.version
    });
  }

  // 两侧报告沿用创建时选择的报告；只允许改标题与配对
  const baseline = getReportOr404(record.baselineReportId);
  const retest = getReportOr404(record.retestReportId);
  if (!baseline || !retest) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法修改' });
  }

  let checked;
  try {
    checked = cmp.validatePairing(req.body && req.body.pairs, baseline, retest);
  } catch (e) {
    return badRequest(res, `${e.message}，整次修改未生效`);
  }

  const title = (req.body && typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : record.title;

  db.prepare(`UPDATE comparisons SET title = ?, pairs = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ? AND version = ?`)
    .run(title, JSON.stringify(checked.pairs), record.id, record.version);

  res.json(cmp.buildComparisonView(getComparisonOr404(record.id), baseline, retest));
});

app.get('/api/comparisons/:id/csv', (req, res) => {
  const view = getComparisonViewOr404(req.params.id);
  if (!view) return res.status(404).json({ error: '比较记录不存在' });
  if (view.missing) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法导出' });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${view.id}_comparison.csv"`);
  res.send(buildComparisonCsv(view));
});

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

app.listen(PORT, () => {
  console.log(`PhytoMeasure 已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
