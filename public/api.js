'use strict';

async function jsonOrThrow(res) {
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const API = {
  async listImages() {
    return jsonOrThrow(await fetch('/api/images'));
  },
  async uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    return jsonOrThrow(await fetch('/api/images', { method: 'POST', body: fd }));
  },
  async getImage(id) {
    return jsonOrThrow(await fetch(`/api/images/${id}`));
  },
  async saveCalibration(id, version, p1, p2, distanceUm) {
    return jsonOrThrow(await fetch(`/api/images/${id}/calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, p1, p2, distanceUm })
    }));
  },
  async saveContours(id, version, cells) {
    return jsonOrThrow(await fetch(`/api/images/${id}/contours`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, cells })
    }));
  },
  async saveFields(id, version, fields) {
    return jsonOrThrow(await fetch(`/api/images/${id}/fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, fields })
    }));
  },
  // 细胞迁移：预览（同一变换与校验，不写入）与确认（携带预览时读取的目标草稿版本）
  async previewMigration(id, payload) {
    return jsonOrThrow(await fetch(`/api/images/${id}/migrate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  async confirmMigration(id, payload) {
    return jsonOrThrow(await fetch(`/api/images/${id}/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  async publish(id, version, title) {
    return jsonOrThrow(await fetch(`/api/images/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, title })
    }));
  },
  // 草稿修订时间线（只追加；每次成功写入都有一条完整快照）
  async listRevisions(id) {
    return jsonOrThrow(await fetch(`/api/images/${id}/revisions`));
  },
  // 读取某条修订的完整快照（标尺/细胞/视野/按该标尺重算的统计），用于预览
  async getRevision(id, revisionId) {
    return jsonOrThrow(await fetch(`/api/images/${id}/revisions/${revisionId}`));
  },
  // 恢复某条修订为当前草稿：必须携带读取时的草稿版本；成功生成新版本与新修订
  async restoreRevision(id, revisionId, version) {
    return jsonOrThrow(await fetch(`/api/images/${id}/revisions/${revisionId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version })
    }));
  },
  // 多视野合并统计：草稿按当前数据实时计算（只读）
  async mergeDraftFields(id, fieldIds) {
    return jsonOrThrow(await fetch(`/api/images/${id}/field-merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldIds })
    }));
  },
  // 多视野合并统计：报告只读取发布时冻结数据（只读）
  async mergeReportFields(reportId, fieldIds) {
    return jsonOrThrow(await fetch(`/api/reports/${reportId}/field-merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldIds })
    }));
  },
  // 单视野细胞覆盖核对：草稿按当前轮廓/视野/标尺实时计算（只读）
  async draftFieldCoverage(id, fieldId) {
    return jsonOrThrow(await fetch(`/api/images/${id}/field-coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId })
    }));
  },
  // 单视野细胞覆盖核对：报告只读取发布时冻结数据（只读）
  async reportFieldCoverage(reportId, fieldId) {
    return jsonOrThrow(await fetch(`/api/reports/${reportId}/field-coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId })
    }));
  },
  // 细胞接触簇分析：报告冻结轮廓与定标 + 本次阈值（只读，不写回报告）
  async reportContacts(reportId, thresholdUm) {
    return jsonOrThrow(await fetch(`/api/reports/${reportId}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thresholdUm })
    }));
  },
  // 单视野网格密度分析：报告冻结视野 × 行×列网格（只读，不写回报告）
  async reportFieldGrid(reportId, payload) {
    return jsonOrThrow(await fetch(`/api/reports/${reportId}/field-grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  // 单视野最近质心责任区分析：报告冻结视野净区域按像素距离分给最近计入细胞（只读）
  async reportFieldZones(reportId, fieldId) {
    return jsonOrThrow(await fetch(`/api/reports/${reportId}/field-zones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId })
    }));
  },
  async listReports() {
    return jsonOrThrow(await fetch('/api/reports'));
  },
  async getReport(id) {
    return jsonOrThrow(await fetch(`/api/reports/${id}`));
  },
  // 更正链：每条链的当前有效报告、历史与更正原因
  async listReportChains() {
    return jsonOrThrow(await fetch('/api/report-chains'));
  },
  // 追溯某份报告所在链（历史报告按原标识查看其链路）
  async traceReport(id) {
    return jsonOrThrow(await fetch(`/api/reports/${id}/trace`));
  },
  // 发起更正：携带所选报告标识、读取时草稿版本、读取时链末端标识、原因
  async correctReport(id, payload) {
    return jsonOrThrow(await fetch(`/api/reports/${id}/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  exportCsvUrl(id) { return `/api/reports/${id}/csv`; },
  exportFieldCsvUrl(id) { return `/api/reports/${id}/field-csv`; },
  exportPngUrl(id) { return `/api/reports/${id}/png`; },

  // ---------- 报告比较 ----------
  async listComparisons() {
    return jsonOrThrow(await fetch('/api/comparisons'));
  },
  async getComparison(id) {
    return jsonOrThrow(await fetch(`/api/comparisons/${id}`));
  },
  async createComparison(payload) {
    return jsonOrThrow(await fetch('/api/comparisons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  async updateComparison(id, payload) {
    return jsonOrThrow(await fetch(`/api/comparisons/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  // 同切片两报告 · 单视野覆盖变化核对（只读；只取发布时冻结数据）
  async reportFieldCoverageDiff(payload) {
    return jsonOrThrow(await fetch('/api/reports/field-coverage-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  },
  comparisonCsvUrl(id) { return `/api/comparisons/${id}/csv`; }
};

window.API = API;
