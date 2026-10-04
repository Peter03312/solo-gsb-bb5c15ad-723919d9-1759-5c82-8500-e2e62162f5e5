'use strict';

// 取样视野 id 身份歧义防护（保存校验 + 只读冲突标明）
//
// 历史版本的「整批保存视野」不校验批次内 id 唯一性，两个不同视野可以使用同一个 id：
// 合并统计按该 id 取到后一个，而覆盖核对、网格密度、最近质心责任区取前一个，
// 同一标识在不同分析中给出互相矛盾的结果。本模块集中提供：
//   - 保存前的 findFieldIdConflicts：保证本批 id 唯一，冲突时由路由整批拒绝并指明位置；
//   - 草稿/报告/修订读取时的冲突标明（fieldIdConflicts）——历史数据不迁移、不静默改写。
//
// 「按 id / 名称解析时是否拒绝重复 id」的判定直接内建在各解析器中，且服务端与页端共用
// 同一份 merge-stats.js（field-grid/field-zones 的解析器同语义内建），保证两侧一致：
// 按 id 命中且该 id 重复 → 身份歧义拒绝；按唯一名称选中的视野照常分析。

// 找出批次内所有重复的视野 id。
// 返回 [{ id, positions: [1 基位置…] }]，按首次出现顺序；id 仅接受非空字符串，
// 缺失/非字符串 id 由调用方负责补生成（新保存），不会进入本函数的冲突统计。
function findFieldIdConflicts(fields) {
  const all = Array.isArray(fields) ? fields : [];
  const order = [];
  const byId = new Map();
  all.forEach((f, i) => {
    if (!f || typeof f.id !== 'string' || !f.id) return;
    if (!byId.has(f.id)) {
      byId.set(f.id, []);
      order.push(f.id);
    }
    byId.get(f.id).push(i + 1); // 1 基位置，与几何校验的视野编号一致
  });
  return order
    .filter((id) => byId.get(id).length > 1)
    .map((id) => ({ id, positions: byId.get(id) }));
}

function describeConflicts(conflicts) {
  return (Array.isArray(conflicts) ? conflicts : [])
    .map((c) => `id「${c.id}」同时用于第 ${c.positions.join('、')} 个视野`)
    .join('；');
}

module.exports = {
  findFieldIdConflicts,
  describeConflicts
};
