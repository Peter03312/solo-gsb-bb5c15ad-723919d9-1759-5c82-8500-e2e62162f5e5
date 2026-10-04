'use strict';

// 同切片两报告 · 单视野细胞覆盖变化核对页
//
// 只读查询 /api/reports/field-coverage-diff；结果中的 regionLoops / boundaryEdges
// 直接画在基线报告图片快照上的 SVG 叠加层里，逐类独立开关填充与边界，
// 图形与数值同源（服务端平面排列），四类面积之和等于视野净面积。

const CoverageDiffView = {
  reports: null,
  lastResult: null,
  visible: {
    common: { fill: true, border: true },
    retest: { fill: true, border: true },
    baseline: { fill: true, border: true },
    never: { fill: true, border: true },
    fieldOutline: true
  },

  async open() {
    document.getElementById('covdiff-error').classList.add('hidden');
    const resultEl = document.getElementById('covdiff-result');
    resultEl.classList.add('hidden');

    if (!this.reports) {
      await this.loadReports();
    } else {
      this.fillReportSelects();
    }
  },

  async loadReports() {
    const bSel = document.getElementById('covdiff-baseline');
    const rSel = document.getElementById('covdiff-retest');
    bSel.innerHTML = '<option>加载中…</option>';
    rSel.innerHTML = '';
    let reports;
    try {
      reports = await API.listReports();
    } catch (e) {
      bSel.innerHTML = '';
      this.showError(`报告列表加载失败：${e.message}`);
      return;
    }
    // 列表按发布时间倒序返回；选择器保持该顺序，并标注更正链位置
    this.reports = reports;
    this.fillReportSelects();
  },

  reportOption(r) {
    const chain = r.isChainTip ? '' : '（更正链历史）';
    const scale = r.calib && typeof r.calib.scale === 'number'
      ? ` · 1px=${Number(r.calib.scale).toFixed(4)}μm` : '';
    return `《${r.title}》 v${r.draftVersion} · ${r.filename} · 细胞 ${r.cells.length} · 视野 ${(r.fields || []).length}${scale}${chain}`;
  },

  fillReportSelects() {
    const bSel = document.getElementById('covdiff-baseline');
    const rSel = document.getElementById('covdiff-retest');
    const prevB = bSel.value;
    const prevR = rSel.value;
    bSel.innerHTML = '';
    rSel.innerHTML = '';
    this.reports.forEach((r) => {
      const o1 = document.createElement('option');
      o1.value = r.id;
      o1.textContent = this.reportOption(r);
      bSel.appendChild(o1);
      const o2 = o1.cloneNode(true);
      rSel.appendChild(o2);
    });
    if (prevB && this.reports.some((r) => r.id === prevB)) bSel.value = prevB;
    if (prevR && this.reports.some((r) => r.id === prevR)) rSel.value = prevR;
    this.onBaselineChange();
  },

  onBaselineChange() {
    const bSel = document.getElementById('covdiff-baseline');
    const fSel = document.getElementById('covdiff-field');
    fSel.innerHTML = '';
    const baseline = this.reports.find((r) => r.id === bSel.value);
    if (!baseline) {
      fSel.innerHTML = '<option>基线报告无冻结视野</option>';
      fSel.disabled = true;
      return;
    }
    const fields = baseline.fields || [];
    if (!fields.length) {
      fSel.innerHTML = '<option>该基线报告没有冻结取样视野</option>';
      fSel.disabled = true;
      return;
    }
    fSel.disabled = false;
    const conflictGroups = window.MergeStats.duplicateFieldIdGroups(fields);
    fields.forEach((f, i) => {
      const o = document.createElement('option');
      o.value = f.id;
      const name = (f.name && String(f.name).trim()) || `视野 ${i + 1}`;
      const g = conflictGroups.get(f.id);
      const suffix = g ? ` ⚠ id冲突(${g.map((k) => k + 1).join('/')})，请改用唯一名称输入` : '';
      o.textContent = `${name}（id ${f.id}）${suffix}`;
      fSel.appendChild(o);
    });
  },

  showError(msg) {
    const el = document.getElementById('covdiff-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  async run() {
    document.getElementById('covdiff-error').classList.add('hidden');
    const baselineReportId = document.getElementById('covdiff-baseline').value;
    const retestReportId = document.getElementById('covdiff-retest').value;
    const fieldId = document.getElementById('covdiff-field').value;

    if (!fieldId || document.getElementById('covdiff-field').disabled) {
      this.showError('请先选择一份带有冻结取样视野的基线报告');
      return;
    }

    let result;
    try {
      result = await API.reportFieldCoverageDiff({ baselineReportId, retestReportId, fieldId });
    } catch (e) {
      // 400/404/500 均直接展示服务端明确报错；不改动任何页面选择
      this.showError(e.message);
      document.getElementById('covdiff-result').classList.add('hidden');
      return;
    }
    this.lastResult = result;
    this.render(result);
  },

  render(result) {
    const { baseline, retest, diff, matchedBy } = result;
    document.getElementById('covdiff-result').classList.remove('hidden');

    const meta = document.getElementById('covdiff-meta');
    meta.innerHTML = `
      <div><b>基线报告：</b>《${baseline.title}》 v${baseline.draftVersion}
        （${baseline.createdAt}，1 px = ${baseline.scaleUmPerPx} μm）
        ${baseline.correctsReportId ? '· 更正链历史报告' : ''}</div>
      <div><b>复测报告：</b>《${retest.title}》 v${retest.draftVersion}
        （${retest.createdAt}，1 px = ${retest.scaleUmPerPx} μm）
        ${retest.correctsReportId ? '· 更正链历史报告' : ''}</div>
      <div><b>同一切片：</b>${baseline.imageId} ｜ <b>基线视野：</b>${diff.fieldName || '(未命名)'}
        （按${matchedBy === 'id' ? 'id' : '名称'}匹配，孔洞 ${diff.fieldHoles} 个）</div>`;

    const note = document.getElementById('covdiff-scale-note');
    note.textContent = `标尺换算：${diff.scale.note}`;
    note.classList.toggle('warn', !diff.scale.same);

    this.renderTable(diff);
    this.renderToggles(diff);
    this.loadSnapshot(baseline.snapshotUrl, baseline.width, baseline.height);
  },

  renderTable(diff) {
    const head = `
      <tr>
        <th>类别</th>
        <th>像素面积 (px²)</th>
        <th>占视野净面积</th>
        <th>物理面积 (mm²)</th>
      </tr>`;
    const rows = diff.classOrder.map((k) => {
      const c = diff.classes[k];
      return `
        <tr>
          <td><span class="covdiff-swatch" style="background:${c.color}"></span>${c.label}</td>
          <td>${this.fmtPx(c.areaPx)}</td>
          <td>${c.percentText}</td>
          <td>${c.areaText}</td>
        </tr>`;
    }).join('');
    const sumRow = `
      <tr class="covdiff-sum">
        <td>四类合计（＝视野净面积）</td>
        <td>${this.fmtPx(diff.sumAreaPx)}</td>
        <td>${diff.sumPercent}%</td>
        <td>${diff.fieldAreaText}</td>
      </tr>`;
    document.getElementById('covdiff-table').innerHTML =
      `<table>${head}${rows}${sumRow}</table>`;
  },

  fmtPx(v) {
    // 像素面积保留 4 位小数（消除配平残差显示噪声）
    return String(Math.round(v * 10000) / 10000);
  },

  renderToggles(diff) {
    const bar = document.getElementById('covdiff-toggles');
    bar.innerHTML = '';
    diff.classOrder.forEach((k) => {
      const c = diff.classes[k];
      const make = (kind, label, checked) => {
        const id = `covdiff-${k}-${kind}`;
        const wrap = document.createElement('label');
        wrap.className = 'covdiff-toggle';
        wrap.innerHTML =
          `<input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />` +
          `<span class="covdiff-swatch" style="background:${c.color};` +
          `${kind === 'border' ? 'background:#fff;border:2px solid ' + c.color : ''}"></span>${label}`;
        wrap.querySelector('input').addEventListener('change', (e) => {
          this.visible[k][kind] = e.target.checked;
          this.paint();
        });
        bar.appendChild(wrap);
      };
      make('fill', `${c.label}区域`, this.visible[k].fill);
      make('border', `${c.label}边界`, this.visible[k].border);
    });
    const fieldWrap = document.createElement('label');
    fieldWrap.className = 'covdiff-toggle';
    fieldWrap.innerHTML =
      `<input type="checkbox" id="covdiff-field-outline" ${this.visible.fieldOutline ? 'checked' : ''} />` +
      `<span class="covdiff-swatch" style="background:#fff;border:2px dashed #111"></span>视野净区域边界`;
    fieldWrap.querySelector('input').addEventListener('change', (e) => {
      this.visible.fieldOutline = e.target.checked;
      this.paint();
    });
    bar.appendChild(fieldWrap);
  },

  loadSnapshot(url, width, height) {
    const img = document.getElementById('covdiff-img');
    const svg = document.getElementById('covdiff-svg');
    img.onload = () => this.paint();
    img.src = url;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
  },

  // 构造一个类的填充 path：全部圈作为子路径，fill-rule="nonzero"
  // 外边界 CCW、孔洞 CW，绕数自动扣孔；图形与服务端面积同源。
  loopsPath(loops) {
    return (loops || []).map((ring) => {
      if (!ring.length) return '';
      return 'M' + ring.map((p) => `${p.x},${p.y}`).join(' L') + ' Z';
    }).join(' ');
  },

  paint() {
    const result = this.lastResult;
    const svg = document.getElementById('covdiff-svg');
    if (!result || !svg) return;
    const diff = result.diff;

    // 以字段 id 为 key 的图层（重建，避免 toggle 残留）
    const NS = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';

    // 视野净区域边界（外环 + 孔洞，虚线）
    if (this.visible.fieldOutline) {
      // 从各类边界里恢复视野边界：between 含 null 的边即视野外/孔边界
      const seen = new Set();
      const g = document.createElementNS(NS, 'g');
      diff.classOrder.forEach((k) => {
        diff.classes[k].boundaryEdges.forEach((e) => {
          if (e.between[0] !== null && e.between[1] !== null) return;
          const key = `${e.a.x}|${e.a.y}|${e.b.x}|${e.b.y}`;
          if (seen.has(key)) return;
          seen.add(key);
          const line = document.createElementNS(NS, 'line');
          line.setAttribute('x1', e.a.x);
          line.setAttribute('y1', e.a.y);
          line.setAttribute('x2', e.b.x);
          line.setAttribute('y2', e.b.y);
          line.setAttribute('stroke', '#111');
          line.setAttribute('stroke-width', '1.2');
          line.setAttribute('stroke-dasharray', '6 4');
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          g.appendChild(line);
        });
      });
      svg.appendChild(g);
    }

    // 各类填充
    diff.classOrder.forEach((k) => {
      if (!this.visible[k].fill) return;
      const c = diff.classes[k];
      if (!c.regionLoops.length) return;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', this.loopsPath(c.regionLoops));
      path.setAttribute('fill', c.color);
      path.setAttribute('fill-rule', 'nonzero');
      path.setAttribute('fill-opacity', k === 'never' ? '0.25' : '0.45');
      svg.appendChild(path);
    });

    // 各类边界（between 两类都非空的内部类分界，以及视野边界已单列；
    // 这里按勾选项再叠加各色实线边界，确保“边界”可独立切换）
    diff.classOrder.forEach((k) => {
      if (!this.visible[k].border) return;
      const c = diff.classes[k];
      const g = document.createElementNS(NS, 'g');
      const seen = new Set();
      c.boundaryEdges.forEach((e) => {
        const key = `${e.a.x}|${e.a.y}|${e.b.x}|${e.b.y}`;
        if (seen.has(key)) return;
        seen.add(key);
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', e.a.x);
        line.setAttribute('y1', e.a.y);
        line.setAttribute('x2', e.b.x);
        line.setAttribute('y2', e.b.y);
        line.setAttribute('stroke', c.color);
        line.setAttribute('stroke-width', '1.6');
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        g.appendChild(line);
      });
      svg.appendChild(g);
    });
  },

  bindUI() {
    document.getElementById('covdiff-run').addEventListener('click', () => this.run());
    document.getElementById('covdiff-baseline').addEventListener('change', () => this.onBaselineChange());
  }
};

window.CoverageDiffView = CoverageDiffView;
