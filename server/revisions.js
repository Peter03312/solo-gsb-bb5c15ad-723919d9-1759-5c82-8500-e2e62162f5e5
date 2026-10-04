'use strict';

// 切片草稿修订时间线
//
// 每次【成功写入】草稿内容的操作（定标、轮廓保存、视野保存、细胞迁移确认、
// 草稿恢复）都在同一事务内追加一条不可变修订，完整快照当时的
// {calib, cells, fields}：修订本身就是可读、可预览、可恢复的一致状态。
// 上传的图片以空状态建立【基线修订】；修订表之前已存在的旧草稿，在服务启动时
// 以其当前状态补建一条可恢复基线。失败请求在校验阶段即被拒绝，从不写入修订。
//
// 发布报告同样推进草稿版本，但不改动草稿内容，因此不产生修订
// （已发布报告与更正链在 reports 表中独立留痕，不受恢复影响）。

const TYPE_LABELS = {
  baseline: '基线',
  calibration: '标尺定标',
  contours: '轮廓保存',
  fields: '视野保存',
  migration: '细胞迁移',
  restore: '恢复为当前草稿'
};

function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

// 将一行修订快照水合为 API 视图；withGeometry=true 时展开 calib/cells/fields
function hydrateRevision(row, { withGeometry = false } = {}) {
  const view = {
    id: row.id,
    imageId: row.image_id,
    seq: row.seq,
    type: row.rev_type,
    typeLabel: typeLabel(row.rev_type),
    note: row.note || '',
    draftVersion: row.draft_version,
    width: row.width,
    height: row.height,
    isRestore: row.rev_type === 'restore',
    restoredFromId: row.restored_from_id || null,
    restoredFromSeq: row.restored_from_seq != null ? row.restored_from_seq : null,
    cellCount: row.cell_count,
    fieldCount: row.field_count,
    calibrated: !!row.calibrated,
    createdAt: row.created_at
  };
  if (withGeometry) {
    view.calib = row.calib ? JSON.parse(row.calib) : null;
    view.cells = JSON.parse(row.cells);
    view.fields = JSON.parse(row.fields || '[]');
  }
  return view;
}

// 在事务内提交一次成功的草稿写入并追加修订。
// db 为 better-sqlite3 实例；调用方负责把本函数包在 db.transaction 中（与其它写入原子提交）。
//
// 参数：
//   imageId      切片 id
//   type         calibration | contours | fields | migration | restore
//   state        写入后的完整状态 {calib, cells, fields}
//   draftVersion 写入成功后 images.version 的新值
//   meta         {note?, restoredFromId?, restoredFromSeq?}
function appendRevision(db, imageId, type, state, draftVersion, meta = {}) {
  const calib = state.calib ? JSON.stringify(state.calib) : null;
  const cells = JSON.stringify(state.cells || []);
  const fields = JSON.stringify(state.fields || []);
  const id = require('crypto').randomUUID();
  db.prepare(`INSERT INTO draft_revisions
              (id, image_id, seq, rev_type, note, draft_version, width, height,
               calib, cells, fields, calibrated, cell_count, field_count,
               restored_from_id, restored_from_seq)
              VALUES (?, ?,
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM draft_revisions WHERE image_id = ?),
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, imageId, imageId, type, meta.note || null, draftVersion,
         state.width, state.height, calib, cells, fields,
         state.calib ? 1 : 0, (state.cells || []).length, (state.fields || []).length,
         meta.restoredFromId || null,
         meta.restoredFromSeq != null ? meta.restoredFromSeq : null);
  return getRevision(db, id, true);
}

function getRevision(db, id, withGeometry = false) {
  const row = db.prepare('SELECT * FROM draft_revisions WHERE id = ?').get(id);
  return row ? hydrateRevision(row, { withGeometry }) : null;
}

// 时间线：由新到旧（seq 倒序）
function listRevisions(db, imageId) {
  return db.prepare('SELECT * FROM draft_revisions WHERE image_id = ? ORDER BY seq DESC')
    .all(imageId)
    .map((row) => hydrateRevision(row));
}

// 取一条修订，并核对它确实属于指定切片；不属于或不存在均返回 null（路由层回 404）
function getOwnedRevision(db, imageId, revisionId, withGeometry = true) {
  const row = db.prepare('SELECT * FROM draft_revisions WHERE id = ?').get(revisionId);
  if (!row || row.image_id !== imageId) return null;
  return hydrateRevision(row, { withGeometry });
}

// 为修订表引入前已存在的旧草稿补建可恢复基线：以当前状态完整快照。
// 幂等：已有任何修订的切片不重复补建。返回补建条数。
function ensureBaselines(db) {
  const images = db.prepare('SELECT * FROM images').all();
  let created = 0;
  const insertFor = db.transaction((row) => {
    const calib = row.calib ? JSON.parse(row.calib) : null;
    appendRevision(db, row.id, 'baseline', {
      width: row.width,
      height: row.height,
      calib,
      cells: JSON.parse(row.cells),
      fields: JSON.parse(row.fields || '[]')
    }, row.version, { note: '已有草稿：以当前状态建立的可恢复基线' });
  });
  for (const row of images) {
    const has = db.prepare('SELECT 1 FROM draft_revisions WHERE image_id = ? LIMIT 1').get(row.id);
    if (has) continue;
    insertFor(row);
    created += 1;
  }
  return created;
}

module.exports = {
  TYPE_LABELS,
  typeLabel,
  hydrateRevision,
  appendRevision,
  getRevision,
  listRevisions,
  getOwnedRevision,
  ensureBaselines
};
