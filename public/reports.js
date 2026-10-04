'use strict';

// 已发布报告：列表、批量选择导出（CSV / ZIP / 单份 PNG）、只读快照详情

const Reports = {
  reports: [],
  chains: [],         // 更正链列表（每条链一份当前有效报告）
  selected: new Set(),
  detailView: null,
  mergeReportId: null, // 当前详情报告 id
  mergeSelected: [],   // 报告内多视野合并统计勾选（冻结视野 id）
  coverageReportId: null, // 覆盖核对当前报告 id（切换报告时清空结果）

  // 更正工作状态
  trace: null,        // 当前详情报告的追溯视图
  draft: null,        // 同一切片的当前草稿
  correcting: false,

  // 接触簇分析状态（只读查询，阈值仅影响本次结果）
  contactReportId: null,
  contactResult: null,   // 最近一次分析结果
  contactClusterId: null, // 当前选中（高亮）的簇 id
  contactHighlight: null, // Set<cellKey>，画布高亮用

  // 视野网格密度分析状态（只读查询，只使用发布时冻结数据）
  gridReportId: null,
  gridResult: null,        // 最近一次网格密度分析结果（含 grid 对象）
  gridSelectedIndex: null, // 当前在结果表格中选中的格子 index（画布高亮用）

  // 单视野最近质心责任区分析状态（只读查询，只使用发布时冻结数据）
  zonesReportId: null,
  zonesResult: null,       // 最近一次责任区分析结果（含 zones 对象）
  zonesSelectedKey: null,  // 当前选中分区的细胞 key（画布高亮 + 表格联动）

  async showList() {
    document.getElementById('view-reports').classList.remove('hidden');
    await this.refresh();
  },

  async refresh() {
    let chains;
    try {
      chains = (await API.listReportChains()).chains || [];
    } catch (e) {
      document.getElementById('report-list').innerHTML =
        `<p class="muted">更正链加载失败：${e.message}</p>`;
      return;
    }
    this.chains = chains;
    const el = document.getElementById('report-list');
    if (!chains.length) {
      el.innerHTML = '<p class="muted">还没有已发布的报告。在草稿编辑器中完成定标与圈选后点击「发布当前草稿为报告」。</p>';
    } else {
      el.innerHTML = '';
      chains.forEach((chain) => {
        const r = chain.current;
        const item = document.createElement('div');
        item.className = 'item';
        const label = document.createElement('label');
        label.className = 'main';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.selected.has(r.id);
        cb.onchange = () => {
          if (cb.checked) this.selected.add(r.id); else this.selected.delete(r.id);
          this.updateExportButtons();
        };
        label.appendChild(cb);

        const img = document.createElement('img');
        img.src = `/api/reports/${r.id}/file`;
        img.alt = '';
        label.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const name = document.createElement('div');
        name.className = 'name';
        const link = document.createElement('a');
        link.href = `#/report/${r.id}`;
        link.style.color = 'var(--text)';
        link.textContent = r.title;
        name.appendChild(link);
        meta.appendChild(name);
        const sub = document.createElement('div');
        sub.className = 'sub';
        const chainTxt = chain.length > 1
          ? ` · <span style="color:var(--accent)">更正链 ×${chain.length}</span>（当前为第 ${chain.length} 版）`
          : '';
        sub.innerHTML = `${r.filename} · ${r.width}×${r.height}px · 细胞 ${r.cellCount} 个 · ` +
          `发布于 ${r.createdAt} · 基于草稿 v${r.draftVersion}${chainTxt}`;
        meta.appendChild(sub);
        if (chain.reason) {
          const reason = document.createElement('div');
          reason.className = 'sub';
          reason.style.color = '#ffe2b0';
          reason.textContent = `最近更正原因：${chain.reason}`;
          meta.appendChild(reason);
        }
        label.appendChild(meta);
        item.appendChild(label);

        if (chain.length > 1) {
          const histBtn = document.createElement('button');
          histBtn.className = 'small';
          histBtn.textContent = `历史 (${chain.history.length})`;
          histBtn.onclick = () => this.toggleChainHistory(item, chain);
          item.appendChild(histBtn);
        }
        el.appendChild(item);

        // 历史容器（默认折叠）
        if (chain.length > 1) {
          const histWrap = document.createElement('div');
          histWrap.className = 'chain-history hidden';
          histWrap.dataset.chainHistory = chain.chainId;
          histWrap.appendChild(this.buildHistoryBlock(chain));
          el.appendChild(histWrap);
        }
      });
    }
    // 选择集只保留仍为某条链末端的报告
    const tipIds = new Set(chains.map((c) => c.tipId));
    this.selected = new Set([...this.selected].filter((id) => tipIds.has(id)));
    this.updateExportButtons();
  },

  selectedIds() { return [...this.selected]; },

  // 列表内展开/折叠一条链的历史版本
  toggleChainHistory(item, chain) {
    const wrap = item.parentElement.querySelector(`[data-chain-history="${chain.chainId}"]`);
    if (wrap) wrap.classList.toggle('hidden');
  },

  // 一条链的历史版本块（只列历史成员；历史报告可按原标识打开）
  buildHistoryBlock(chain) {
    const box = document.createElement('div');
    box.className = 'trace-list chain-history-inner';
    // history 由早到晚；展示时新→旧
    chain.history.slice().reverse().forEach((m) => {
      const row = document.createElement('div');
      row.className = 'trace-item';
      const link = document.createElement('a');
      link.href = `#/report/${m.id}`;
      link.className = 't-name';
      link.style.color = 'var(--text)';
      link.textContent = m.title;
      row.innerHTML =
        `<div class="t-head"><span class="trace-tag old">历史</span></div>` +
        `<div class="t-sub">草稿 v${m.draftVersion} · 细胞 ${m.cellCount} 个 · ${m.createdAt}</div>` +
        (m.correctsReportId
          ? `<div class="trace-reason">更正原因：${this.esc(m.correctionReason || '（未填写）')}</div>`
          : '<div class="t-sub">普通发布</div>');
      row.querySelector('.t-head').appendChild(link);
      box.appendChild(row);
    });
    return box;
  },

  updateExportButtons() {
    const n = this.selected.size;
    document.getElementById('export-csv').disabled = n === 0;
    document.getElementById('export-zip').disabled = n === 0;
    document.getElementById('export-single-png').disabled = n !== 1;
  },

  async downloadBlob(url, body, fallbackName) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let msg = `导出失败（HTTP ${res.status}）`;
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      alert(msg);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },

  async showDetail(id) {
    document.getElementById('view-reports').classList.add('hidden');
    document.getElementById('view-report-detail').classList.remove('hidden');
    const r = await API.getReport(id);

    // 更正链追溯 + 同一切片的当前草稿（发起更正所需的乐观标识来自这里）
    this.trace = null;
    this.draft = null;
    this.correcting = false;
    this.setReportContext(r);
    API.traceReport(id).then((t) => { this.trace = t; this.renderChainParts(); }).catch(() => {});
    API.getImage(r.imageId).then((d) => { this.draft = d; this.renderChainParts(); }).catch(() => {});

    document.getElementById('rp-title').textContent = r.title;
    document.getElementById('rp-meta').innerHTML =
      `图片：<b>${r.filename}</b>（${r.width}×${r.height} px）<br>` +
      `发布时间：${r.createdAt}<br>` +
      `发布时草稿版本：<b>v${r.draftVersion}</b><br>` +
      `标尺：p1 (${r.calib.p1.x.toFixed(1)}, ${r.calib.p1.y.toFixed(1)})，` +
      `p2 (${r.calib.p2.x.toFixed(1)}, ${r.calib.p2.y.toFixed(1)})，` +
      `${r.calib.distanceUm} μm，1 px = ${r.calib.scale.toFixed(6)} μm<br>` +
      `细胞：<b>${r.cells.length}</b> 个（结果为发布时冻结值，不随后续草稿变化）` +
      (r.correctsReportId
        ? `<br>更正自：<a href="#/report/${r.correctsReportId}">上一版报告</a>` +
          `<br>更正原因：<b style="color:#ffe2b0">${this.esc(r.correctionReason || '（未填写）')}</b>`
        : '');

    const rows = r.cells.map((c, i) => `
      <tr>
        <td><span style="color:${window.CANVAS_COLORS[i % window.CANVAS_COLORS.length]}">●</span> ${c.name || `细胞 ${i + 1}`}</td>
        <td>${c.holes.length}</td>
        <td>${this.fmt(c.areaUm2)}</td>
        <td>${this.fmt(c.perimeterUm)}</td>
      </tr>`).join('');
    document.getElementById('rp-table-wrap').innerHTML = `
      <table class="measure">
        <thead><tr><th>细胞</th><th>孔洞</th><th>净面积 μm²</th><th>总周长 μm</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    // 视野细胞密度统计：与视野统计 CSV 取同一冻结 fieldStats
    const fs = r.fieldStats || [];
    const fsWrap = document.getElementById('rp-field-wrap');
    // 身份歧义检测（修复前发布的旧报告可能含同批重复 id）：仅标明、只读，不改写冻结内容
    const fieldConflicts = window.MergeStats.duplicateFieldIdGroups(r.fields || []);
    if (!fs.length) {
      fsWrap.innerHTML = '<p class="hint">本报告发布时未圈定取样视野（旧报告缺少视野按空列表读取）。</p>';
    } else {
      const conflictIds = new Set(fieldConflicts.keys());
      const frows = fs.map((s, i) => `
        <tr${conflictIds.has((r.fields || [])[i].id) ? ' class="id-conflict-row"' : ''}>
          <td><span style="color:#ffd400">●</span> ${s.name}${
          conflictIds.has((r.fields || [])[i].id) ? ' <span class="conflict-badge">⚠ id 冲突</span>' : ''}</td>
          <td>${s.holes}</td>
          <td>${s.areaText}</td>
          <td>${s.cellCount}</td>
          <td>${s.densityText}</td>
          <td>${s.countedCellAreaText}</td>
        </tr>`).join('');
      const conflictBanner = fieldConflicts.size
        ? `<div class="identity-conflict">⚠ <b>本报告冻结视野存在 id 身份歧义</b>（修复前发布的历史报告，保持冻结、只读）：<br>` +
          [...fieldConflicts.entries()].map(([fid, idx]) =>
            `id「${this.esc(fid)}」被第 ${idx.map((k) => k + 1).join('、')} 个视野共用`).join('<br>') +
          '<br>按该 id 的合并统计与单视野分析（覆盖核对/网格密度/责任区）会选中不同视野、结果互相矛盾，' +
          '这些请求将被<b>明确拒绝</b>；按<b>唯一名称</b>查询仍可选中对应视野。' +
          '报告内容冻结不可改写；如需修正，请在同一切片草稿编辑页修正视野后重新发布/发起更正。</div>'
        : '';
      fsWrap.innerHTML = `${conflictBanner}
        <table class="measure compact">
          <thead><tr>
            <th>视野</th><th>孔洞</th><th>净面积 mm²</th><th>细胞数</th>
            <th>细胞密度 个/mm²</th><th>计入细胞净面积总和 mm²</th>
          </tr></thead>
          <tbody>${frows}</tbody>
        </table>
        <p class="hint">发布时冻结，不随后续草稿变化；与「视野统计 CSV」为同一份结果。</p>`;
    }

    // 多视野合并统计：只使用发布时冻结的 fields/cells/calib
    this.mergeReportId = r.id;
    this.mergeSelected = [];
    this.renderReportMerge(r);

    // 单视野覆盖核对：走只读 HTTP API，只用发布时冻结数据；切换报告时重置
    this.coverageReportId = r.id;
    const covInput = document.getElementById('rp-coverage-field-id');
    if (covInput) covInput.value = '';
    const covOptions = document.getElementById('rp-coverage-field-options');
    if (covOptions) {
      covOptions.innerHTML = (r.fields || []).map((f, i) => {
        const name = f.name || `视野 ${i + 1}`;
        const g = fieldConflicts.get(f.id);
        const suffix = g ? ` ⚠id冲突(${g.map((k) => k + 1).join('/')})` : '';
        return `<option value="${this.esc(f.id)}">${this.esc(name)}${this.esc(suffix)}</option>`;
      }).join('');
    }
    document.getElementById('rp-coverage-result').innerHTML =
      (r.fields || []).length
        ? '<p class="hint">输入视野 id 或名称后点「核对覆盖」。</p>'
        : '<p class="hint">本报告发布时未圈定取样视野，无法核对覆盖。</p>';
    document.getElementById('rp-coverage-run').onclick = () => this.runCoverageQuery();
    covInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.runCoverageQuery(); }
    };

    // 接触簇分析：只读查询，阈值仅影响本次结果；切换报告时重置
    this.contactReportId = r.id;
    this.contactResult = null;
    this.contactClusterId = null;
    this.contactHighlight = null;
    document.getElementById('rp-contact-result').innerHTML =
      '<p class="hint">输入阈值后点击「分析接触簇」。</p>';
    document.getElementById('rp-contact-clear').classList.add('hidden');
    document.getElementById('rp-contact-run').onclick = () => this.runContactAnalysis();
    document.getElementById('rp-contact-clear').onclick = () => this.clearContactHighlight();

    // 视野网格密度分析：只读查询，只用发布时冻结数据；切换报告时重置
    this.gridReportId = r.id;
    this.gridResult = null;
    this.gridSelectedIndex = null;
    const gridInput = document.getElementById('rp-grid-field-id');
    if (gridInput) gridInput.value = '';
    const gridOptions = document.getElementById('rp-grid-field-options');
    if (gridOptions) {
      gridOptions.innerHTML = (r.fields || []).map((f, i) => {
        const name = f.name || `视野 ${i + 1}`;
        const g = fieldConflicts.get(f.id);
        const suffix = g ? ` ⚠id冲突(${g.map((k) => k + 1).join('/')})` : '';
        return `<option value="${this.esc(f.id)}">${this.esc(name)}${this.esc(suffix)}</option>`;
      }).join('');
    }
    document.getElementById('rp-grid-result').innerHTML =
      (r.fields || []).length
        ? '<p class="hint">选择视野并给定行×列数（各 1～40）后点「分析网格密度」。</p>'
        : '<p class="hint">本报告发布时未圈定取样视野，无法做网格密度分析。</p>';
    document.getElementById('rp-grid-clear').classList.add('hidden');
    document.getElementById('rp-grid-run').onclick = () => this.runGridAnalysis();
    document.getElementById('rp-grid-clear').onclick = () => this.clearGridOverlay();
    if (gridInput) {
      gridInput.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.runGridAnalysis(); }
      };
    }

    // 最近质心责任区分析：只读查询，只用发布时冻结数据；切换报告时重置
    this.zonesReportId = r.id;
    this.zonesResult = null;
    this.zonesSelectedKey = null;
    const zonesInput = document.getElementById('rp-zones-field-id');
    if (zonesInput) zonesInput.value = '';
    const zonesOptions = document.getElementById('rp-zones-field-options');
    if (zonesOptions) {
      zonesOptions.innerHTML = (r.fields || []).map((f, i) => {
        const name = f.name || `视野 ${i + 1}`;
        const g = fieldConflicts.get(f.id);
        const suffix = g ? ` ⚠id冲突(${g.map((k) => k + 1).join('/')})` : '';
        return `<option value="${this.esc(f.id)}">${this.esc(name)}${this.esc(suffix)}</option>`;
      }).join('');
    }
    document.getElementById('rp-zones-result').innerHTML =
      (r.fields || []).length
        ? '<p class="hint">输入视野 id 或名称后点「分析责任区」。</p>'
        : '<p class="hint">本报告发布时未圈定取样视野，无法做责任区分析。</p>';
    document.getElementById('rp-zones-clear').classList.add('hidden');
    document.getElementById('rp-zones-run').onclick = () => this.runZonesAnalysis();
    document.getElementById('rp-zones-clear').onclick = () => this.clearZonesOverlay();
    if (zonesInput) {
      zonesInput.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.runZonesAnalysis(); }
      };
    }

    document.getElementById('rp-png-link').href = API.exportPngUrl(r.id);
    document.getElementById('rp-png-link').setAttribute('download', `${r.id}_annotated.png`);
    document.getElementById('rp-csv-link').href = API.exportCsvUrl(r.id);
    document.getElementById('rp-csv-link').setAttribute('download', `${r.id}_measurements.csv`);
    document.getElementById('rp-field-csv-link').href = API.exportFieldCsvUrl(r.id);
    document.getElementById('rp-field-csv-link').setAttribute('download', `${r.id}_fields.csv`);

    if (!this.detailView) {
      this.detailView = new CanvasView(document.getElementById('report-canvas'), {
        onZoom: (k) => { document.getElementById('report-zoom').textContent = `${Math.round(k * 100)}%`; }
      });
      this.detailView.readOnly = true;
    }
    this.detailView.bindState(() => ({
      cells: r.cells, fields: r.fields || [], calib: r.calib,
      activeCellId: null, highlightCellIds: this.contactHighlight,
      gridOverlay: this.gridResult ? this.gridResult.grid : null,
      gridSelectedIndex: this.gridSelectedIndex,
      zonesOverlay: this.zonesResult ? this.zonesResult.zones : null,
      zonesSelectedKey: this.zonesSelectedKey
    }));
    this.detailView.cb.onPickZone = (key) => this.selectZoneOnCanvas(key);
    await this.detailView.loadImage(`/api/reports/${r.id}/file`, r.width, r.height);
    this.detailView.readOnly = true;
    this.detailView.setTool('pan');
    this.renderChainParts();
  },

  hideDetail() {
    if (this.detailView) this.detailView.destroy(), (this.detailView = null);
    this.mergeReportId = null;
    this.mergeSelected = [];
    this.trace = null;
    this.draft = null;
    this.correcting = false;
    this.contactReportId = null;
    this.contactResult = null;
    this.contactClusterId = null;
    this.contactHighlight = null;
    this.coverageReportId = null;
    this.gridReportId = null;
    this.gridResult = null;
    this.gridSelectedIndex = null;
    this.zonesReportId = null;
    this.zonesResult = null;
    this.zonesSelectedKey = null;
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // ---------- 更正链：横幅、历史追溯、发起更正 ----------

  renderChainParts() {
    if (document.getElementById('view-report-detail').classList.contains('hidden')) return;
    this.renderBanner();
    this.renderTrace();
    this.renderCorrectBox();
  },

  renderBanner() {
    const el = document.getElementById('rp-chain-banner');
    if (!el || !this.trace) { el && el.classList.add('hidden'); return; }
    if (this.trace.isTip) {
      el.className = 'chain-banner tip';
      el.innerHTML = this.trace.length > 1
        ? `✅ 这是该更正链的<b>当前有效报告</b>（第 ${this.trace.length} 版 / 共 ${this.trace.length} 版）。`
        : '✅ 这是该报告链的当前有效报告（尚未被更正）。';
    } else {
      el.className = 'chain-banner superseded';
      el.innerHTML = `⚠ 这是一份<b>历史报告</b>（第 ${this.trace.position} 版 / 共 ${this.trace.length} 版），` +
        `已被后续更正取代。当前有效报告为 ` +
        `<a href="#/report/${this.trace.tipId}">第 ${this.trace.length} 版</a>。` +
        `本页内容仍为发布当时的冻结结果，可按原标识读取与导出。`;
    }
  },

  renderTrace() {
    const el = document.getElementById('rp-trace');
    if (!el) return;
    if (!this.trace) { el.innerHTML = '<p class="hint">加载更正链…</p>'; return; }
    el.innerHTML = '';
    // 从最新一版到最早一版展示，便于先看当前有效报告与历次原因
    this.trace.members.slice().reverse().forEach((m) => {
      const row = document.createElement('div');
      row.className = 'trace-item' + (m.isTip ? ' current' : '');
      const tag = m.isTip
        ? '<span class="trace-tag tip">当前有效</span>'
        : '<span class="trace-tag old">历史</span>';
      const why = m.correctsReportId
        ? `<div class="trace-reason">更正原因：${this.esc(m.correctionReason || '（未填写）')}</div>`
        : '<div class="t-sub">普通发布</div>';
      row.innerHTML =
        `<div class="t-head">${tag}<a class="t-name" href="#/report/${m.id}" style="color:var(--text)">${this.esc(m.title)}</a></div>` +
        `<div class="t-sub">第 ${m.seq} 版 · 草稿 v${m.draftVersion} · 细胞 ${m.cellCount} 个 · ${m.createdAt}</div>` +
        why;
      el.appendChild(row);
    });
  },

  renderCorrectBox() {
    const el = document.getElementById('rp-correct');
    if (!el) return;
    if (!this.trace) { el.innerHTML = '<p class="hint">加载中…</p>'; return; }
    if (!this.trace.isTip) {
      el.innerHTML = '<p class="hint">当前查看的是历史报告，不能直接对它更正。' +
        `请打开<a href="#/report/${this.trace.tipId}">当前有效报告</a>后再发起更正。</p>`;
      return;
    }
    if (!this.draft) { el.innerHTML = '<p class="hint">当前草稿加载中…</p>'; return; }

    const d = this.draft;
    const calibTxt = d.calib
      ? `已定标（1 px = ${d.calib.scale.toFixed(6)} μm）`
      : '<span style="color:var(--danger)">未定标</span>';
    el.innerHTML =
      `<p class="hint">更正会用<b>同一切片的当前草稿</b>冻结出一份<b>新的不可变报告</b>和图片快照，` +
        `并记录更正原因；本报告保留为历史。提交携带所选报告标识、读取时草稿版本 ` +
        `<b>v${d.version}</b> 与读取时链末端标识。草稿或链末端变化将被拒绝并返回最新信息。</p>` +
      `<div class="correct-draft">
        当前草稿：<b>${this.esc(d.filename)}</b> · 草稿 v${d.version} · ${calibTxt} · 细胞 ${d.cells.length} 个 · 视野 ${d.fields.length} 个
        <br><a href="#/edit/${d.id}">前往编辑器修改草稿 →</a>
      </div>
      <label>新报告标题（留空则沿用本报告标题）</label>
      <input type="text" id="rc-title" maxlength="100" placeholder="${this.esc(this._reportTitle || '')}" />
      <label>更正原因（必填）</label>
      <textarea id="rc-reason" maxlength="500" placeholder="例如：第 2 个细胞孔洞圈错，重描后重新发布"></textarea>
      <div class="toolbar wrap" style="margin-top:8px">
        <button id="rc-submit" class="primary small"${this.correcting ? ' disabled' : ''}>用当前草稿生成更正报告</button>
        <button id="rc-refresh" class="small"${this.correcting ? ' disabled' : ''}>重新读取最新草稿/链</button>
      </div>
      <div id="rc-msg"></div>`;

    document.getElementById('rc-submit').onclick = () => this.submitCorrection();
    document.getElementById('rc-refresh').onclick = () => this.reloadCorrectContext();
  },

  // 记录当前详情报告标题（供标题占位符使用）
  setReportContext(report) { this._reportTitle = report ? report.title : ''; },

  async reloadCorrectContext() {
    const id = location.hash.split('/').pop();
    try {
      const [r, t, d] = await Promise.all([
        API.getReport(id), API.traceReport(id), API.getImage(this.trace ? this.trace.current.imageId : id)
      ]);
      this.trace = t;
      this.draft = d;
      this._reportTitle = r.title;
      this.renderChainParts();
    } catch (e) {
      this.toastCorrection(e.message, false);
    }
  },

  async submitCorrection() {
    if (!this.trace || !this.draft || this.correcting) return;
    const reason = document.getElementById('rc-reason').value;
    const title = document.getElementById('rc-title').value;
    const reportId = this.trace.reportId;
    const payload = {
      reason,
      draftVersion: this.draft.version,        // 读取时草稿版本
      expectedTipId: this.trace.tipId          // 读取时更正链末端标识
    };
    if (title.trim()) payload.title = title.trim();

    this.correcting = true;
    this.renderCorrectBox();
    try {
      const resp = await API.correctReport(reportId, payload);
      // 进入新的链末端详情（提示在下一帧渲染）
      location.hash = `#/report/${resp.report.id}`;
    } catch (e) {
      this.correcting = false;
      if (e.status === 409 && e.body) {
        // 版本或链末端变化：服务端返回最新草稿版本与当前链末端，用其刷新上下文
        if (e.body.image) this.draft = e.body.image;
        try { this.trace = await API.traceReport(reportId); } catch (_) { /* ignore */ }
        this.renderChainParts();
        // 冲突后可能已变为历史报告（renderCorrectBox 已切换提示）；仍是末端时回填刚填的内容
        const reasonEl = document.getElementById('rc-reason');
        if (reasonEl) {
          reasonEl.value = reason;
          const titleEl = document.getElementById('rc-title');
          if (titleEl) titleEl.value = title;
        }
        this.toastCorrection(`${e.message} 已加载最新信息，请确认后重新提交。`, false);
      } else {
        this.toastCorrection(e.message, false);
        this.renderCorrectBox();
        const reasonEl = document.getElementById('rc-reason');
        if (reasonEl) {
          reasonEl.value = reason;
          const titleEl = document.getElementById('rc-title');
          if (titleEl) titleEl.value = title;
        }
      }
    }
  },

  toastCorrection(msg, ok) {
    const el = document.getElementById('rc-msg');
    if (!el) return;
    el.className = ok ? 'correct-ok' : 'correct-error';
    el.textContent = msg;
  },

  // ---------- 多视野合并统计（发布时冻结；页端与服务端共用 MergeStats） ----------

  toggleReportMergeField(report, id, checked) {
    const set = new Set(this.mergeSelected);
    if (checked) set.add(id); else set.delete(id);
    this.mergeSelected = (report.fields || []).filter((f) => set.has(f.id)).map((f) => f.id);
    this.renderReportMerge(report);
  },

  renderReportMerge(r) {
    const listEl = document.getElementById('rp-merge-field-list');
    const resEl = document.getElementById('rp-merge-result');
    if (!listEl || !resEl) return;
    const fields = r.fields || [];
    listEl.innerHTML = '';
    if (!fields.length) {
      listEl.innerHTML = '<p class="hint">本报告发布时未圈定取样视野，无法合并统计。</p>';
      resEl.innerHTML = '';
      return;
    }

    const selSet = new Set(this.mergeSelected);
    const mergeConflicts = window.MergeStats.duplicateFieldIdGroups(fields);
    fields.forEach((f, i) => {
      const row = document.createElement('label');
      row.className = 'merge-row' + (selSet.has(f.id) ? ' active' : '') +
        (mergeConflicts.has(f.id) ? ' id-conflict-row' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selSet.has(f.id);
      cb.onchange = () => this.toggleReportMergeField(r, f.id, cb.checked);
      row.appendChild(cb);
      const name = document.createElement('span');
      name.innerHTML = `<span style="color:#ffd400">●</span> ${f.name || `视野 ${i + 1}`}` +
        (mergeConflicts.has(f.id)
          ? ` <span class="conflict-badge">⚠ id 冲突（第 ${mergeConflicts.get(f.id).map((k) => k + 1).join('、')} 个共用）</span>`
          : '');
      row.appendChild(name);
      listEl.appendChild(row);
    });

    const n = this.mergeSelected.length;
    if (n < 2) {
      resEl.innerHTML = `<p class="hint">已勾选 <b>${n}</b> 个视野：合并统计至少需要勾选 <b>2</b> 个本报告内的视野。</p>`;
      return;
    }

    let s;
    try {
      const selected = window.MergeStats.resolveMergeSelection(fields, this.mergeSelected);
      s = window.MergeStats.buildMergeStats(selected, r.cells || [], r.calib ? r.calib.scale : null);
    } catch (e) {
      resEl.innerHTML = `<p class="merge-error">${e.message}</p>`;
      return;
    }

    const names = s.fieldNames.join('、');
    const counted = (s.countedCells || []).map((c) => c.name || c.key).join('、');
    resEl.innerHTML = `
      <table class="measure compact">
        <tbody>
          <tr><th>合并视野</th><td>${s.fieldCount} 个（${names}）</td></tr>
          <tr><th>并集净面积 mm²</th><td>${s.areaText}</td></tr>
          <tr><th>细胞数</th><td>${s.cellCount}</td></tr>
          <tr><th>细胞密度 个/mm²</th><td>${s.densityText}</td></tr>
          <tr><th>计入细胞净面积总和 mm²</th><td>${s.countedCellAreaText}</td></tr>
        </tbody>
      </table>
      <p class="hint">同一细胞在并集中只计一次。计入细胞：${counted || '（无）'}。
      结果只读取<b>发布时冻结数据</b>（发布时草稿 v${r.draftVersion}），不随后续草稿变化。</p>`;
  },

  // ---------- 单视野细胞覆盖核对（发布时冻结；只读 HTTP） ----------

  fmtPx(v) {
    if (!Number.isFinite(v)) return '—';
    return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  },

  async runCoverageQuery() {
    if (!this.coverageReportId) return;
    const resEl = document.getElementById('rp-coverage-result');
    const raw = document.getElementById('rp-coverage-field-id').value.trim();
    if (!raw) {
      resEl.innerHTML = '<p class="merge-error">请输入视野 id 或视野名称。</p>';
      return;
    }
    resEl.innerHTML = '<p class="hint">计算中…</p>';
    try {
      const body = await API.reportFieldCoverage(this.coverageReportId, raw);
      if (body.reportId !== this.coverageReportId) return; // 期间已切换报告
      this.renderCoverageResult(body);
    } catch (e) {
      // 400：视野标识不存在/不属于本报告/重名；404：报告不存在。不写回任何数据
      resEl.innerHTML = `<p class="merge-error">${this.esc(e.message)}</p>`;
    }
  },

  renderCoverageResult(body) {
    const resEl = document.getElementById('rp-coverage-result');
    const s = body.coverage;
    const contributing = (s.contributingCells || [])
      .map((c) => c.name || c.key).join('、');
    resEl.innerHTML = `
      <table class="measure compact">
        <tbody>
          <tr><th>视野</th><td>${this.esc(s.fieldName || s.fieldId)}${body.matchedBy === 'name' ? '（按名称匹配）' : ''}</td></tr>
          <tr><th>视野净面积</th>
            <td>${this.fmtPx(s.fieldAreaPx)} px² · ${this.esc(s.fieldAreaText)}${s.calibrated ? ' mm²' : ''}</td></tr>
          <tr><th>细胞覆盖面积</th>
            <td>${this.fmtPx(s.coveredAreaPx)} px² · ${this.esc(s.coveredAreaText)}${s.calibrated ? ' mm²' : ''}</td></tr>
          <tr><th>未覆盖面积</th>
            <td>${this.fmtPx(s.uncoveredAreaPx)} px² · ${this.esc(s.uncoveredAreaText)}${s.calibrated ? ' mm²' : ''}</td></tr>
          <tr><th>覆盖率</th><td><b>${this.esc(s.coverageText)}</b></td></tr>
        </tbody>
      </table>
      <p class="hint">覆盖按<b>几何交集</b>计算：跨边界细胞只计视野内部分，多个细胞重叠只计一次，
      孔洞与仅边界接触不贡献面积；与按质心计数的密度统计无关。
      有交集的细胞 ${s.contributingCellCount} 个：${this.esc(contributing) || '（无）'}。
      结果只读取<b>发布时冻结数据</b>（发布时草稿 v${body.draftVersion}），
      后续草稿修改或报告更正均不改变本报告结果；本查询不写回报告。</p>`;
  },

  // ---------- 视野网格密度分析（发布时冻结；只读 HTTP，不写回报告） ----------

  async runGridAnalysis() {
    if (!this.gridReportId) return;
    const resEl = document.getElementById('rp-grid-result');
    const fieldId = document.getElementById('rp-grid-field-id').value.trim();
    if (!fieldId) {
      resEl.innerHTML = '<p class="merge-error">请输入视野 id 或视野名称。</p>';
      return;
    }
    // 行/列数合法性由服务端最终判定（非整数或越出 1～40 → 400）
    const rows = Number(document.getElementById('rp-grid-rows').value);
    const cols = Number(document.getElementById('rp-grid-cols').value);
    resEl.innerHTML = '<p class="hint">计算中…</p>';
    try {
      const body = await API.reportFieldGrid(this.gridReportId, { fieldId, rows, cols });
      if (body.reportId !== this.gridReportId) return; // 期间已切换报告
      this.gridResult = body;
      this.gridSelectedIndex = null;
      this.renderGridResult();
    } catch (e) {
      // 400：视野标识为空/不存在/重名、行列数越界；404：报告不存在。不写回任何数据
      this.gridResult = null;
      this.gridSelectedIndex = null;
      resEl.innerHTML = `<p class="merge-error">${this.esc(e.message)}</p>`;
    }
    document.getElementById('rp-grid-clear').classList.toggle('hidden', !this.gridResult);
    if (this.detailView) this.detailView.render();
  },

  renderGridResult() {
    const resEl = document.getElementById('rp-grid-result');
    const body = this.gridResult;
    if (!body) return;
    const g = body.grid;
    const rowsHtml = g.cells.map((cell) => {
      const active = this.gridSelectedIndex === cell.index ? ' class="grid-row-active"' : '';
      const dens = cell.zeroArea
        ? `<span style="color:var(--warn)">${this.esc(cell.densityText)}</span>`
        : this.esc(cell.densityText);
      return `<tr data-grid-index="${cell.index}"${active}>` +
        `<td>第${cell.row + 1}行 第${cell.col + 1}列</td>` +
        `<td>${this.fmtPx(cell.areaPx)}</td>` +
        `<td>${this.esc(cell.areaText)}</td>` +
        `<td>${cell.cellCount}</td>` +
        `<td>${dens}</td></tr>`;
    }).join('');
    resEl.innerHTML = `
      <table class="measure compact">
        <tbody>
          <tr><th>视野</th><td>${this.esc(g.fieldName || g.fieldId)}${body.matchedBy === 'name' ? '（按名称匹配）' : ''}</td></tr>
          <tr><th>网格</th><td>${g.rows} 行 × ${g.cols} 列（每格约 ${this.fmtPx(g.cellWidthPx)} × ${this.fmtPx(g.cellHeightPx)} px）</td></tr>
          <tr><th>视野净面积</th><td>${this.fmtPx(g.fieldAreaPx)} px² · ${this.esc(g.fieldAreaText)} mm²</td></tr>
          <tr><th>各格有效面积合计</th><td>${this.fmtPx(g.sumAreaPx)} px²（＝视野净面积）</td></tr>
          <tr><th>细胞计数校验</th><td>各格合计 ${g.sumCellCount} ＝ 原视野统计 ${g.fieldCellCount}</td></tr>
        </tbody>
      </table>
      <div class="grid-table-wrap">
        <table class="measure compact">
          <thead><tr><th>格子</th><th>有效面积 px²</th><th>有效面积 mm²</th><th>细胞数</th><th>密度 个/mm²</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="hint">每格有效面积为格子与视野净区域（扣除孔洞）的几何交集；零面积格密度为「不可计算」。
        快照上青色网格为等分线、品红点为计入细胞的净区域质心，格子亮度随密度增高；
        点击表格行可在快照上定位该格（再点一次取消）。
        结果只读取<b>发布时冻结数据</b>（发布时草稿 v${body.draftVersion}），
        后续草稿修改或报告更正均不改变本报告结果；查询不写回报告。</p>`;
    resEl.querySelectorAll('tr[data-grid-index]').forEach((tr) => {
      tr.onclick = () => this.selectGridCell(Number(tr.dataset.gridIndex));
    });
  },

  // 选中/取消某个格子：在报告快照画布上高亮该格
  selectGridCell(index) {
    if (!this.gridResult) return;
    this.gridSelectedIndex = this.gridSelectedIndex === index ? null : index;
    this.renderGridResult();
    if (this.detailView) this.detailView.render();
  },

  clearGridOverlay() {
    this.gridResult = null;
    this.gridSelectedIndex = null;
    document.getElementById('rp-grid-result').innerHTML =
      '<p class="hint">选择视野并给定行×列数（各 1～40）后点「分析网格密度」。</p>';
    document.getElementById('rp-grid-clear').classList.add('hidden');
    if (this.detailView) this.detailView.render();
  },

  // ---------- 单视野最近质心责任区分析（发布时冻结；只读 HTTP，不写回报告） ----------

  async runZonesAnalysis() {
    if (!this.zonesReportId) return;
    const resEl = document.getElementById('rp-zones-result');
    const fieldId = document.getElementById('rp-zones-field-id').value.trim();
    if (!fieldId) {
      resEl.innerHTML = '<p class="merge-error">请输入视野 id 或视野名称。</p>';
      return;
    }
    resEl.innerHTML = '<p class="hint">计算中…</p>';
    try {
      const body = await API.reportFieldZones(this.zonesReportId, fieldId);
      if (body.reportId !== this.zonesReportId) return; // 期间已切换报告
      this.zonesResult = body;
      this.zonesSelectedKey = null;
      this.renderZonesResult();
    } catch (e) {
      // 400：视野标识为空/不存在/重名；404：报告不存在。不写回任何数据
      this.zonesResult = null;
      this.zonesSelectedKey = null;
      resEl.innerHTML = `<p class="merge-error">${this.esc(e.message)}</p>`;
    }
    document.getElementById('rp-zones-clear').classList.toggle('hidden', !this.zonesResult);
    if (this.detailView) this.detailView.render();
  },

  renderZonesResult() {
    const resEl = document.getElementById('rp-zones-result');
    const body = this.zonesResult;
    if (!body) return;
    const z = body.zones;

    // 无计入细胞：空结果提示（视野净区域不分配）
    if (z.empty) {
      resEl.innerHTML = `
        <table class="measure compact">
          <tbody>
            <tr><th>视野</th><td>${this.esc(z.fieldName || z.fieldId)}${body.matchedBy === 'name' ? '（按名称匹配）' : ''}</td></tr>
            <tr><th>视野净面积</th><td>${this.fmtPx(z.fieldAreaPx)} px² · ${this.esc(z.fieldAreaText)} mm²</td></tr>
            <tr><th>计入细胞</th><td><b>0</b> 个</td></tr>
          </tbody>
        </table>
        <p class="merge-error">${this.esc(z.message)}</p>
        <p class="hint">结果只读取<b>发布时冻结数据</b>（发布时草稿 v${body.draftVersion}），查询不写回报告。</p>`;
      return;
    }

    // 每个细胞一行：占有细胞有实际分区与占比；质心重合的跟随细胞零面积并注明占有者
    const rowsHtml = z.zones.map((zn) => {
      const active = this.zonesSelectedKey === zn.key ? ' class="grid-row-active"' : '';
      const colorIdx = this._zoneColorIndex(zn.key);
      const dot = colorIdx == null ? '○'
        : `<span style="color:${window.CANVAS_COLORS[colorIdx % window.CANVAS_COLORS.length]}">●</span>`;
      const tag = zn.coincident
        ? ` <span class="hint">（质心与 ${this.esc(zn.coincidentWith.join('、'))} 重合，按报告顺序不占有区域）</span>`
        : '';
      return `<tr data-zone-key="${this.esc(zn.key)}"${active}>` +
        `<td>${dot} ${this.esc(zn.name || `细胞 ${zn.seq}`)}${tag}</td>` +
        `<td>${this.fmtPx(zn.areaPx)}</td>` +
        `<td>${this.esc(zn.areaText)}</td>` +
        `<td>${this.esc(zn.percentText)}</td></tr>`;
    }).join('');

    const excludedHtml = z.excludedCells.length
      ? `<p class="hint">未计入细胞 ${z.excludedCellCount} 个（不参与分配）：` +
        z.excludedCells.map((c) => `${this.esc(c.name || `细胞 ${c.seq}`)}（${this.esc(c.reason)}）`).join('；') +
        '。</p>'
      : '';

    resEl.innerHTML = `
      <table class="measure compact">
        <tbody>
          <tr><th>视野</th><td>${this.esc(z.fieldName || z.fieldId)}${body.matchedBy === 'name' ? '（按名称匹配）' : ''}（孔洞 ${z.fieldHoles} 个）</td></tr>
          <tr><th>视野净面积</th><td>${this.fmtPx(z.fieldAreaPx)} px² · ${this.esc(z.fieldAreaText)} mm²</td></tr>
          <tr><th>计入细胞</th><td>${z.countedCellCount} 个（占有位置 ${z.ownerCellCount} 个${z.coincidentCellCount ? `，质心重合零面积 ${z.coincidentCellCount} 个` : ''}；未计入 ${z.excludedCellCount} 个）</td></tr>
          <tr><th>各区面积合计</th><td><b>${this.fmtPx(z.sumAreaPx)} px² · ${this.esc(z.sumAreaText)} mm²</b>（＝视野净面积），占比合计 ${z.sumPercent}%</td></tr>
        </tbody>
      </table>
      <div class="grid-table-wrap">
        <table class="measure compact">
          <thead><tr><th>细胞（按报告顺序）</th><th>责任区面积 px²</th><th>责任区面积 mm²</th><th>占视野净面积</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${excludedHtml}
      <p class="hint">分区按像素欧氏距离归属最近的计入细胞（净区域质心严格落在视野净区域内）；
        视野孔洞及外部不分配，等距边界不计面积；快照上各色块为细胞实际责任区，品红点为计入细胞质心，
        <b>点击表格行或快照上的分区</b>可高亮定位（再点一次取消）。
        结果只读取<b>发布时冻结数据</b>（发布时草稿 v${body.draftVersion}），
        后续草稿修改或报告更正均不改变本报告结果；查询不写回报告。</p>`;
    resEl.querySelectorAll('tr[data-zone-key]').forEach((tr) => {
      tr.onclick = () => this.selectZoneKey(tr.dataset.zoneKey);
    });
  },

  // 占有细胞在 overlay.zones 中的颜色序号（质心重合的跟随细胞没有分区颜色）
  _zoneColorIndex(key) {
    const ov = this.zonesResult && this.zonesResult.zones && this.zonesResult.zones.overlay;
    if (!ov) return null;
    const idx = ov.zones.findIndex((x) => x.key === key);
    return idx < 0 ? null : idx;
  },

  // 表格行选择：与快照高亮联动
  selectZoneKey(key) {
    if (!this.zonesResult) return;
    this.zonesSelectedKey = this.zonesSelectedKey === key ? null : key;
    this.renderZonesResult();
    if (this.detailView) this.detailView.render();
  },

  // 快照点击选择：点中分区则选中该占有细胞（再点同一分区取消）；点空白清空选择
  selectZoneOnCanvas(key) {
    if (!this.zonesResult) return;
    this.zonesSelectedKey = (key && key !== this.zonesSelectedKey) ? key : null;
    this.renderZonesResult();
    if (this.detailView) this.detailView.render();
  },

  clearZonesOverlay() {
    this.zonesResult = null;
    this.zonesSelectedKey = null;
    document.getElementById('rp-zones-result').innerHTML =
      '<p class="hint">输入视野 id 或名称后点「分析责任区」。</p>';
    document.getElementById('rp-zones-clear').classList.add('hidden');
    if (this.detailView) this.detailView.render();
  },

  // ---------- 接触簇分析（发布时冻结；阈值仅影响本次查询，不写回报告） ----------

  async runContactAnalysis() {
    if (!this.contactReportId) return;
    const resEl = document.getElementById('rp-contact-result');
    const raw = document.getElementById('rp-contact-threshold').value.trim();
    resEl.innerHTML = '<p class="hint">计算中…</p>';
    try {
      // 阈值合法性由服务端最终判定（负数/非有限数 → 400），空输入按无效处理
      const result = await API.reportContacts(this.contactReportId, raw === '' ? NaN : Number(raw));
      if (!result || result.reportId !== this.contactReportId) return; // 期间已切换报告
      this.contactResult = result;
      this.contactClusterId = null;
      this.contactHighlight = null;
      this.renderContactResult();
    } catch (e) {
      this.contactResult = null;
      this.contactClusterId = null;
      this.contactHighlight = null;
      resEl.innerHTML = `<p class="merge-error">${this.esc(e.message)}</p>`;
      document.getElementById('rp-contact-clear').classList.add('hidden');
    }
    if (this.detailView) this.detailView.render();
  },

  renderContactResult() {
    const resEl = document.getElementById('rp-contact-result');
    const clearBtn = document.getElementById('rp-contact-clear');
    const r = this.contactResult;
    if (!r) return;

    let html = `<p class="hint">阈值 <b>${r.thresholdUm}</b> μm（发布时冻结数据，1 px = ${r.scaleUmPerPx} μm）：` +
      `细胞 ${r.cellCount} 个 · 邻接对 ${r.pairCount} 个 · 连通簇 ${r.clusterCount} 个` +
      `（多细胞簇 ${r.multiCellClusterCount} 个）。结果不写回报告。</p>`;
    if (r.pairCount === 0) {
      html += `<p class="hint">阈值内没有邻接关系：${r.cellCount} 个细胞各自成独立簇。</p>`;
    }

    // 连通簇列表：点击在报告快照上高亮该簇（再点一次取消）
    html += '<div class="cluster-list">';
    r.clusters.forEach((c) => {
      const names = c.cells.map((x) => this.esc(x.name)).join('、');
      const active = this.contactClusterId === c.id ? ' active' : '';
      html += `<div class="cluster-row${active}" data-cluster="${c.id}">` +
        `<b>簇 ${c.id + 1}</b> · ${c.size} 个细胞<span class="cluster-names">${names}</span></div>`;
    });
    html += '</div>';

    // 每个细胞的阈值内邻居与最短净区域间距
    const rows = r.cells.map((c) => {
      const nbrs = c.neighbors.length
        ? c.neighbors.map((n) => `${this.esc(n.name)}（${this.fmt(n.distanceUm)}）`).join('、')
        : '—';
      return `<tr><td>${this.esc(c.name)}</td><td>${nbrs}</td>` +
        `<td>${c.shortestUm === null ? '—' : this.fmt(c.shortestUm)}</td></tr>`;
    }).join('');
    html += `<table class="measure compact"><thead><tr>` +
      `<th>细胞</th><th>阈值内邻居（净区域间距 μm）</th><th>最短净区域间距 μm</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`;

    resEl.innerHTML = html;
    clearBtn.classList.toggle('hidden', this.contactClusterId === null);
    resEl.querySelectorAll('.cluster-row').forEach((row) => {
      row.onclick = () => this.selectContactCluster(Number(row.dataset.cluster));
    });
  },

  // 选中/取消某个簇：在报告快照画布上高亮其全部细胞
  selectContactCluster(id) {
    if (!this.contactResult) return;
    if (this.contactClusterId === id) {
      this.contactClusterId = null;
      this.contactHighlight = null;
    } else {
      this.contactClusterId = id;
      const c = this.contactResult.clusters.find((x) => x.id === id);
      this.contactHighlight = new Set(c ? c.cellKeys : []);
    }
    this.renderContactResult();
    if (this.detailView) this.detailView.render();
  },

  clearContactHighlight() {
    this.contactClusterId = null;
    this.contactHighlight = null;
    this.renderContactResult();
    if (this.detailView) this.detailView.render();
  },

  fmt(v) {
    if (v === null || v === undefined) return '—';
    if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(3);
    return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  }
};

window.Reports = Reports;
