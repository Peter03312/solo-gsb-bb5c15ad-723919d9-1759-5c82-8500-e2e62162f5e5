# 🌿 PhytoMeasure · 植物显微切片测量 Web 应用

在浏览器中上传植物显微切片图片，完成像素—微米定标后，圈选多个细胞的外轮廓及其孔洞，
自动计算**扣除孔洞后的净面积（μm²）**与**含孔洞边界的总周长（μm）**；
还可圈定多个**命名取样视野**（外环 + 可选孔洞），按细胞净区域质心统计各视野的
**细胞数、净面积（mm²）与每 mm² 细胞密度**；并可对**同一草稿/报告内至少两个视野**
按其净区域**几何并集**查看**合并统计**（并集面积、去重细胞数、密度与计入净面积总和）；
可发布为不可变报告、导出**标注 PNG**、**测量 CSV** 与**视野统计 CSV**；
并支持把一份已发布报告的全部细胞经**三点对应仿射变换**整体迁移到另一张切片草稿；
对已发布报告还可基于**同一切片的当前草稿**发起**更正**：生成新的不可变报告与图片快照、
记录更正原因并串成**更正链**，列表展示每条链的当前有效报告、原因与历史，历史报告按原标识永久可查；
还可在报告详情输入**间距阈值（μm，允许 0）**做**细胞接触簇分析**：按冻结轮廓与定标计算
细胞两两**净区域最短间距**、阈值内邻居与**连通簇**，并在报告快照上**高亮**所选簇；
并可对报告内**单个取样视野**做**网格密度分析**：把视野外接矩形等分为 **行×列（各 1～40）** 网格，
按格子与视野净区域的**几何交集**给出每格有效面积、按净区域质心把计入该视野的细胞分配到唯一格子，
输出各格**细胞数与每 mm² 密度**（零面积格标「不可计算」）并在冻结快照上叠加网格；
还可对报告内**单个取样视野**查看**最近质心责任区**：把视野**净区域**按**像素欧氏距离**分给
最近的**计入细胞**（沿用净区域质心与视野严格归属规则），返回每个细胞的**实际分区几何、
像素/mm² 面积与占比**（有计入细胞时各区合计＝视野净面积；等距边界不计面积；质心重合按报告
细胞顺序由首个占有、其余保留零面积记录），并可在冻结快照上点击分区查看。
整批保存视野前校验**本批视野 id 唯一**（冲突指出位置并整批拒绝、版本与修订不变）；
修复前遗留的重复 id 草稿/修订/已发布报告**不被静默改写**，按冲突 id 的合并统计与
单视野分析（覆盖核对/网格密度/责任区/覆盖变化核对）**明确拒绝**，按**唯一名称**仍可选中对应视野；
编辑页标明冲突视野并可按现有版本校验修正当前草稿（成功后追加正常修订），旧报告保持冻结只读。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 原生 Canvas 前端
- 图片与数据**全部本地保存**（无任何外部服务依赖）：
  - 数据库：`data/app.db`
  - 原始图片：`data/images/`
  - 发布时的图片快照：`data/snapshots/`
  - 标注 PNG / CSV 在导出时实时生成
  - 接触簇分析为**只读实时计算**，不落盘

## 功能说明

1. **图片上传**：支持 PNG / JPEG / WebP（≤ 30 MB），读取真实像素尺寸。
2. **标尺定标**：在原图上点选**两个不同的像素点**，输入它们的实际微米距离，
   得到每像素微米数（μm/px）。两点重合、坐标越界、距离非正数均会被拒绝，且整次修改不生效。
3. **细胞轮廓**：可圈选多个细胞外轮廓，每个细胞可包含多个孔洞。
   - 轮廓不得**自交/自接触**，顶点不得**越出图片**；
   - 孔洞必须**严格位于**所属外轮廓内部（不能贴着外轮廓边界）；
   - 同一细胞的孔洞之间**不得接触或重叠**；
   - 任意一个对象不合法时，服务端会指出具体细胞/孔洞编号与原因，**整批轮廓保存不生效**。
4. **测量结果**：
   - 净面积 =（外轮廓面积 − 全部孔洞面积）× (μm/px)²，单位 **μm²**；
   - 总周长 =（外轮廓周长 + 全部孔洞周长）× μm/px，单位 **μm**；
   - 缩放、平移视图只改变显示，不改变任何测量值。
5. **重新定标**：草稿中的所有轮廓立即按新比例重算测量值，所有视野统计同步重算。
6. **取样视野 · 细胞密度统计**：可在同一张切片上圈定**多个命名视野**，每个视野由
   一个不自交外环与**可选孔洞**构成（孔洞必须严格位于外环内、彼此不得接触或重叠）。
   - 归属规则：以每个细胞**扣除孔洞后的净区域质心**判定——质心**严格**落在某视野净区域
     （严格在外环内、且不在视野孔洞内/边界上）才计入；落在**边界不计入**；
   - 视野之间**允许重叠**，重叠处的细胞在每个视野中**分别计数（可重复计数）**；
   - **净面积为零的细胞**没有良定义质心，不计入任何视野；
   - **已定标**时展示各视野：净面积（**mm²**）、细胞数、**每 mm² 细胞密度**、
     计入细胞的净面积总和（mm²）；**未定标**时保留视野与细胞数，面积/密度/总和显示
     **「待定标」**；
   - 细胞轮廓变动、视野变动或重新定标后统计**自动重算**；
   - 整批原子保存：视野越界、自交、孔洞不严格位于外环内或彼此接触重叠、净面积非正时
     **整批视野保存不生效**，服务端指出具体视野编号与原因；
   - **本批视野 id 必须唯一**：保存前若有两个不同视野共用同一 id，服务端指出冲突 id 与
     具体位置（第几个视野、名称）并**整批拒绝**（HTTP 400），**不写入、不推进版本、不留修订**；
   - 视野保存同样走草稿乐观版本号，版本过期返回 HTTP 409，页面自动拉取最新草稿。
   - **身份歧义修复（历史数据兼容）**：修复前保存的**重复 id 草稿、历史修订与已发布报告**
     一律**不被静默改写**——它们保持冻结/原样可读、可导出（旧报告只读）；基于重复 id 的
     **合并统计与单视野分析**（覆盖核对、网格密度、最近质心责任区、覆盖变化核对）一律
     **明确拒绝（HTTP 400，并列出冲突位置）**，按**唯一名称**查询仍正常选中对应视野；
     **id 始终优先于名称**，名称重名仍按原契约报错。编辑页会用 ⚠ 标明冲突视野，可用
     「更换 id」后**按现有版本校验整批保存**（成功后追加一条正常 fields 修订）；
     含重复 id 的草稿不能发布或发起更正（HTTP 400），修正后发布/更正恢复正常；
     恢复含重复 id 的历史修订是允许的显式操作，恢复后同样可按上述方式修正。
7. **发布与乐观并发**：
   - 发布会冻结当时的**图片副本、标尺、细胞轮廓、取样视野与全部统计结果**（含视野密度统计），
     之后修改草稿（含删除/重画视野）不影响已发布报告；
   - 发布请求必须携带**读取时的草稿版本号**；期间草稿被改动（版本过期）时请求被拒绝（HTTP 409），
     页面会自动拉取最新草稿，需确认后重新发布。
8. **导出**：在「已发布报告」页勾选报告，可导出
   - 单份或多份合并的**测量 CSV**（UTF-8 BOM，Excel 直接可读，含义保持不变）；
   - 单份报告的**视野统计 CSV**（与报告页表格为**同一份冻结结果**；旧报告无视野时仅表头+空提示）；
   - 单份**标注 PNG**（彩色细胞轮廓、红色虚线孔洞、细胞编号与青色标尺）；
   - 多份报告的 **ZIP**（每份一张标注 PNG + 一份 CSV，外附汇总 CSV）。
9. **报告比较（基线 ↔ 复测）**：在「报告比较」页选择**两份不同**的已发布报告，
   先点基线侧一个细胞、再点复测侧一个细胞，**手动**建立一对一配对
   （**同名细胞不会自动配对**；已配对细胞从两侧待选列表移除，可随时「解除」）。
   - 比较只读取两份报告**冻结的定标与测量值**：每对细胞给出净面积、总周长的
     **两侧数值、带符号差值（复测 − 基线）与相对基线变化率**；未配对细胞在两侧分别列出。
   - 基线值为 **0** 时变化率显示 / 导出为 **「不可计算」**（差值仍给出）。
   - 保存校验整批原子生效：**报告不存在、两侧相同、配对重复（同一细胞出现多次）、
     细胞不存在**任一种情况都会被拒绝，**整次保存不生效**。
   - 修改比较记录必须携带**读取时版本号**；期间被他人改动（版本过期）时返回 HTTP 409
     与当前版本，页面自动加载最新版本，过期修改不写入。
   - 可导出与页面分区、数值完全一致的**比较 CSV**（UTF-8 BOM）。
   - 比较记录保存后即与草稿、后续发布解耦：**草稿后续改动或另发新报告都不改变已存比较**；
     比较记录创建时选定的两份报告不可更换。
10. **细胞迁移（三点对应仿射变换）**：在切片编辑页选择一份**已发布报告**作来源，
    在来源快照与当前草稿大图上按**相同顺序各标记 3 个不共线对应点**，
    把来源全部细胞的外轮廓与孔洞经仿射变换映射到当前草稿。
    - **预览先行**：服务端按同一变换映射全部细胞并**逐个套用与「保存轮廓」相同的几何校验**
      （越界/自交/孔洞不严格在外轮廓内/孔洞互触），页面在大图上以虚线叠加映射结果并列出
      每个细胞的校验结论；**任一细胞不合法即禁止提交**；
    - 对应点**重合、共线、坐标越界**（任一侧）都会被拒绝并指出具体原因；
      **来源无细胞、来源报告或目标草稿不存在**时明确报错；
    - **确认迁移必须携带预览时读取的目标草稿版本**；期间草稿被改动（版本过期）时
      拒绝写入（HTTP 409）并提示刷新，页面自动拉取最新草稿，需重新预览；
    - 成功后映射细胞**追加**到目标现有细胞之后：生成**不冲突的新标识**、**保留来源名称**、
      按**目标标尺**重算测量值，取样视野统计随细胞变动自动重算；
    - **来源报告、目标原有细胞与标尺、全部已发布报告均不改变**；
      预览与提交使用同一变换与校验，任何失败**整批不写入**。
11. **多视野合并统计（几何并集）**：在**切片编辑页**与**已发布报告页**，勾选
    **同一草稿/报告内至少两个**取样视野，即可查看所选视野的合并统计。
    - 面积按所选视野**净区域（外环扣除孔洞）的几何并集**精确计算（重叠区域只算一次），
      视野贴合处不留缝隙；
    - 归属规则：细胞以其**扣除孔洞后的净区域质心**判定，质心**严格位于并集内部**才计入——
      两个视野的贴合接缝属于并集内部（计入），并集**外边界不计入**，全部视野共有的孔洞
      不属于并集（不计入）；一个视野孔洞内但被另一视野覆盖的点仍属于并集；
    - **同一细胞只计一次**（即使它落在多个视野重叠区域）；净面积为零的细胞没有良定义质心，不计入；
    - 展示**并集面积（mm²）、细胞数、每 mm² 细胞密度、计入细胞的净面积总和（mm²）**；
      **未定标**时保留细胞数，面积/密度/总和显示**「待定标」**；
    - 草稿侧为**只读实时计算**：细胞轮廓、视野或标尺改变后按当前数据重算；
      报告侧**只读取发布时冻结数据**，草稿后续改动不影响结果；
    - **选择不足两个视野、视野标识重复、视野标识不存在**都会被明确拒绝（HTTP 400）；
      **本数据存在同批重复 id（修复前遗留）且所选 id 命中歧义**时同样明确拒绝（HTTP 400，
      列出共用该 id 的视野位置），不静默取“后一个”；
      合并统计**不写库、不改变**任何原有逐视野统计与报告内容。
12. **单视野细胞覆盖核对（几何交集，只读）**：在**切片编辑页**与**已发布报告页**输入
    **视野标识（视野 id 或名称）**，核对细胞标注对该视野的覆盖情况，返回**视野净面积、
    细胞覆盖面积、未覆盖面积与覆盖率**。
    - 覆盖面积按**细胞净区域（外环扣除孔洞）与视野净区域（外环扣除孔洞）的几何交集**
      精确计算（平面排列/半边缘遍历，非面积简单加减）：**跨越视野边界的细胞只计内部部分**；
      **多个细胞相互重叠只计一次**；细胞孔洞、视野孔洞与**仅边界接触（零面积）不贡献**；
    - **刻意不沿用按质心计数的密度规则**：质心在视野外的跨边界细胞仍按内部面积计入，
      质心在视野内的细胞也只计交集而非整个细胞；
    - **未定标草稿**照常给出**像素面积（px²）与覆盖率**，物理面积（mm²）显示
      **「待定标」**；
    - 草稿侧按**当前轮廓、视野与标尺实时计算**（含页面未保存的工作副本）；报告侧
      **只使用发布时冻结数据**——后续草稿修改或报告更正**不改变旧报告结果**；
    - **视野标识为空、不存在、不属于指定切片/报告**都明确报错（HTTP 400）；
      同名视野无法唯一确定时提示改用 id；
      **视野 id 在本数据中被多个视野共用（修复前遗留的身份歧义）时明确拒绝（HTTP 400，
      列出冲突位置）**，不静默取“第一个”；此时改用**唯一名称**查询仍选中对应视野；
      核对为**只读**：不改动草稿、修订与报告。
13. **报告更正链（同一切片、当前草稿、不可变新版本）**：在「已发布报告」中打开一份
    **当前有效报告**（链末端），可用**同一切片的当前草稿**发起更正并填写**更正原因**。
    - 提交必须携带**所选报告标识**、**读取时的草稿版本号**与**读取时的更正链末端标识**；
      仅当所选报告**仍是链末端**、草稿版本未变、且草稿**通过既有发布校验**
      （已定标、至少一个细胞、测量值已按当前标尺计算）时，才复制**新的图片快照**并
      生成**新的不可变报告**，以 `correctsReportId` 指向前一份报告、记录更正原因；
    - 草稿版本或链末端在期间发生变化 → **HTTP 409**，并返回**最新草稿版本、当前链末端
      与最新草稿**，页面自动刷新后需重新提交；
    - **更正原因为空白、报告或草稿不存在、所选草稿与报告不是同一切片**都明确报错
      （400 / 404）；任何失败都**不会留下**新报告记录或图片快照；
    - 「已发布报告」列表**按更正链**展示：每条链只显示**一份当前有效报告（链末端）**、
      **最近更正原因**与**历史版本**（可展开，历史报告按原标识打开）；普通发布各自成链；
    - **历史报告永不改变，仍可按原标识读取、导出（PNG/CSV/ZIP）**；既有的报告读取、
      导出、以及已保存的**报告比较**记录对旧标识继续使用原冻结内容；**普通发布行为完全不变**。
14. **细胞接触簇分析（间距阈值，只读）**：在报告详情页输入**间距阈值（微米，允许 0）**，
    按该报告**发布时冻结的轮廓与定标**分析细胞在空间上形成的接触簇。
    - 距离取两个细胞**外轮廓扣除孔洞后的净区域**之间的最短间距：净区域**重叠或边界接触
      时为 0**；一个细胞**仅落在另一细胞孔洞内且未触及其净区域**时**不视为接触**
      （间距为其到孔洞边界的距离，> 0）；
    - 结果给出**每个细胞阈值内的邻居及其最短净区域间距**、由邻接关系连通而成的**簇列表**；
      点击某个簇即在**报告快照上高亮**该簇全部细胞（再点一次或「清除高亮」取消）；
    - **没有邻接关系时每个细胞各自成独立簇**；
    - 分析**只读**：阈值仅影响本次查询，**不写回报告**；草稿后续修改或报告更正都
      **不改变**旧报告的分析结果；报告不存在 → 404，阈值为负或非有限数 → 400。
15. **草稿修订时间线与恢复（切片编辑页）**：每次**成功写入**草稿的操作——
    **标尺定标、轮廓保存、视野保存、细胞迁移确认**——都在同一事务内追加一条
    **完整一致、只追加不可变的修订**（完整快照当时的标尺、细胞轮廓与取样视野）；
    上传的切片以空状态建立**基线修订**，修订功能上线前已存在的旧草稿在服务启动时
    **以当前状态补建一条可恢复基线**（幂等，不重复补建）。**校验失败的请求不留任何记录**。
    - 编辑页 **⑨ 草稿修订时间线** 面板由新到旧列出全部修订（类型、序号、当时草稿版本、
      是否定标、细胞/视野数、时间与说明）；
    - 点 **预览**：右侧画布以**只读**方式叠加该修订的**标尺、细胞轮廓与取样视野**，
      面板同时给出按**该修订标尺**计算的细胞测量与视野统计；预览不触碰当前草稿与未保存绘制，
      可随时「退出预览」或在多个修订间切换；
    - 点 **恢复为当前草稿**：必须携带**读取时的草稿版本号**；期间草稿被改动（版本过期）时
      返回 **HTTP 409 与当前版本**、页面自动刷新，**修订不存在或不属于该切片**返回 **404**、
      缺少版本号返回 **400**，任何失败**都不写入**；
    - 恢复成功会**生成新版本与一条新的 `restore` 修订**（记录来源修订序号），
      **后来的历史一条都不抹掉**；草稿的标尺/轮廓/视野整体替换为目标快照，并
      **按恢复的标尺重算全部细胞测量与视野统计**；
    - 恢复只作用于草稿：**已发布报告与更正链完全不受影响**（发布只推进草稿版本、不产生修订）；
    - 有**未保存的轮廓/视野绘制**时，恢复会弹出确认；离开编辑页、切换切片或刷新/关闭页面
      前同样会先提示确认丢弃未保存绘制。
16. **同切片两报告 · 单视野细胞覆盖变化核对（只读）**：顶部导航「覆盖变化核对」。
    选择**同一切片**的两份**不同已发布报告**（可取同一更正链中的历史报告与链末端），
    指定**基线报告冻结的一个取样视野**，核对该视野内两次细胞标注的覆盖变化。
    - 按两份报告**冻结的细胞净区域**（外环扣除孔洞，**重叠细胞先取并集**）与**基线视野净区域**，
      用平面排列把视野**精确**分为互不重叠的四类：
      <span style="color:#2e7d32">**共同覆盖**</span>、<span style="color:#1565c0">**仅复测覆盖**</span>、
      <span style="color:#c62828">**仅基线覆盖**</span>、<span>**始终未覆盖**</span>；
      **跨越视野边界的细胞只计内部部分**，**细胞孔洞/视野孔洞与仅边界接触（零面积）不贡献面积**；
      **四类像素面积之和精确等于视野净面积**（结果同时返回合计校验值）；
    - 页面在**基线报告的图片快照**上以 SVG 叠加四类**实际区域与边界**，每一类的
      **填充与边界都可独立勾选切换**；叠加图形的多边形直接来自服务端平面排列，
      与表格数值同源（图形绕数面积 = 数值面积）；
    - 每类给出**像素面积 (px²)**、**占视野净面积比例 (%)**、以及按
      **基线报告冻结标尺**换算的**物理面积 (mm²)**；**两份报告标尺不同时**，
      结果与页面会同时给出两侧冻结标尺并明确提示「**一律以基线标尺为换算依据，复测标尺不参与换算**」；
    - 校验：**相同报告**、**不同切片**、**报告不存在**（基线/复测分别 400/404）、
      **基线视野不存在**（400）、**视野名称歧义**（重名，400，提示改用 id；id 始终优先精确匹配）
      均明确报错；**基线视野 id 被多个冻结视野共用（修复前遗留身份歧义）时也明确拒绝（400，
      列出冲突位置），按基线视野的唯一名称查询仍可选中对应视野**；查询**完全只读**，
      不写回任何报告，**草稿后续修改或再发更正都不改变旧报告核对结果**。
17. **报告单视野网格密度分析（行×列网格，只读）**：在报告详情页选择**本报告冻结的一个视野**，
    输入**行数 × 列数（各 1～40 的整数）**，把**视野外接矩形**等分为网格，查看视野内的细胞空间密度分布。
    - 每格**有效面积**为格子矩形与视野净区域（外环扣除孔洞）的**几何交集**，用平面排列
      （与合并统计/覆盖核对同一实现）精确计算；**零面积格保留**在结果中，其密度标为
      **「不可计算」**；各格有效面积之和等于视野净面积（结果含合计校验值）；
    - 细胞归属**沿用现有净区域质心规则**：只有质心严格落在该视野净区域内的细胞才参与分配，
      且每个计入细胞只进入质心所在的**唯一格子**；质心落在**内部网格线上归右侧/下侧**格子，
      落在**最外边线归末格**；**各格计数合计恒等于原视野统计的细胞数**（结果同时给出两者）；
    - 结果含每格的**像素有效面积 (px²)**、**物理有效面积 (mm²)**、**细胞数**、
      **每 mm² 密度**，以及视野净面积、各格面积/计数合计；报告快照上叠加**青色网格线、
      按密度着色的格子、计入细胞的净区域质心点**，点击结果表格行可在快照上定位该格；
    - 只读取报告**发布时冻结**的视野/细胞/标尺：**草稿后续修改或报告更正都不改变旧报告结果**；
      查询**只读**，不写回报告；**报告不存在 → 404**；
      **视野标识为空/不存在/重名 → 400**；
      **视野 id 被多个冻结视野共用（修复前遗留身份歧义）→ 400**（列出冲突位置，
      不静默取第一个；按唯一名称查询仍可用）；
      **行/列数缺失、非整数或越出 1～40 → 400**。
18. **报告单视野最近质心责任区（Voronoi，只读）**：在报告详情页选择**本报告冻结的一个视野**，
    查看视野净区域内每个计入细胞的**最近质心责任区**。
    - 只使用该报告**冻结的轮廓、视野和标尺**；细胞是否计入**沿用现有规则**——以细胞扣除孔洞后的
      **净区域质心**判定，质心**严格**落在视野净区域内（严格在外环内、不在任何孔洞内/边界上）才计入；
    - 视野**净区域**（外环扣除孔洞）内每个点按**像素欧氏距离**分给最近的计入细胞
      （Voronoi 半平面逐对求交 + 与视野净区域的平面排列精确求交）；
      **视野孔洞内部与视野外部一律不分配**；**等距边界（平分线）没有面积、不计入任何细胞**；
    - **质心重合**时按**报告细胞顺序**由首个细胞占有该位置，其余细胞**保留零面积记录**并注明占有者；
    - 返回每个细胞的**实际分区几何**（外圈/孔洞圈，直接可画）、**像素面积 (px²)**、
      **mm² 面积**（冻结标尺换算；未定标为「待定标」）与**占视野净面积比例 (%)**；
      **有计入细胞时各区面积合计恒等于视野净面积**（像素与 mm² 合计、占比合计 100% 均给出校验值）；
      **无计入细胞时返回空结果并提示**（视野净面积照常给出）；未计入细胞单列原因（质心在视野外部/
      孔洞/边界上，或净面积非正无良定义质心）；
    - 报告快照上叠加**各色责任区（孔洞透明）与计入细胞质心点**，**点击快照上的分区或结果表格行**
      可高亮定位（再点一次取消）；
    - 只读取报告**发布时冻结**的视野/细胞/标尺：**草稿后续修改或报告更正都不改变旧报告结果**；
      查询**只读**，不写回报告；**报告不存在 → 404**；视野标识 **id 优先精确匹配**，
      **视野标识为空/不存在/名称歧义（重名）→ 400**（重名提示改用 id）；
      **视野 id 被多个冻结视野共用（修复前遗留身份歧义）→ 400**（列出冲突位置，
      不静默取第一个；按唯一名称查询仍可用）。

## 配置项

本轮（视野 id 身份歧义修复）**未引入新的环境变量、外部依赖或表结构变更**：
唯一性校验在保存接口与各只读分析的标识解析中完成，历史重复 id 数据保持原样、不做迁移改写。
此前各轮的幂等迁移（`fields`、`corrects_report_id`、`correction_reason` 列）
在旧数据库启动时自动完成、无需手工变更。沿用既有配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器/服务监听端口 |
| `DATA_DIR` | `./data`（Docker 中为 `/app/data`） | SQLite、原始图片、快照的保存目录（比较记录、更正链关系同在 `app.db` 内） |
| `HOST_PORT` | `8080` | 仅 Compose 使用：宿主机映射端口 |

## 一条命令启动（Docker Compose）

```bash
docker compose up -d --build
```

启动后浏览器访问：

```
http://localhost:8080
```

若 8080 端口被占用：

```bash
HOST_PORT=8088 docker compose up -d --build
# 然后访问 http://localhost:8088
```

数据持久化在 Docker 命名卷 `phytomeasure-data` 中。
若希望直接在宿主机目录查看数据，可把 `docker-compose.yml` 中的卷改为绑定挂载：

```yaml
volumes:
  - ./data:/app/data
```

停止与查看日志：

```bash
docker compose down
docker compose logs -f
```

## 非 Docker 方式运行（需 Node.js ≥ 20）

```bash
npm install
npm start
# 访问 http://localhost:8080
```

## 使用步骤（网页操作）

1. 首页上传图片，自动进入编辑器；
2. 选择 **📏 定标点工具**，在图上单击两个点，在弹窗中输入实际距离（μm）；
3. 选择 **⭕ 画细胞外轮廓**：单击逐个加点，双击（或回车）闭合；
4. 在细胞列表中选中某个细胞，用 **🕓 为选中细胞画孔洞** 工具绘制其孔洞；
5. 点击 **保存全部轮廓**——若有非法轮廓/孔洞，顶部红条会指出具体对象，本次保存整体不生效；
6. 右侧测量表实时显示净面积与总周长，滚轮缩放、拖拽平移不影响数值；
7. 在 **③ 取样视野（细胞密度）** 面板选择 **🔲 画取样视野**，像画细胞一样圈出外环并
   **双击/回车**完成；在视野列表选中视野后可用 **🕓 为选中视野画孔洞**；可随时改名/删除；
8. 点击 **保存全部视野**——越界、自交、孔洞不严格位于外环内或互相接触重叠、净面积非正
   都会被拒绝并指出具体视野，整批不生效；**两个视野共用同一 id 同样整批被拒**，
   错误信息与③面板会标明冲突位置，可用列表中的「更换 id」修正后重新保存；
   保存后（及细胞轮廓变动/重定标后）
   **⑤ 视野细胞密度统计** 自动给出各视野净面积 mm²、细胞数、每 mm² 细胞密度与计入净面积总和；
   未定标时面积/密度显示「待定标」，细胞数仍可查看；
   修复前已保存的**重复 id 历史草稿/报告不会被改写**：编辑页与报告页以 ⚠ 标明冲突视野，
   按冲突 id 的分析会被明确拒绝（按唯一名称仍可查），当前草稿修正并重新保存后
   （追加正常修订）即可正常发布，旧报告保持冻结只读；
9. 点击 **发布当前草稿为报告**，在「已发布报告」中查看冻结快照，
   报告页展示与「视野统计 CSV」完全一致的冻结视野统计，并可导出 PNG / 测量 CSV / 视野统计 CSV；
   - 发布后若发现圈选有误：在**同一切片草稿**中修改并保存，打开该报告（需仍是
     **当前有效报告**），在「**发起更正**」面板确认读取到的草稿版本与链末端标识、
     填写**更正原因**后提交，即生成新的不可变报告；版本或链末端过期会提示并自动刷新；
   - 报告页顶部横幅标明「当前有效 / 历史」，「更正链 · 历史追溯」面板列出每一版与原因，
     历史版本标题可点开按原标识查看其冻结内容并导出；
10. 需要合并多个视野时，在编辑器 **⑥ 多视野合并统计**（或报告页「多视野合并统计」）面板
    **勾选至少两个视野**：立即给出所选视野净区域**几何并集**的净面积 mm²、细胞数、
    每 mm² 密度与计入细胞净面积总和；重叠处细胞只计一次，贴合接缝计入、并集外边界不计入；
    草稿侧随轮廓/视野/标尺实时重算，报告侧只显示发布时冻结结果；勾选不足两个或标识异常会明确拒绝；
11. 需要核对某个视野的细胞标注覆盖时，在编辑器 **⑦ 视野细胞覆盖核对（草稿实时）**
    （或报告页「视野细胞覆盖核对（发布时冻结）」）面板的输入框填入**视野 id 或名称**
    （输入框可用浏览器下拉补全当前视野）后点 **核对覆盖**：
    - 面板给出**视野净面积、细胞覆盖面积、未覆盖面积、覆盖率**，并列出有正面积交集的细胞；
    - 覆盖按**几何交集**计算（跨边界细胞只计内部、重叠只计一次、孔洞与仅边界接触不贡献），
      与⑤的质心密度规则相互独立；草稿侧含未保存修改时按当前工作副本实时重算；
    - **未定标草稿**仍显示像素面积与覆盖率，物理面积标注「待定标」；
    - 视野标识不存在、不属于当前切片/报告或重名时面板明确报错；核对不改动任何数据；
12. 需要对比两份报告时，进入 **报告比较**（流程不变，比较仍只读取冻结的细胞测量值）；
13. 需要把已发布报告的细胞搬到另一张切片时，在目标切片的编辑页打开 **⑧ 细胞迁移**：
    - 在下拉框选择**来源报告**（已发布），左侧出现来源快照；
    - 在来源快照上**依次单击 3 个对应点**（编号 1–3，自动连线提示顺序）；
    - 点 **🎯 标目标点工具**，在右侧大图上按**相同顺序**单击 3 个对应点
      （点错可「清除全部对应点」重标）；
    - 点 **预览迁移**：大图上以青色虚线叠加全部映射细胞（不合法细胞为红色），
      面板逐个列出校验结论；**任一细胞不合法或对应点重合/共线/越界都无法提交**；
    - 预览全部通过后点 **确认迁移**（携带预览时读取的草稿版本；若期间草稿被改动，
      会提示版本过期并自动刷新，需重新预览）；成功后映射细胞追加到细胞列表末尾，
      测量表与视野统计立即按当前标尺重算，可照常继续编辑、保存或发布。
14. 需要查看细胞接触簇时，打开**报告详情**，在「**接触簇分析（间距阈值）**」面板输入
    间距阈值（μm，允许 0）后点 **分析接触簇**：页面列出每个细胞阈值内的邻居与
    最短净区域间距、以及由邻接关系形成的连通簇；**点击某个簇**即在右侧报告快照上
    **高亮**该簇全部细胞（再点一次该簇或「清除高亮」取消）。结果只读取发布时冻结数据，
    阈值仅影响本次查看，不写回报告。
15. 需要查看或回到草稿的某个历史状态时，在切片编辑页打开 **⑨ 草稿修订时间线**：
    - 每次定标、保存轮廓、保存视野、确认迁移成功后都会新增一条修订（失败不留记录）；
    - 点某条修订的 **预览**：右侧画布只读叠加该修订的标尺、细胞轮廓与取样视野，
      面板显示按该修订标尺计算的测量与视野统计；再点 **退出预览** 返回当前编辑；
    - 点 **恢复为当前草稿**（当前内容对应修订的按钮自动禁用）：有未保存绘制时先确认丢弃，
      确认后携带读取时版本提交；若期间草稿被改动会提示版本过期并自动刷新时间线，
      重新选择修订后再恢复；成功后草稿版本与时间线新增一条恢复记录、原历史保留，
      测量与视野统计按恢复的标尺重算，已发布报告与更正链不受影响。
16. 需要查看单个视野内的细胞空间密度分布时，打开**报告详情**，在「**视野网格密度分析
    （发布时冻结）**」面板选择视野（id 或名称）、输入**行数 × 列数（各 1～40）**后点
    **分析网格密度**：面板列出每格有效面积（px²/mm²）、细胞数与每 mm² 密度
    （零面积格标「不可计算」），各格计数合计与原视野统计一并给出；
    右侧报告快照上叠加青色网格线、按密度着色的格子与计入细胞的质心点，
    点击结果表格中的某一行可在快照上定位该格（再点一次取消），「清除网格」移除叠加。
    结果只读取发布时冻结数据，草稿修改或报告更正都不改变本报告结果。
17. 需要查看视野净区域内每个细胞「离谁最近」的责任划分时，打开**报告详情**，在
    「**最近质心责任区（发布时冻结）**」面板选择视野（id 或名称）后点**分析责任区**：
    面板按报告细胞顺序列出每个计入细胞的责任区像素/mm² 面积与占比（质心重合而未占有的
    细胞保留零面积行），并单列未计入细胞及原因；右侧报告快照上叠加各色责任区与质心点，
    **直接点击快照上的分区**或点击表格行即可高亮定位（再点一次取消），「清除分区」移除叠加。
    有计入细胞时各区面积合计等于视野净面积；该视野没有任何计入细胞时返回空结果并提示。
    结果只读取发布时冻结数据，草稿修改或报告更正都不改变本报告结果。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   ├── index.js       # Express API：上传/定标/轮廓/视野/发布/导出/报告比较/细胞迁移/接触簇/修订时间线与恢复/网格密度/最近质心责任区
│   ├── db.js          # SQLite 表结构与初始化（启动自动建表 + 旧库幂等补列）
│   ├── geometry.js    # 几何校验、面积/周长、净区域质心（服务端最终校验）
│   ├── fields.js      # 取样视野：质心归属、mm²/密度统计、未定标“待定标”
│   ├── merge-stats.js # 多视野几何并集（平面排列精确面积）+ 严格并集内部判定 + 合并统计（服务端/页端共用 UMD）
│   ├── compare.js     # 报告比较：手动一对一配对校验、冻结值差值/变化率视图
│   ├── corrections.js # 报告更正链：原因校验、链构建/追溯摘要、发布校验与乐观冲突判定
│   ├── revisions.js   # 草稿修订时间线：成功写入同事务追加完整快照、旧草稿基线补建、恢复
│   ├── transfer.js    # 细胞迁移：三点对应点校验、仿射求解、整批映射+逐细胞校验
│   ├── clusters.js    # 接触簇：阈值校验、净区域最短间距（含孔洞语义）、邻接对与连通簇
│   ├── coverage-diff.js # 同切片两报告 · 单视野覆盖变化四类划分（平面排列，只读）
│   ├── field-grid.js  # 报告单视野网格密度分析：外接矩形等分、格子∩净区域有效面积、质心归格（只读）
│   ├── field-zones.js # 报告单视野最近质心责任区：Voronoi 半平面求交 × 视野净区域平面排列、面积/占比/实际分区（只读）
│   ├── render.js      # sharp + SVG 渲染标注 PNG
│   └── exporter.js    # CSV（测量/汇总/视野统计/比较）与 ZIP 导出
├── public/            # 前端（原生 JS，无需构建）
├── test-geometry.js   # 几何自测（npm test）
├── test-fields.js     # 视野密度统计自测（npm test）
├── test-merge.js      # 多视野合并统计自测（npm test）
├── test-compare.js    # 报告比较自测（npm test）
├── test-transfer.js   # 细胞迁移自测（npm test）
├── test-corrections.js # 报告更正链纯逻辑自测（npm test）
├── test-correct-api.js # 报告更正链端到端 HTTP 自测（npm test，临时目录起服务）
├── test-clusters.js   # 接触簇纯逻辑自测（npm test）
├── test-contacts-api.js # 接触簇端到端 HTTP 自测（npm test，临时目录起服务）
├── test-revisions-api.js # 草稿修订时间线/恢复端到端 HTTP 自测（npm test，临时目录起服务）
├── test-coverage-diff-api.js # 两报告覆盖变化核对端到端 HTTP 自测（npm test，临时目录起服务）
├── test-field-grid.js # 视野网格密度分析纯逻辑自测（npm test）
├── test-field-grid-api.js # 视野网格密度分析端到端 HTTP 自测（npm test，临时目录起服务）
├── test-field-zones.js # 最近质心责任区纯逻辑自测（npm test）
├── test-field-zones-api.js # 最近质心责任区端到端 HTTP 自测（npm test，临时目录起服务）
├── test-field-identity-api.js # 视野 id 身份歧义修复端到端 HTTP 自测（npm test：保存唯一校验/历史数据只读兼容/唯一名称回退/修正追加修订）
└── data/              # 运行后生成：app.db、images/、snapshots/
```

## HTTP 接口与调用示例（取样视野 / 细胞密度）

视野与细胞轮廓一样属于**草稿**，随 `GET /api/images/:id` 一起返回；几何点一律为
图片原始像素坐标 `{x, y}`，环为点数组（首尾不需要重复），孔洞为环数组。
视野保存是**整批替换**并携带草稿 `version` 做乐观并发控制。

`GET /api/images/:id` 在 `fields` 之外还返回实时计算的 `fieldStats`（数组，按保存顺序）：

```json
{
  "id": "7ca3…", "version": 4,
  "fields": [
    { "id": "f1", "name": "视野1",
      "outer": [{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}],
      "holes": [] }
  ],
  "fieldStats": [{
    "id": "f1", "name": "视野1", "holes": 0,
    "cellCount": 1,
    "countedCellKeys": ["cellA"],
    "areaMm2": 0.01, "densityPerMm2": 100, "countedCellAreaMm2": 0.0016,
    "areaText": "0.01", "densityText": "100", "countedCellAreaText": "0.0016",
    "calibrated": true
  }]
}
```

未定标时数值字段为 `null`，三个展示文本统一为 **`"待定标"`**，`cellCount` 照常给出；
`countedCellKeys` 为该视野计入细胞的标识（细胞 `id`，历史无 id 时为 `#序号`）。

### 保存视野（整批替换）

`PUT /api/images/:id/fields`，请求体：

```json
{
  "version": 3,
  "fields": [
    { "id": "f1", "name": "视野1",
      "outer": [{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}],
      "holes": [] },
    { "id": "f2", "name": "视野2",
      "outer": [{"x":0,"y":0},{"x":200,"y":0},{"x":200,"y":200},{"x":0,"y":200}],
      "holes": [ [{"x":20,"y":20},{"x":40,"y":20},{"x":40,"y":40},{"x":20,"y":40}] ] }
  ]
}
```

- 成功返回**更新后的整份草稿**（`version + 1`、含新 `fieldStats`）；
- 视野越界 / 自交 / 孔洞不严格位于外环内 / 孔洞彼此接触或重叠 / 净面积非正
  → **HTTP 400**，错误信息指出具体视野，**整批不写入、版本不变**；
- **同一批有两个视野共用同一 id** → **HTTP 400**，错误信息指出冲突 id 与具体位置
  （如「第 1 个视野（前野）、第 2 个视野（后野）」），**整批不写入、版本不变、不留修订**；
  几何校验先于 id 唯一性校验（几何非法时报几何问题）；
- 携带的 `version` 过期 → **HTTP 409** `{error, currentVersion}`，按草稿冲突处理，整次不写入；
- 视野与轮廓共用同一草稿版本：先存轮廓会让旧 `version` 失效，重新 `GET` 后再存视野即可。

重复 id 保存被拒的响应示例：

```json
{
  "error": "视野保存被拒绝：同一批取样视野的 id 必须唯一，检测到 1 组重复 id——id「f1」被 第 1 个视野（前野）、第 2 个视野（后野） 共用。请为冲突视野分配互不相同的 id（或在编辑页点「更换 id」）后整批重新保存，本次保存整批不生效"
}
```

curl 示例：

```bash
# 1) 取版本号
curl -s http://localhost:8080/api/images/$IMG_ID | jq .version

# 2) 保存两个视野（一个带孔洞）
curl -s -X PUT http://localhost:8080/api/images/$IMG_ID/fields \
  -H 'Content-Type: application/json' \
  -d @fields.json

# 3) 发布（冻结视野与统计；同样要带读取时版本号）
curl -s -X POST http://localhost:8080/api/images/$IMG_ID/publish \
  -H 'Content-Type: application/json' \
  -d '{"version":4,"title":"切片A 报告"}'
```

Node.js 示例（无第三方依赖）：

```js
const base = 'http://localhost:8080';

async function saveFields(imageId, fields) {
  const img = await fetch(`${base}/api/images/${imageId}`).then((r) => r.json());
  const res = await fetch(`${base}/api/images/${imageId}/fields`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: img.version, fields })
  });
  if (res.status === 409) {
    const { currentVersion } = await res.json();
    throw new Error(`草稿冲突，请用最新版本 v${currentVersion} 重试`);
  }
  if (!res.ok) throw new Error((await res.json()).error); // 400：整批被拒
  const saved = await res.json();
  for (const s of saved.fieldStats) {
    console.log(`${s.name}: 净面积 ${s.areaText} mm², 细胞 ${s.cellCount}, ` +
                `密度 ${s.densityText} 个/mm², 计入净面积总和 ${s.countedCellAreaText} mm²`);
  }
}

saveFields(process.env.IMG_ID, [
  { name: '中心视野',
    outer: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],
    holes: [] }
]);
```

### 视野 id 身份歧义修复（保存校验 / 历史数据只读兼容）

**问题背景**：修复前整批保存允许两个不同视野使用同一 id。此后合并统计按该 id 取
**后一个**视野（`Map` 去重），覆盖核对、网格密度、最近质心责任区按数组下标取
**第一个**——同一标识在不同分析中指向不同视野，结果互相矛盾；发布后冻结的报告也带着该矛盾。

本轮修复规则：

1. **保存前校验本批 id 唯一**：`PUT /api/images/:id/fields` 检测到重复 id 即
   **HTTP 400 整批拒绝**，错误信息给出冲突 id 与位置（第几个、名称）；
   **草稿版本与修订均不变**。
2. **历史数据不被静默改写**：修复前保存的重复 id **草稿、草稿修订、已发布报告**
   原样保留；旧报告继续冻结、只读，仍可按原标识读取与导出（PNG/CSV/ZIP）。
3. **基于重复 id 的分析明确拒绝**：下列请求在目标草稿/报告中存在该 id 的身份歧义时
   一律 **HTTP 400**（错误信息列出共用该 id 的视野位置），绝不静默取其中一个：
   - `POST /api/images/:id/field-merge`、`POST /api/reports/:id/field-merge`
     （所选 id 命中歧义时；请求内同一 id 重复仍按原契约报“视野标识重复”）；
   - `POST /api/images/:id/field-coverage`、`POST /api/reports/:id/field-coverage`；
   - `POST /api/reports/:id/field-grid`、`POST /api/reports/:id/field-zones`；
   - `POST /api/reports/field-coverage-diff`（基线视野 id 歧义）。
4. **按唯一名称查询仍选中对应视野**：名称匹配只在**无 id 命中**时进行——
   **id 始终优先于名称**；跨视野同名（id 唯一）依旧允许保存，按重名查询仍报
   “N 个同名视野，请改用 id”的 **HTTP 400**；空标识/不存在的 400、404 与
   409 乐观并发等**既有 HTTP 契约全部不变**。
5. **编辑页可修正当前草稿**：③ 面板对冲突视野显示「⚠ id 冲突」徽标与顶部冲突说明，
   点「更换 id」为冲突视野分配新 id 后，**按现有版本**点「保存全部视野」整批保存
   （页面即时校验与服务端一致）；成功后**追加一条正常 fields 修订**，随后发布/更正恢复正常。
   含重复 id 的草稿**发布与发起更正均被拒绝（HTTP 400）**；恢复含重复 id 的历史修订
   是允许的显式操作，恢复后按同一流程修正即可。
6. 报告详情页对冻结的冲突视野只做**只读标明**（徽标 + 顶部说明 + 下拉提示），
   不提供任何改写入口。

curl 调用示例（历史遗留重复 id 数据上的行为）：

```bash
BASE=http://localhost:8080

# 保存重复 id → 400，整批拒绝并指出位置（版本/修订不变）
curl -s -X PUT $BASE/api/images/$IMG/fields -H 'Content-Type: application/json' -d '{
  "version": 3,
  "fields": [
    {"id":"f1","name":"前野","outer":[[0,0],[50,0],[50,50],[0,50]],"holes":[]},
    {"id":"f1","name":"后野","outer":[[60,60],[110,60],[110,110],[60,110]],"holes":[]}
  ]
}'
# -> { "error": "视野保存被拒绝：同一批取样视野的 id 必须唯一，检测到 1 组重复 id——id「f1」被 第 1 个视野（前野）、第 2 个视野（后野） 共用。……本次保存整批不生效" }

# 历史遗留报告：按重复 id 分析 → 400（不再静默取第一个）
curl -s -X POST $BASE/api/reports/$RID/field-grid -H 'Content-Type: application/json' \
  -d '{"fieldId":"f1","rows":2,"cols":2}'
# -> { "error": "视野标识存在身份歧义：id「f1」在本报告中被多个视野共用（第 1 个视野（前野）、第 2 个视野（后野）），……历史冻结内容不被改写" }

# 按唯一名称 → 仍正常选中对应视野（matchedBy:"name"）
curl -s -X POST $BASE/api/reports/$RID/field-grid -H 'Content-Type: application/json' \
  -d '{"fieldId":"后野","rows":2,"cols":2}' | jq '{matchedBy, area: .grid.fieldAreaPx}'
```

Node.js 调用示例（无第三方依赖；自动识别歧义并走名称回退或先修正草稿）：

```js
const base = 'http://localhost:8080';
const crypto = require('node:crypto'); // 用于修正草稿时生成新 id

async function postJson(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error || `HTTP ${res.status}`);
    e.status = res.status;
    e.body = j;
    throw e;
  }
  return j;
}

async function analyzeSingleField(scope, id, identifier) {
  const path = scope === 'report'
    ? `/api/reports/${id}/field-coverage`
    : `/api/images/${id}/field-coverage`;
  try {
    return await postJson(path, { fieldId: identifier }); // 正常：id 或唯一名称
  } catch (e) {
    if (e.status === 400 && /身份歧义/.test(e.message)) {
      // 该 id 是修复前遗留的重复 id：先从 fields 取唯一名称再查（只读，不改写历史）
      const detail = await (await fetch(`${base}${scope === 'report'
        ? `/api/reports/${id}` : `/api/images/${id}`}`)).json();
      const matches = (detail.fields || []).filter((f) => f.id === identifier);
      const names = new Set(matches.map((f) => (f.name || '').trim()));
      if (names.size === matches.length && matches.length) {
        return postJson(path, { fieldId: matches[matches.length - 1].name.trim() });
      }
      throw new Error(`id「${identifier}」无法唯一解析，且名称也不唯一，请先修正草稿后重新保存/发布`);
    }
    throw e;
  }
}

// 修正当前草稿的重复 id（按现有版本校验；成功后追加正常 fields 修订）
async function fixDuplicateFieldIds(imageId) {
  const img = await (await fetch(`${base}/api/images/${imageId}`)).json();
  const used = new Set();
  const fields = (img.fields || []).map((f) => {
    if (!used.has(f.id)) { used.add(f.id); return f; }
    let nid;
    do { nid = crypto.randomUUID(); } while (used.has(nid));
    used.add(nid);
    return { ...f, id: nid };
  });
  const res = await fetch(`${base}/api/images/${imageId}/fields`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: img.version, fields })
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json(); // version + 1，时间线追加一条正常「视野保存」修订
}
```

### 冻结结果（报告页与视野统计 CSV 完全一致）

`GET /api/reports/:id` 返回发布时冻结的 `fields` 与 `fieldStats`；
旧报告缺少视野时二者都是空列表。单独导出：

```bash
curl -s -OJ http://localhost:8080/api/reports/$REPORT_ID/field-csv
# -> <report_id>_fields.csv（UTF-8 BOM）
# 列：视野名称,孔洞数,净面积(mm²),细胞数,细胞密度(个/mm²),计入细胞净面积总和(mm²)
# 未定标/旧报告对应列为“待定标”或“（无取样视野）”
```

原 `GET /api/reports/:id/csv`（测量 CSV，μm²）、`/png`、批量导出与报告比较结果
**保持原义不变**；视野统计是独立 CSV，不混入测量 CSV。

## 多视野合并统计 HTTP 接口（几何并集，只读）

在**同一草稿**或**同一报告**内选择**至少两个**取样视野，按所选视野净区域
（外环扣除孔洞）的**几何并集**返回合并统计。两个接口都是**只读**的，不写库、
不改变任何逐视野统计与报告内容；请求体均为 `{ "fieldIds": string[] }`，
标识为 `GET /api/images/:id` / `GET /api/reports/:id` 返回的视野 `id`。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/images/:id/field-merge` | 草稿合并统计：按**当前**细胞轮廓、视野与标尺实时计算；草稿不存在 → 404 |
| `POST /api/reports/:id/field-merge` | 报告合并统计：只读取**发布时冻结**的 fields/cells/calib；报告不存在 → 404 |

错误语义（两个接口一致）：

- `fieldIds` 不是数组 / 含非字符串 → **400**；
- 选择**不足 2 个**视野 → **400**（指明当前个数）；
- 视野标识在**请求中重复** → **400**（指明重复的 id）；
- 视野标识在该草稿/报告内**不存在**（草稿视野被删除/改动后旧 id 失效）→ **400**（指明不存在的 id）；
- 所选 id 在该草稿/报告中**被多个视野共用**（修复前遗留的同批重复 id）→ **400**
  （身份歧义，列出共用该 id 的视野位置；不静默取“后一个”）。

成功响应示例（草稿；报告侧 `scope:"report"` 且返回 `draftVersion`）：

```json
{
  "scope": "draft",
  "imageId": "7ca3…",
  "version": 4,
  "calibrated": true,
  "stats": {
    "kind": "field-merge",
    "fieldCount": 2,
    "fieldIds": ["f1", "f2"],
    "fieldNames": ["视野1", "视野2"],
    "areaPx": 10000,
    "areaMm2": 0.01,
    "cellCount": 3,
    "countedCellKeys": ["cellA", "cellB", "#2"],
    "countedCells": [
      { "key": "cellA", "name": "Alpha" },
      { "key": "cellB", "name": "Beta" }
    ],
    "countedCellAreaPx": 320,
    "countedCellAreaMm2": 0.0032,
    "densityPerMm2": 300,
    "areaText": "0.01",
    "densityText": "300",
    "countedCellAreaText": "0.0032",
    "calibrated": true
  }
}
```

- 并集面积按平面排列（半边缘遍历）精确计算：重叠/共线/旋转多边形均为真实几何并集，
  非面积简单加减；`areaText` 保留 6 位小数、`densityText` 4 位，与逐视野统计同一规则；
- **未定标**（草稿未完成标尺定标）时 `areaMm2`/`densityPerMm2`/`countedCellAreaMm2` 为
  `null`，三个展示文本统一为 **`"待定标"`**，`cellCount` 与 `countedCellKeys` 照常给出；
- 细胞以净区域质心**严格位于并集内部**才计入，`countedCellKeys` 为计入细胞标识
  （细胞 `id`，历史无 id 时为 `#序号`），同一细胞在并集中只出现一次。

curl 示例（草稿 `IMG`；报告把 `/api/images/$IMG/field-merge` 换成
`/api/reports/$RID/field-merge`）：

```bash
# 合并两个贴合视野（并集 = 两视野净区域几何并集）
curl -s -X POST http://localhost:8080/api/images/$IMG/field-merge \
  -H 'Content-Type: application/json' \
  -d '{"fieldIds":["f1","f2"]}' | jq '.stats |
    {fieldNames, areaMm2, cellCount, densityPerMm2, countedCellAreaMm2, countedCellKeys}'

# 不足两个 / 重复 / 不存在 → 400
curl -s -X POST http://localhost:8080/api/images/$IMG/field-merge \
  -H 'Content-Type: application/json' -d '{"fieldIds":["f1"]}'
# -> { "error": "合并统计至少需要选择 2 个同一草稿/报告内的取样视野（当前选择 1 个），请求被拒绝" }
```

Node.js 示例（无第三方依赖；草稿改动后按最新数据重算，报告始终冻结）：

```js
const base = 'http://localhost:8080';

async function mergeFields(pathKind, id, fieldIds) {
  const res = await fetch(`${base}/api/${pathKind}/${id}/field-merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldIds })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e; // 400：不足两个/重复/不存在；404：草稿或报告不存在
  }
  const s = body.stats;
  console.log(`合并 ${s.fieldCount} 个视野（${s.fieldNames.join('、')}）`);
  console.log(`并集净面积 ${s.areaText} mm² · 细胞 ${s.cellCount} · ` +
              `密度 ${s.densityText} 个/mm² · 计入净面积总和 ${s.countedCellAreaText} mm²`);
  return body;
}

// 草稿：随轮廓/视野/标尺改变按当前数据重算
await mergeFields('images', process.env.IMG, ['f1', 'f2']);
// 报告：只读取发布时冻结数据
await mergeFields('reports', process.env.RID, ['f1', 'f2']);
```

## 单视野细胞覆盖核对 HTTP 接口（几何交集，只读）

按**选定取样视野**核对细胞标注覆盖情况。输入视野标识，返回**视野净面积、细胞覆盖面积、
未覆盖面积与覆盖率**。两个接口都是**只读**的，不写库、不推进版本、不改变任何草稿、
修订与报告；请求体均为 `{ "fieldId": string }`，`fieldId` 可为 `GET /api/images/:id` /
`GET /api/reports/:id` 返回的视野 `id`，也可为**视野名称**（首尾空白忽略、精确匹配）。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/images/:id/field-coverage` | 草稿覆盖核对：按**当前**细胞轮廓、视野与标尺实时计算；切片不存在 → 404 |
| `POST /api/reports/:id/field-coverage` | 报告覆盖核对：只读取**发布时冻结**的 fields/cells/calib；报告不存在 → 404 |

覆盖面积是**细胞净区域与视野净区域的几何交集面积**（平面排列/半边缘遍历精确计算）：

- **跨越视野边界的细胞只计落在视野内部的部分**；
- **多个细胞相互重叠只计一次**（按细胞覆盖区域的并集，不逐细胞求和）；
- 细胞孔洞、视野孔洞、以及**仅边界接触（零面积）一律不贡献面积**；
- 与按质心计数的密度统计**无关**：质心在视野外的跨边界细胞仍按内部面积计入，反之亦然。

错误语义（两个接口一致）：

- `fieldId` 缺失/不是非空字符串 → **400**（提示必须提供视野 id 或名称）；
- 视野标识在该切片/报告内**不存在** → **400**（明确报出标识，并提示重新获取列表）；
- 视野**名称重名**无法唯一确定 → **400**（提示改用 id；id 始终优先精确匹配）；
- 视野 **id 被多个视野共用**（修复前遗留的身份歧义）→ **400**（列出冲突位置；
  不静默取“第一个”，改用唯一名称仍可查询）。

成功响应示例（草稿；报告侧 `scope:"report"` 且返回 `title`、`draftVersion`）：

```json
{
  "scope": "draft",
  "imageId": "7ca3…",
  "version": 4,
  "calibrated": true,
  "matchedBy": "id",
  "coverage": {
    "kind": "field-coverage",
    "fieldId": "f1",
    "fieldName": "视野1",
    "fieldHoles": 0,
    "fieldAreaPx": 10000,
    "coveredAreaPx": 3200,
    "uncoveredAreaPx": 6800,
    "coverageRatio": 0.32,
    "coveragePercent": 32,
    "coverageText": "32%",
    "fieldAreaMm2": 0.01,
    "coveredAreaMm2": 0.0032,
    "uncoveredAreaMm2": 0.0068,
    "fieldAreaText": "0.01",
    "coveredAreaText": "0.0032",
    "uncoveredAreaText": "0.0068",
    "contributingCells": [
      { "key": "cellA", "name": "Alpha" },
      { "key": "cellB", "name": "Beta" }
    ],
    "contributingCellKeys": ["cellA", "cellB"],
    "contributingCellCount": 2,
    "calibrated": true
  }
}
```

- `fieldAreaPx` / `coveredAreaPx` / `uncoveredAreaPx` / `coverageRatio` / `coverageText`
  **未定标时也照常给出**（像素面积与覆盖率不依赖标尺）；
- **未定标草稿**的三个 mm² 字段为 `null`，三个面积展示文本统一为 **`"待定标"`**
  （`coverageText` 仍为百分比）；报告均为已定标发布，不存在该情形；
- `contributingCells` 列出与视野存在**正面积净交集**的细胞标识与名称
 （细胞 `id`，历史无 id 时为 `#序号`）；仅边界接触、完全在视野外或仅落入视野孔洞的
 细胞不列入；
- `matchedBy` 为本次标识匹配方式：`"id"` 或 `"name"`。

curl 示例（草稿 `IMG`；报告把 `/api/images/$IMG/field-coverage` 换成
`/api/reports/$RID/field-coverage`）：

```bash
# 按视野 id 核对
curl -s -X POST http://localhost:8080/api/images/$IMG/field-coverage \
  -H 'Content-Type: application/json' \
  -d '{"fieldId":"f1"}' | jq .coverage

# 按视野名称核对（自动忽略首尾空白）
curl -s -X POST http://localhost:8080/api/images/$IMG/field-coverage \
  -H 'Content-Type: application/json' \
  -d '{"fieldId":"视野1"}'

# 视野标识不存在 / 不属于该切片 → 400
curl -s -X POST http://localhost:8080/api/images/$IMG/field-coverage \
  -H 'Content-Type: application/json' -d '{"fieldId":"no-such"}'
# -> { "error": "视野标识不存在：no-such（不属于该草稿/报告；请使用当前数据中存在的视野 id 或名称，草稿视野改动后请重新获取列表），请求被拒绝" }
```

Node.js 示例（无第三方依赖；草稿改动后按最新数据重算，报告始终取发布时冻结值）：

```js
const base = 'http://localhost:8080';

async function fieldCoverage(pathKind, id, fieldId) {
  const res = await fetch(`${base}/api/${pathKind}/${id}/field-coverage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldId })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e; // 400：标识为空/不存在/重名；404：切片或报告不存在
  }
  const c = body.coverage;
  console.log(`视野 ${c.fieldName}（按${body.matchedBy === 'id' ? 'id' : '名称'}匹配）`);
  console.log(`净面积 ${c.fieldAreaPx} px² / ${c.fieldAreaText}${c.calibrated ? ' mm²' : ''}`);
  console.log(`细胞覆盖 ${c.coveredAreaPx} px² / ${c.coveredAreaText}${c.calibrated ? ' mm²' : ''}`);
  console.log(`未覆盖 ${c.uncoveredAreaPx} px² / ${c.uncoveredAreaText}${c.calibrated ? ' mm²' : ''}`);
  console.log(`覆盖率 ${c.coverageText}；有交集细胞 ${c.contributingCellCount} 个：` +
              c.contributingCells.map((x) => x.name || x.key).join('、'));
  return body;
}

// 草稿：随轮廓/视野/标尺改变按当前数据实时重算（未定标时物理面积显示“待定标”）
await fieldCoverage('images', process.env.IMG, 'f1');
// 报告：只读取发布时冻结数据（后续草稿修改/报告更正不影响旧报告）
await fieldCoverage('reports', process.env.RID, '视野1');
```

## 细胞迁移 HTTP 接口（三点对应仿射变换）

把一份**已发布报告**的全部细胞映射到**另一张图片草稿**。
`sourcePoints` / `targetPoints` 各为按相同顺序给出的 **3 个不共线对应点**
（图片原始像素坐标 `{x, y}`；服务端按 3 位小数取整后求解，预览与提交因此是同一变换）。
预览与确认提交共用同一套映射与几何校验；任何失败**整批不写入**。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/images/:id/migrate/preview` | 预览：`{reportId, sourcePoints, targetPoints}` → 仿射系数、逐细胞映射轮廓与校验结论、按目标标尺预算的测量值、预览时读取的目标草稿版本；不写入任何数据 |
| `POST /api/images/:id/migrate` | 确认迁移：`{version, reportId, sourcePoints, targetPoints}`，`version` 必须为**预览时读取的目标草稿版本**；全部校验通过才把映射细胞追加到目标（新标识、保留名称、按目标标尺重算测量），返回更新后的整份草稿 |

错误语义：

- 目标草稿不存在 → **404**；来源报告不存在 → **404**；缺少 `reportId` → **400**；
- 来源报告无细胞 → **400**（指明报告标题）；
- 对应点数量不足/坐标非法/**重合/共线/越界**（任一侧）→ **400**，指明侧别与具体点；
- 映射后任一细胞不满足几何规则 → 预览 `ok:false` 并逐细胞给出原因；
  提交时同样拒绝（**400**，**整批不写入**，目标版本不变）；
- 携带的 `version` 过期 → **409** `{error, currentVersion}`，提示刷新后重新预览；
- 成功（**201**）：目标 `version + 1`，映射细胞追加到现有细胞之后，
  目标原有细胞/标尺/视野、来源报告与全部已发布报告均不改变。

预览响应示例（节选）：

```json
{
  "target": { "id": "img-B", "version": 4, "width": 400, "height": 300 },
  "source": { "reportId": "rep-A", "title": "切片A报告", "cellCount": 2 },
  "transform": { "a": 1.5, "b": 0, "c": 50, "d": 0, "e": 1.5, "f": 50 },
  "ok": true, "okCount": 2, "failCount": 0,
  "cells": [
    { "key": "cell-a", "name": "Alpha", "seq": 1, "ok": true, "error": null,
      "outer": [{"x":65,"y":65},{"x":140,"y":65},{"x":140,"y":125},{"x":65,"y":125}],
      "holes": [[{"x":80,"y":80},{"x":95,"y":80},{"x":95,"y":95},{"x":80,"y":95}]],
      "areaUm2": 267.1875, "perimeterUm": 82.5 }
  ]
}
```

curl 示例（目标草稿 `IMG`、来源报告 `RID`）：

```bash
# 1) 预览：来源三点 (0,0)(100,0)(0,100) ↔ 目标三点 (50,50)(200,50)(50,200)
curl -s -X POST http://localhost:8080/api/images/$IMG/migrate/preview \
  -H 'Content-Type: application/json' \
  -d "{\"reportId\":\"$RID\",
       \"sourcePoints\":[{\"x\":0,\"y\":0},{\"x\":100,\"y\":0},{\"x\":0,\"y\":100}],
       \"targetPoints\":[{\"x\":50,\"y\":50},{\"x\":200,\"y\":50},{\"x\":50,\"y\":200}]}" \
  | jq '{ok, failCount, targetVersion: .target.version,
         cells: [.cells[] | {name, ok, error}]}'

# 2) 确认迁移：version 必须取上一步预览返回的 target.version
curl -s -X POST http://localhost:8080/api/images/$IMG/migrate \
  -H 'Content-Type: application/json' \
  -d "{\"version\":4,\"reportId\":\"$RID\",
       \"sourcePoints\":[{\"x\":0,\"y\":0},{\"x\":100,\"y\":0},{\"x\":0,\"y\":100}],
       \"targetPoints\":[{\"x\":50,\"y\":50},{\"x\":200,\"y\":50},{\"x\":50,\"y\":200}]}" \
  | jq '{appendedCount, newVersion: .image.version,
         cells: [.image.cells[] | {id, name, areaUm2}]}'
```

Node.js 示例（无第三方依赖；含 409 刷新重试）：

```js
const base = 'http://localhost:8080';

async function migrateCells(targetImageId, reportId, sourcePoints, targetPoints) {
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async (r) => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(b.error || `HTTP ${r.status}`); e.status = r.status; e.body = b; throw e; }
    return b;
  });

  // 预览：同一变换与校验，不写入
  const preview = await post(`/api/images/${targetImageId}/migrate/preview`,
    { reportId, sourcePoints, targetPoints });
  if (!preview.ok) {
    const bad = preview.cells.filter((c) => !c.ok).map((c) => `${c.label}：${c.error}`);
    throw new Error(`预览未通过，禁止提交：\n${bad.join('\n')}`);
  }

  try {
    // 确认：携带预览时读取的目标草稿版本
    return await post(`/api/images/${targetImageId}/migrate`,
      { version: preview.target.version, reportId, sourcePoints, targetPoints });
  } catch (e) {
    if (e.status === 409) {
      throw new Error(`目标草稿已过期（当前 v${e.body.currentVersion}），请刷新后重新预览再迁移`);
    }
    throw e; // 400：对应点非法 / 来源无细胞 / 映射后轮廓不合法，整批未写入
  }
}

const result = await migrateCells(
  process.env.IMG, process.env.RID,
  [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
  [{ x: 50, y: 50 }, { x: 200, y: 50 }, { x: 50, y: 200 }]
);
console.log(`已迁移 ${result.appendedCount} 个细胞，目标草稿版本 v${result.image.version}`);
for (const s of result.image.fieldStats) {
  console.log(`${s.name}: 细胞 ${s.cellCount}，密度 ${s.densityText} 个/mm²`);
}
```

## 报告更正链 HTTP 接口

对一份**当前有效报告**（链末端），用**同一切片的当前草稿**生成新的不可变报告。
历史报告永不改变，仍按原标识读取/导出；普通发布（`POST /api/images/:id/publish`）行为不变。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/report-chains` | 更正链列表：每条链的**当前有效报告**（`tipId`/`current`）、**最近更正原因** `reason`、`history` 与完整 `members` |
| `GET /api/reports/:id/trace` | 追溯某份报告所在链：`rootId`/`tipId`/`length`/该报告 `position`/`isTip`、由旧到新的 `members` |
| `POST /api/reports/:id/correct` | 发起更正（见下） |

`GET /api/reports` 与 `GET /api/reports/:id` 的每个报告对象另含
`correctsReportId`、`correctionReason`、`chainId`（链根 id）、`isChainTip`（是否当前有效）。

### 发起更正

`POST /api/reports/:id/correct`，请求体：

```json
{
  "reason": "第 2 个细胞孔洞圈错，重描后重新发布",
  "draftVersion": 5,
  "expectedTipId": "<读取时该链末端报告 id>",
  "title": "切片A 第2版（可省略，省略则沿用被更正报告标题）"
}
```

- `reason`：**必填**，去除首尾空白后不能为空，最长 500 字；
- `draftVersion`：发起表单读取到的**当前草稿版本号**（整数）；
- `expectedTipId`：读取时**更正链末端**报告标识（通常即所选报告自身的 id）；
- 服务端另校验：所选草稿必须与报告**同一切片**（`image_id` 相同）、报告与草稿都存在、
  草稿通过**既有发布校验**（已定标、至少一个细胞、测量值已按当前标尺计算）。

成功 **201**：复制新图片快照并插入新报告（`correctsReportId` 指向前一份、记录原因），
草稿 `version + 1`；响应含新报告 `report`、更新后 `image`、`correctedReportId`、`reason`
与 `trace`（新链追溯视图）。

错误语义（**任何失败都不留下报告或快照**）：

- 报告不存在 → **404** `{error}`；报告对应切片草稿不存在 → **404**；
- 原因为空/非字符串/超长、缺少或非整数 `draftVersion`、缺少 `expectedTipId`、
  草稿与报告不同切片、草稿不满足发布校验 → **400** `{error}`；
- 草稿版本变化、或所选报告已不是链末端/携带的末端标识过期 → **409**，返回最新信息：

```json
{
  "error": "更正被拒绝：草稿已过期（携带版本 v4，当前版本 v5）……",
  "currentVersion": 5,
  "currentTipId": "<当前链末端报告 id>",
  "tip": { "id": "…", "title": "…", "correctionReason": "…" },
  "image": { "…": "最新草稿对象…" }
}
```

curl 示例（`RID`=被更正报告，`IMG`=同一切片草稿）：

```bash
# 1) 读取报告与其追溯，拿到当前链末端；读取同一切片草稿拿到版本号
curl -s http://localhost:8080/api/reports/$RID | jq '{id,isChainTip,imageId,chainId}'
curl -s http://localhost:8080/api/reports/$RID/trace | jq '{tipId,length,isTip}'
curl -s http://localhost:8080/api/images/$IMG | jq .version

# 2) 发起更正（expectedTipId 用上一步的 tipId，draftVersion 用草稿版本）
curl -s -X POST http://localhost:8080/api/reports/$RID/correct \
  -H 'Content-Type: application/json' \
  -d "{\"reason\":\"孔洞圈错重描\",\"draftVersion\":5,\"expectedTipId\":\"$RID\"}" \
  | jq '{newId: .report.id, corrects: .report.correctsReportId, reason: .report.correctionReason,
         trace: {tipId: .trace.tipId, length: .trace.length}}'

# 3) 按更正链查看当前有效报告与历史（历史报告仍可用 /api/reports/<旧id> 打开）
curl -s http://localhost:8080/api/report-chains | jq '.chains[] |
  {tipId, length, reason, history: [.history[].id]}'
```

Node.js 示例（无第三方依赖；含 409 自动取最新信息后重试）：

```js
const base = 'http://localhost:8080';

async function correctReport(reportId, reason, title) {
  // 读取时的三份依据：报告（同切片 imageId）、草稿版本、链末端标识
  const report = await (await fetch(`${base}/api/reports/${reportId}`)).json();
  const trace = await (await fetch(`${base}/api/reports/${reportId}/trace`)).json();
  const draft = await (await fetch(`${base}/api/images/${report.imageId}`)).json();

  const res = await fetch(`${base}/api/reports/${reportId}/correct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reason,
      draftVersion: draft.version,
      expectedTipId: trace.tipId,
      ...(title ? { title } : {})
    })
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) {
    // 版本/链末端过期：服务端已返回最新草稿与当前链末端，按需重新确认后重试
    const e = new Error(`${body.error}（当前草稿 v${body.currentVersion}，链末端 ${body.currentTipId}）`);
    e.status = 409; e.body = body; throw e;
  }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return body; // 201：新不可变报告 + 快照，前一份成为历史
}

// 第一次更正
const r2 = await correctReport(process.env.RID, '第 2 个细胞孔洞圈错，重描');
console.log(`已生成 ${r2.report.id}，更正自 ${r2.report.correctsReportId}`);
// 继续更正：对新的链末端 r2.report.id 再发（携带其草稿版本与 r2 作为 expectedTipId）
```

## 细胞接触簇 HTTP 接口（间距阈值，只读）

对一份**已发布报告**按**间距阈值（μm，允许 0）**分析细胞接触簇。
只读取报告**发布时冻结的轮廓与定标**：草稿后续修改、重新定标或报告更正
都**不改变**旧报告的分析结果；阈值仅影响本次查询，**不写回报告**。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/reports/:id/contacts` | 接触簇分析：请求体 `{ "thresholdUm": 5 }`（微米，允许 0；数值字符串按数值接受）。报告不存在 → 404；阈值缺失/非数值/负数/非有限数（NaN、Infinity）→ 400 |

**距离语义**：两个细胞各自**外轮廓扣除孔洞后的净区域**之间的最短距离——
净区域**重叠或边界接触时为 0**；一个细胞**仅落在另一细胞孔洞内且未触及其净区域**
时**不视为接触**（间距为其到孔洞边界的距离，> 0）。邻接 = 间距 ≤ 阈值；
**连通簇** = 邻接关系的连通分量；**没有邻接关系时每个细胞各自成独立簇**。

成功响应示例（节选；`cells[].neighbors` 按间距升序，`clusters` 按规模降序）：

```json
{
  "scope": "report",
  "reportId": "rep-1",
  "title": "切片A 报告",
  "draftVersion": 4,
  "scaleUmPerPx": 0.5,
  "thresholdUm": 5,
  "cellCount": 3,
  "pairCount": 2,
  "clusterCount": 2,
  "multiCellClusterCount": 1,
  "pairs": [
    { "a": "cell-1", "b": "cell-2", "aName": "甲", "bName": "乙",
      "distanceUm": 2.5, "distancePx": 5 }
  ],
  "cells": [
    { "key": "cell-1", "name": "甲", "seq": 1, "clusterId": 0,
      "neighborCount": 1, "shortestUm": 2.5,
      "neighbors": [{ "key": "cell-2", "name": "乙", "seq": 2,
                      "distanceUm": 2.5, "distancePx": 5 }] }
  ],
  "clusters": [
    { "id": 0, "size": 2, "cellKeys": ["cell-1", "cell-2"],
      "cells": [{ "key": "cell-1", "name": "甲", "seq": 1 },
                { "key": "cell-2", "name": "乙", "seq": 2 }] },
    { "id": 1, "size": 1, "cellKeys": ["cell-3"],
      "cells": [{ "key": "cell-3", "name": "丙", "seq": 3 }] }
  ]
}
```

- `cells[].shortestUm`：该细胞**阈值内最近邻居**的净区域间距（无邻居为 `null`）；
- 细胞标识 `key` 为细胞 `id`（历史无 id 数据为 `#序号`，与视野统计/比较同一约定）；
- 阈值为 **0** 时只有净区域**接触或重叠**的细胞对才算邻接。

curl 示例（`RID` 为报告标识）：

```bash
# 阈值 5μm：查看邻接对与连通簇
curl -s -X POST http://localhost:8080/api/reports/$RID/contacts \
  -H 'Content-Type: application/json' -d '{"thresholdUm":5}' \
  | jq '{pairCount, clusterCount,
         clusters: [.clusters[] | {size, cellKeys}],
         nearest: [.cells[] | {key, shortestUm}]}'

# 阈值 0：只看净区域相互接触/重叠的细胞
curl -s -X POST http://localhost:8080/api/reports/$RID/contacts \
  -H 'Content-Type: application/json' -d '{"thresholdUm":0}' | jq '.pairCount'

# 负阈值 / 非有限数 → 400；报告不存在 → 404
curl -s -X POST http://localhost:8080/api/reports/$RID/contacts \
  -H 'Content-Type: application/json' -d '{"thresholdUm":-1}'
# -> { "error": "间距阈值无效：thresholdUm 不能为负数（收到 -1）" }
```

Node.js 示例（无第三方依赖）：

```js
const base = 'http://localhost:8080';

async function contactClusters(reportId, thresholdUm) {
  const res = await fetch(`${base}/api/reports/${reportId}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thresholdUm })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.status = res.status; // 400：阈值非法；404：报告不存在
    throw e;
  }
  console.log(`阈值 ${body.thresholdUm} μm：${body.cellCount} 个细胞，` +
              `${body.pairCount} 对邻接，${body.clusterCount} 个连通簇`);
  for (const c of body.clusters) {
    console.log(`簇 ${c.id + 1}（${c.size} 个）：${c.cells.map((x) => x.name).join('、')}`);
  }
  for (const cell of body.cells) {
    const nbrs = cell.neighbors.map((n) => `${n.name}(${n.distanceUm}μm)`).join('、') || '无';
    console.log(`${cell.name}：邻居 ${nbrs}；最短净区域间距 ${cell.shortestUm ?? '—'} μm`);
  }
  return body;
}

await contactClusters(process.env.RID, 5);
```

## 报告比较 HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/comparisons` | 比较记录列表（标题、两侧报告、配对数、版本、时间） |
| `POST /api/comparisons` | 新建：`{baselineReportId, retestReportId, title?, pairs:[{baselineCellKey, retestCellKey}]}`；报告不存在/两侧相同/配对重复/细胞不存在 → 400，整次不生效 |
| `GET /api/comparisons/:id` | 比较结果：两侧冻结定标、逐对细胞两侧数值/带符号差值/变化率（基线 0 为 `不可计算`）、两侧未配对细胞 |
| `PUT /api/comparisons/:id` | 修改标题与配对（两侧报告不可更换），须携带读取时 `version`；过期 → 409 并返回 `currentVersion`，整次修改不写入 |
| `GET /api/comparisons/:id/csv` | 导出与页面一致的比较 CSV（UTF-8 BOM） |

## 草稿修订时间线与恢复 HTTP 接口

每次**成功写入**（定标 / 轮廓 / 视野 / 迁移）都在同一事务追加一条只追加的完整快照修订；
上传即建空草稿基线，旧库启动时自动以当前状态补建基线。失败请求不留修订。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/images/:id/revisions` | 时间线（由新到旧）：`{currentVersion, revisions:[{id,seq,type,typeLabel,note,draftVersion,calibrated,cellCount,fieldCount,isRestore,restoredFromId,restoredFromSeq,createdAt,...}]}`；图片不存在 → 404 |
| `GET /api/images/:id/revisions/:revId` | 修订完整快照（预览）：含 `calib`、`cells`、`fields` 与按**该修订标尺**计算的 `fieldStats`、`isCurrent`；修订不存在或不属于该切片 → 404 |
| `POST /api/images/:id/revisions/:revId/restore` | 恢复为当前草稿，请求体 `{version}` 必须是读取时的草稿版本；成功 **201** 返回 `{image, revision, restoredFrom}`，生成新版本与新 `restore` 修订，不抹历史 |

恢复的错误约定：

- `version` 缺失或非整数 → **400**；
- `version` 与当前草稿版本不一致 → **409**，返回 `{error, currentVersion}`，**不写入**；
- 修订不存在、或不属于该切片 → **404**，**不写入**（不泄露其它切片修订）。

调用示例：

```bash
IMG=<image_id>

# 1) 查看时间线（由新到旧）：拿到想恢复的修订 id 与当前草稿版本
curl -s http://localhost:8080/api/images/$IMG/revisions
# -> { "currentVersion": 4,
#      "revisions": [
#        { "seq": 4, "type": "fields",  "typeLabel": "视野保存", "draftVersion": 4, ... },
#        { "seq": 3, "type": "contours","typeLabel": "轮廓保存", "draftVersion": 3, ... },
#        { "seq": 2, "type": "calibration", "typeLabel": "标尺定标", "draftVersion": 2, ... },
#        { "seq": 1, "type": "baseline","typeLabel": "基线", "draftVersion": 1, ... } ] }

# 2) 预览某条修订（标尺/细胞/视野完整快照 + 按该标尺重算的视野统计，不写任何数据）
curl -s http://localhost:8080/api/images/$IMG/revisions/<revision_id>
# -> { "seq": 2, "type": "calibration", "isCurrent": false,
#      "calib": {"scale": 1, ...}, "cells": [], "fields": [], "fieldStats": [] }

# 3) 恢复：必须携带第 1 步读到的当前版本 currentVersion
curl -s -X POST http://localhost:8080/api/images/$IMG/revisions/<revision_id>/restore \
  -H 'Content-Type: application/json' \
  -d '{"version": 4}'
# -> 201 { "image": { "version": 5, "calib": ..., "cells": ..., "fields": ..., "fieldStats": ... },
#         "revision": { "seq": 5, "type": "restore", "restoredFromSeq": 2, ... },
#         "restoredFrom": { "id": "<revision_id>", "seq": 2, "type": "calibration" } }
# 时间线此后为 5→4→3→2→1：后来的 fields/contours 修订仍在，已发布报告与更正链不变。

# 版本过期 → 409 + 当前版本（不写入）
# -> { "error": "草稿已过期：你携带的版本为 v4，当前版本为 v6，请重新读取时间线后再恢复",
#      "currentVersion": 6 }
# 修订不存在 / 不属于该切片 → 404（不写入）；缺少整数 version → 400
```

JavaScript 调用示例（页面内 `API` 封装）：

```js
const { currentVersion, revisions } = await API.listRevisions(imgId);
const snapshot = await API.getRevision(imgId, revisions[2].id); // 预览某条修订
const result = await API.restoreRevision(imgId, revisions[2].id, currentVersion);
// result.image.version 为新版本；result.revision 为新增的 restore 修订
```

## 同切片两报告 · 单视野细胞覆盖变化核对 HTTP 接口（只读）

`POST /api/reports/field-coverage-diff`，请求体：

```json
{ "baselineReportId": "<基线报告 id>", "retestReportId": "<复测报告 id>", "fieldId": "<基线报告冻结的视野 id 或名称>" }
```

- 两份报告必须**都存在且互不相同**，并属于**同一切片**（`image_id` 相同；同一更正链中的
  历史报告与链末端天然同一切片，可直接互比）；
- `fieldId` 取自**基线报告**发布时冻结的 `fields`，可为视野 `id` 或**名称**（去首尾空白、精确匹配）；
- 只读取两份报告**发布时冻结**的 calib / cells / fields：草稿后续修改、再发更正都不影响旧报告结果；
  查询不写库。

返回把**基线视野净区域**精确划分的四类结果（像素面积、占视野净面积比例、按基线标尺的 mm²），
以及可直接在基线快照（`baseline.snapshotUrl`）上叠加的 `regionLoops`（各类实际区域，含孔洞方向，
用 `fill-rule="nonzero"` 绘制）与 `boundaryEdges`（`between` 给出边界两侧的类，视野外侧为 `null`）。

错误语义：缺少报告/视野标识 → **400**；基线或复测报告不存在 → **404**；
两份报告相同 → **400**；不属于同一切片 → **400**；视野在基线报告内不存在 → **400**；
视野名称重名无法唯一确定 → **400**（提示改用 id）；
**基线视野 id 被多个冻结视野共用（修复前遗留身份歧义）→ 400**（列出冲突位置；
按基线视野的唯一名称查询仍可选中对应视野）。

```bash
BASE=http://localhost:8080

# 取同一切片的两份不同报告（例如更正链历史报告 b 与链末端 r）及基线冻结视野 id
curl -s "$BASE/api/reports" | jq -r '.[] | "\(.id)\t\(.title)\t切片\(.imageId)"'

# 按视野 id 核对
curl -s -X POST "$BASE/api/reports/field-coverage-diff" \
  -H 'Content-Type: application/json' \
  -d '{"baselineReportId":"'$B'", "retestReportId":"'$R'", "fieldId":"fieldF"}' | jq .

# 按视野名称核对（自动忽略首尾空白）
curl -s -X POST "$BASE/api/reports/field-coverage-diff" \
  -H 'Content-Type: application/json' \
  -d '{"baselineReportId":"'$B'", "retestReportId":"'$R'", "fieldId":"中心视野"}'
```

成功响应（节选；完整内容还包含每类 `regionLoops` / `boundaryEdges` 叠加几何）：

```json
{
  "scope": "report-diff",
  "baseline": { "reportId": "…", "title": "…", "imageId": "img-1", "draftVersion": 4,
                "scaleUmPerPx": 1, "snapshotUrl": "/api/reports/…/file" },
  "retest":   { "reportId": "…", "title": "…", "imageId": "img-1", "draftVersion": 6,
                "scaleUmPerPx": 2 },
  "sameSliceImageId": "img-1",
  "matchedBy": "id",
  "diff": {
    "kind": "report-field-coverage-diff",
    "fieldId": "fieldF", "fieldName": "中心视野", "fieldHoles": 1,
    "fieldAreaPx": 9900, "fieldAreaMm2": 0.0099, "fieldAreaText": "0.0099",
    "classOrder": ["common", "retest", "baseline", "never"],
    "classes": {
      "common":   { "label": "共同覆盖",   "color": "#2e7d32", "areaPx": 3000,
                    "ratio": 0.3030303, "percentText": "30.3%", "areaMm2": 0.003, "areaText": "0.003",
                    "regionLoops": [ [ {"x":0,"y":0}, … ] ], "boundaryEdges": [ … ] },
      "retest":   { "label": "仅复测覆盖", "color": "#1565c0", "areaPx": 2900, … },
      "baseline": { "label": "仅基线覆盖", "color": "#c62828", "areaPx": 3000, … },
      "never":    { "label": "始终未覆盖", "color": "#9e9e9e", "areaPx": 1000, … }
    },
    "sumAreaPx": 9900, "sumPercent": 100,
    "scale": {
      "basis": "baseline", "baselineScaleUmPerPx": 1, "retestScaleUmPerPx": 2, "same": false,
      "note": "两份报告冻结标尺不同：基线 1 px = 1 μm，复测 1 px = 2 μm。本核对的全部物理面积（mm²）与占比均以【基线报告冻结标尺】为唯一换算依据，复测标尺不参与换算。"
    },
    "baselineContributingKeys": ["cellA", "cellB"],
    "retestContributingKeys": ["cellA", "cellC"]
  }
}
```

- `sumAreaPx` 恒等于 `fieldAreaPx`、`sumPercent` 恒为 100%（四类穷尽视野净区域；
  视野孔洞不属于任何一类）；
- `contributingKeys` 列出与视野存在**正面积净交集**的细胞（完全落在视野孔洞内、仅边界接触、
  完全在视野外的细胞不列入；一个细胞被另一细胞完全覆盖时仍可能出现在名单中，
  但并集面积不重复计算）；
- Node.js 调用示例（无第三方依赖）：

```js
const res = await fetch('http://localhost:8080/api/reports/field-coverage-diff', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baselineReportId: B, retestReportId: R, fieldId: 'fieldF' })
});
const body = await res.json();
if (!res.ok) throw new Error(body.error); // 400/404：相同报告/不同切片/不存在/视野歧义
for (const k of body.diff.classOrder) {
  const c = body.diff.classes[k];
  console.log(`${c.label}: ${c.areaPx} px² (${c.percentText}) / ${c.areaText} mm²`);
}
console.log(`合计 ${body.diff.sumAreaPx} px² = 视野净面积 ${body.diff.fieldAreaPx} px²`);
```

页面入口：顶部导航 **覆盖变化核对**（`#/coverage-diff`），勾选两个报告与基线视野后
「核对覆盖变化」，结果表格下方即在基线快照上叠加四类可切换区域与边界。

## 报告单视野网格密度分析 HTTP 接口（行×列网格，只读）

对一份**已发布报告**冻结的**单个取样视野**做网格密度分析：把**视野外接矩形**等分为
`rows × cols` 个格子（**各 1～40 的整数**），返回每格有效面积、细胞数与每 mm² 密度，
以及可在报告冻结快照上叠加的网格几何。只读取报告**发布时冻结**的视野/细胞/标尺：
草稿后续修改、重新定标或报告更正都**不改变**旧报告的分析结果；查询**只读**，不写回报告。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/reports/:id/field-grid` | 请求体 `{ "fieldId": "<视野 id 或名称>", "rows": 4, "cols": 4 }`。报告不存在 → 404；视野标识为空/不存在/重名 → 400；**视野 id 被多个冻结视野共用（身份歧义）→ 400（唯一名称仍可查询）**；行/列数缺失、非整数或越出 1～40 → 400 |

**面积与计数语义**：

- 每格**有效面积** = 格子矩形与视野净区域（外环扣除孔洞）的**几何交集**（平面排列精确计算）；
  **零面积格保留**在结果中（`zeroArea: true`），其密度为 `null`、展示文本为 **「不可计算」**；
  各格有效面积之和等于视野净面积（`sumAreaPx` 与 `fieldAreaPx` 给出校验值）；
- 细胞归属**沿用现有视野统计的净区域质心规则**：只有质心严格落在该视野净区域内的细胞
  才参与分配（与报告 `fieldStats` 中该视野的 `cellCount` 同一口径），每个计入细胞只进入
  质心所在的**唯一格子**；质心落在**内部网格线上归右侧/下侧**格子，落在**最外边线归末格**；
  **各格计数合计恒等于原视野统计**（`sumCellCount` 与 `fieldCellCount` 给出对照）；
- 密度 = 格内细胞数 / 格子有效面积（mm²），按报告**冻结标尺**换算；
  有面积但无细胞的格子密度为 0（可计算）。

成功响应示例（节选；2×2 网格、视野含一个孔洞）：

```json
{
  "scope": "report",
  "reportId": "rep-1",
  "title": "切片A 报告",
  "draftVersion": 4,
  "calibrated": true,
  "scaleUmPerPx": 1,
  "matchedBy": "id",
  "snapshotUrl": "/api/reports/rep-1/file",
  "grid": {
    "kind": "field-grid",
    "fieldId": "fieldF", "fieldName": "中心视野", "fieldHoles": 1,
    "rows": 2, "cols": 2,
    "bounds": { "minX": 0, "minY": 0, "maxX": 100, "maxY": 100 },
    "cellWidthPx": 50, "cellHeightPx": 50,
    "fieldAreaPx": 9900, "fieldAreaMm2": 0.0099, "fieldAreaText": "0.0099",
    "fieldCellCount": 3, "sumCellCount": 3, "sumAreaPx": 9900,
    "cells": [
      { "row": 0, "col": 0, "index": 0,
        "rect": { "x0": 0, "y0": 0, "x1": 50, "y1": 50 },
        "areaPx": 2500, "areaMm2": 0.0025, "areaText": "0.0025",
        "zeroArea": false, "cellCount": 1, "countedCellKeys": ["cellA"],
        "densityPerMm2": 400, "densityText": "400" },
      { "row": 1, "col": 1, "index": 3,
        "rect": { "x0": 50, "y0": 50, "x1": 100, "y1": 100 },
        "areaPx": 2400, "areaMm2": 0.0024, "areaText": "0.0024",
        "zeroArea": false, "cellCount": 1, "countedCellKeys": ["cellC"],
        "densityPerMm2": 416.6667, "densityText": "416.6667" }
    ],
    "overlay": {
      "verticalLines": [0, 50, 100],
      "horizontalLines": [0, 50, 100],
      "centroids": [
        { "key": "cellA", "x": 20, "y": 20, "row": 0, "col": 0 },
        { "key": "cellB", "x": 45, "y": 50, "row": 1, "col": 0 }
      ]
    },
    "calibrated": true
  }
}
```

- `cells` 按行优先顺序给出全部 `rows × cols` 个格子（含零面积格）；
  `index = row × cols + col`（均 0 基）；`rect` 为格子像素矩形；
- `overlay.verticalLines` / `horizontalLines` 为含最外边线的全部网格线坐标（各 rows+1 / cols+1 条），
  `overlay.centroids` 为计入细胞的净区域质心及其所在格子，可直接画在 `snapshotUrl` 返回的冻结图片上；
- 细胞标识 `key` 为细胞 `id`（历史无 id 数据为 `#序号`，与视野统计/比较同一约定）。

curl 示例（`RID` 为报告标识）：

```bash
# 取报告冻结的视野 id
curl -s http://localhost:8080/api/reports/$RID | jq '.fields[] | {id, name}'

# 2×2 网格密度分析（按视野 id）
curl -s -X POST http://localhost:8080/api/reports/$RID/field-grid \
  -H 'Content-Type: application/json' \
  -d '{"fieldId":"fieldF","rows":2,"cols":2}' \
  | jq '.grid | {sumCellCount, fieldCellCount, sumAreaPx, fieldAreaPx,
                 cells: [.cells[] | {row, col, areaPx, cellCount, densityText}]}'

# 按视野名称、10×5 网格
curl -s -X POST http://localhost:8080/api/reports/$RID/field-grid \
  -H 'Content-Type: application/json' \
  -d '{"fieldId":"中心视野","rows":10,"cols":5}'

# 行列数越界 / 视野不存在 → 400；报告不存在 → 404
curl -s -X POST http://localhost:8080/api/reports/$RID/field-grid \
  -H 'Content-Type: application/json' -d '{"fieldId":"fieldF","rows":0,"cols":2}'
# -> { "error": "网格密度分析请求无效：rows（行数） 超出范围，必须在 1～40 之间（收到 0），请求被拒绝" }
```

Node.js 示例（无第三方依赖）：

```js
const base = 'http://localhost:8080';

async function fieldGrid(reportId, fieldId, rows, cols) {
  const res = await fetch(`${base}/api/reports/${reportId}/field-grid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldId, rows, cols })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.status = res.status; // 400：视野标识/行列数非法；404：报告不存在
    throw e;
  }
  const g = body.grid;
  console.log(`视野 ${g.fieldName}：${g.rows}×${g.cols} 网格，` +
              `计数合计 ${g.sumCellCount}＝原统计 ${g.fieldCellCount}，` +
              `面积合计 ${g.sumAreaPx} px²＝净面积 ${g.fieldAreaPx} px²`);
  for (const c of g.cells) {
    console.log(`第${c.row + 1}行第${c.col + 1}列：${c.areaPx} px² / ` +
                `${c.areaText} mm²，细胞 ${c.cellCount}，密度 ${c.densityText} 个/mm²`);
  }
  return body;
}

await fieldGrid(process.env.RID, 'fieldF', 4, 4);
```

页面入口：报告详情页「**视野网格密度分析（发布时冻结）**」面板——选择视野、输入行×列数后
「分析网格密度」，结果表格下方即在报告快照上叠加网格、密度着色与计入细胞质心点，
点击表格行可在快照上定位该格。

## 报告单视野最近质心责任区 HTTP 接口（只读）

对一份**已发布报告**冻结的**单个取样视野**，把视野**净区域**（外环扣除孔洞）按**像素欧氏距离**
分配给最近的**计入细胞**。计入判定**完全沿用现有视野统计规则**：以细胞扣除孔洞后的**净区域质心**
严格落在该视野净区域内（严格在外环内、不在任何孔洞内/边界上）才计入。
只读取报告**发布时冻结**的轮廓/视野/标尺：草稿后续修改、重新定标或报告更正都**不改变**旧报告结果；
查询**只读**，不写回报告。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/reports/:id/field-zones` | 请求体 `{ "fieldId": "<视野 id 或名称>" }`。报告不存在 → 404；视野标识为空/不存在 → 400；视野名称歧义（重名）→ 400（提示改用 id）；**视野 id 被多个冻结视野共用（身份歧义）→ 400（唯一名称仍可查询）**；**id 优先精确匹配** |

**归属与面积语义**：

- 视野净区域内每个内部点归唯一的**最近计入细胞**：先以各计入细胞质心做 Voronoi
  （半平面 `2(sj−si)·p ≤ |sj|²−|si|²` 逐对求交为凸多边形），再与视野（外环+孔洞）做
  **平面排列**精确求交，取该细胞位置严格在内的面按**外正内负有向面积求和**——
  **视野孔洞与视野外部不分配**，跨越孔洞的责任区孔洞部分作为内圈自动扣除；
- **等距边界（平分线）本身没有面积、不计入任何细胞**（落在边界线上的排列面被排除）；
- **质心重合**时按**报告细胞顺序**由首个细胞占有该位置，其余细胞保留 `zeroArea: true`、
  `coincident: true` 的**零面积记录**（`coincidentWith` 注明占有者），不影响面积合计；
- 有计入细胞时各区面积合计**恒等于视野净面积**：`sumAreaPx === fieldAreaPx`、
  `sumAreaMm2 === fieldAreaMm2`、占比合计 `sumPercent === 100`（均为修约后严格相等，
  采用最大余额法分配修约残差）；
- **无计入细胞**时 HTTP 200 返回空结果：`zones.empty === true`、`zones.zones === []`，
  `message` 给出中文提示；视野净面积仍照常返回；
- 未计入细胞在 `excludedCells` 中按 key/名称/序号给出（原因：质心在视野外部或孔洞/边界上，
  或细胞净面积非正无良定义质心），它们**不参与分配、不出现在 zones 中**；
- 面积按报告**冻结标尺**换算（μm/px → mm²，1 mm = 1000 μm）；未定标（历史防御情形）时
  像素面积与占比照常给出，mm² 为 `null`、展示文本为「待定标」。

成功响应示例（节选；4 个计入细胞、视野 (80,80) 处有一个 10×10 孔洞，净面积 9900 px²）：

```json
{
  "scope": "report",
  "reportId": "rep-1",
  "title": "切片A 报告",
  "draftVersion": 4,
  "calibrated": true,
  "scaleUmPerPx": 1,
  "matchedBy": "id",
  "snapshotUrl": "/api/reports/rep-1/file",
  "zones": {
    "kind": "field-zones",
    "fieldId": "fieldF", "fieldName": "中心视野", "fieldHoles": 1,
    "fieldAreaPx": 9900, "fieldAreaMm2": 0.0099, "fieldAreaText": "0.0099",
    "fieldCellCount": 4, "countedCellCount": 4, "ownerCellCount": 4,
    "coincidentCellCount": 0, "excludedCellCount": 2,
    "empty": false, "message": null,
    "zones": [
      {
        "key": "cellA", "name": "甲", "seq": 1, "cellIndex": 0,
        "centroid": { "x": 15, "y": 15 },
        "areaPx": 1600, "areaMm2": 0.0016, "areaText": "0.0016",
        "ratio": 0.161616, "ratioText": "0.161616",
        "percent": 16.16, "percentText": "16.16%",
        "zeroArea": false, "coincident": false, "coincidentWith": [],
        "geometry": {
          "pieces": [ [ {"x":0,"y":0}, {"x":40,"y":0}, {"x":40,"y":40}, {"x":0,"y":40} ] ],
          "holes": [],
          "loops": [ [ {"x":0,"y":0}, {"x":40,"y":0}, {"x":40,"y":40}, {"x":0,"y":40} ] ]
        }
      }
    ],
    "excludedCells": [
      { "key": "cellH", "name": "孔内", "seq": 5, "cellIndex": 4,
        "reason": "净区域质心在视野外部或孔洞/边界上，未计入该视野" }
    ],
    "sumAreaPx": 9900, "sumAreaMm2": 0.0099, "sumAreaText": "0.0099",
    "sumRatio": 1, "sumPercent": 100,
    "overlay": {
      "zones": [
        { "key": "cellA", "colorIndex": 0, "centroid": {"x":15,"y":15},
          "loops": [ [ {"x":0,"y":0}, {"x":40,"y":0}, {"x":40,"y":40}, {"x":0,"y":40} ] ] }
      ],
      "centroids": [
        { "key": "cellA", "x": 15, "y": 15 },
        { "key": "cellB", "x": 65, "y": 15 }
      ]
    },
    "calibrated": true
  }
}
```

- `zones.zones[]` 按**报告细胞顺序**给出每个**计入细胞**一条记录（质心重合的跟随细胞
  面积为 0）：`seq` 为 1 基报告序号、`cellIndex` 为 0 基数组下标；`key` 为细胞 `id`
  （历史无 id 数据为 `#序号`，与视野统计同一约定）；
- `geometry.pieces`（CCW 外圈，可能多个不相连分片）与 `geometry.holes`（CW 内圈）已按方向分好；
  `geometry.loops` 为全部圈（含方向），把同一细胞的所有圈放入一条路径以 **even-odd**
  填充即可在 `snapshotUrl` 的冻结图片上画出实际分区（孔洞自然透出底图）；圈顶点为像素坐标；
- `overlay.zones` 供页面直接叠加（颜色按 `colorIndex` 取调色板），`overlay.centroids`
  为全部计入细胞的净区域质心点。

无计入细胞时的空结果（节选）：

```json
{
  "zones": {
    "kind": "field-zones", "fieldId": "fEmpty", "fieldName": "空野", "fieldHoles": 0,
    "fieldAreaPx": 10000, "fieldAreaMm2": 0.01, "fieldAreaText": "0.01",
    "countedCellCount": 0, "empty": true,
    "message": "该视野净区域内没有计入细胞（没有任何细胞的净区域质心严格落在其中），视野净区域不分配，结果为空。",
    "zones": [], "sumAreaPx": 0, "sumAreaMm2": 0, "calibrated": true
  }
}
```

curl 示例（`RID` 为报告标识）：

```bash
# 取报告冻结的视野 id
curl -s http://localhost:8080/api/reports/$RID | jq '.fields[] | {id, name}'

# 按视野 id 分析责任区
curl -s -X POST http://localhost:8080/api/reports/$RID/field-zones \
  -H 'Content-Type: application/json' \
  -d '{"fieldId":"fieldF"}' \
  | jq '.zones | {fieldName, fieldAreaPx, sumAreaPx, sumPercent,
                 zones: [.zones[] | {key, areaPx, areaText, percentText, zeroArea, coincident}]}'

# 按视野名称（首尾空白会被 trim；重名时报 400 并提示改用 id）
curl -s -X POST http://localhost:8080/api/reports/$RID/field-zones \
  -H 'Content-Type: application/json' -d '{"fieldId":"中心视野"}'

# 错误：视野不存在 / 重名 → 400；报告不存在 → 404
curl -s -X POST http://localhost:8080/api/reports/$RID/field-zones \
  -H 'Content-Type: application/json' -d '{"fieldId":"ghost"}'
# -> { "error": "视野标识不存在：ghost（不属于该报告；请使用本报告发布时冻结的视野 id 或名称），请求被拒绝" }
```

Node.js 示例（无第三方依赖）：

```js
const base = 'http://localhost:8080';

async function fieldZones(reportId, fieldId) {
  const res = await fetch(`${base}/api/reports/${reportId}/field-zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldId })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `HTTP ${res.status}`);
    e.status = res.status; // 400：视野标识为空/不存在/重名；404：报告不存在
    throw e;
  }
  const z = body.zones;
  if (z.empty) {
    console.log(z.message); // 无计入细胞：空结果
    return body;
  }
  console.log(`视野 ${z.fieldName}：净面积 ${z.fieldAreaPx} px²，计入细胞 ${z.countedCellCount} 个`);
  for (const c of z.zones) {
    console.log(`#${c.seq} ${c.name || c.key}：${c.areaPx} px² / ${c.areaText} mm²，` +
                `占 ${c.percentText}${c.coincident ? '（质心重合，零面积）' : ''}`);
  }
  console.log(`合计 ${z.sumAreaPx} px²（＝净面积 ${z.fieldAreaPx}），占比合计 ${z.sumPercent}%`);
  // 在冻结图片上绘制：对每个 zone，把 z.geometry.loops 的全部圈放入一条 Path2D
  // （moveTo/lineTo/closePath），以 evenodd 规则 fill 半透明颜色即可（孔洞自动透出）。
  return body;
}

await fieldZones(process.env.RID, 'fieldF');
```

页面入口：报告详情页「**最近质心责任区（发布时冻结）**」面板——选择视野后「分析责任区」，
结果表格右侧即在报告快照上叠加各细胞实际分区（颜色按细胞）、孔洞透明与计入细胞质心品红点，
**点击快照上的分区**或表格行可高亮定位（再点一次取消）。

## 全部 HTTP 接口一览（既有 + 本轮）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/images` / `POST /api/images` | 草稿列表 / 上传图片（multipart 字段 `image`） |
| `GET /api/images/:id` | 草稿详情（含 `cells`、`fields`、实时 `fieldStats`） |
| `GET /api/images/:id/file` | 原始图片 |
| `PUT /api/images/:id/calibration` | 定标/重定标（带 `version`，过期 409）；视野统计随新比例重算 |
| `PUT /api/images/:id/contours` | 整批保存细胞轮廓（带 `version`；非法 400 整批不生效；过期 409） |
| **`PUT /api/images/:id/fields`** | **整批保存取样视野（带 `version`；非法几何 400 整批不生效；本批 id 重复 400 并指出冲突位置、版本/修订不变；过期 409）** |
| **`POST /api/images/:id/field-merge`** | **多视野合并统计（只读，按草稿当前数据实时计算；不足两个/请求内重复/不存在 400；所选 id 在本数据中身份歧义（重复 id）400）** |
| **`POST /api/images/:id/field-coverage`** | **单视野细胞覆盖核对（只读，几何交集；按草稿当前轮廓/视野/标尺实时计算；视野标识为空/不存在 400、名称重名 400、id 身份歧义 400（唯一名称仍可用），未定标仍给像素面积与覆盖率）** |
| `POST /api/images/:id/publish` | 发布冻结（含视野与统计；带 `version`，过期 409） |
| **`POST /api/images/:id/migrate/preview`** | **迁移预览：三点对应仿射映射 + 逐细胞校验（不写入；返回预览时目标草稿版本）** |
| **`POST /api/images/:id/migrate`** | **确认迁移（带预览时版本，过期 409；任一校验失败 400 整批不写入）** |
| **`GET /api/images/:id/revisions`** | **草稿修订时间线（由新到旧；每次成功写入一条完整快照，失败不留记录）** |
| **`GET /api/images/:id/revisions/:revId`** | **修订完整快照预览（标尺/细胞/视野 + 按该修订标尺的统计；不存在或跨切片 404）** |
| **`POST /api/images/:id/revisions/:revId/restore`** | **恢复修订为当前草稿（带读取时 `version`；过期 409 返回当前版本，目标 404，缺版本 400，均不写入；成功追加新修订不抹历史）** |
| `GET /api/reports` / `GET /api/reports/:id` | 报告列表 / 冻结详情（含 `correctsReportId`、`correctionReason`、`chainId`、`isChainTip`） |
| **`GET /api/report-chains`** | **更正链列表：每条链的当前有效报告、最近更正原因与历史** |
| **`GET /api/reports/:id/trace`** | **追溯某份报告所在更正链（根、末端、位置、由旧到新 members）** |
| **`POST /api/reports/:id/correct`** | **发起更正：`{reason, draftVersion, expectedTipId, title?}`；过期 409 返回最新信息；失败不留报告/快照** |
| **`POST /api/reports/:id/field-merge`** | **报告内多视野合并统计（只读，只取发布时冻结数据；不足两个/请求内重复/不存在 400；所选 id 身份歧义（重复 id）400）** |
| **`POST /api/reports/:id/field-coverage`** | **报告内单视野细胞覆盖核对（只读，几何交集；只取发布时冻结数据；视野标识为空/不存在/不属于该报告/名称重名/id 身份歧义 400，报告不存在 404；唯一名称仍可查询）** |
| **`POST /api/reports/:id/contacts`** | **细胞接触簇分析（只读）：`{thresholdUm}`（μm，允许 0）→ 阈值内邻居/最短净区域间距/连通簇；阈值负数或非有限数 400，报告不存在 404** |
| **`POST /api/reports/:id/field-grid`** | **报告单视野网格密度分析（只读，行×列各 1～40）→ 每格有效面积/细胞数/密度（零面积格「不可计算」）与网格叠加几何；计数合计＝原视野统计；视野标识为空/不存在/重名/id 身份歧义（重复 id）400，行列越界 400，报告不存在 404；唯一名称仍可查询；草稿修改或更正不影响旧报告** |
| **`POST /api/reports/:id/field-zones`** | **报告单视野最近质心责任区（只读，id 优先精确匹配）→ 视野净区域按像素欧氏距离分给最近计入细胞，返回实际分区几何、px²/mm² 与占比；孔洞及外部不分配、等距边界不计面积、质心重合首个占有其余零面积；有计入细胞时合计＝净面积，无计入细胞返回空结果；视野标识为空/不存在/重名/id 身份歧义（重复 id）400，报告不存在 404；唯一名称仍可查询** |
| **`POST /api/reports/field-coverage-diff`** | **同切片两报告单视野覆盖变化核对（只读）→ 四类像素面积/占比/基线标尺 mm² 与叠加几何；相同报告/不同切片/视野不存在或重名/基线视野 id 身份歧义（重复 id）400（基线唯一名称仍可查询），报告不存在 404；旧报告保持冻结** |
| `GET /api/reports/:id/file` / `/png` | 发布时图片快照 / 标注 PNG |
| `GET /api/reports/:id/csv` | 测量 CSV（μm²，原义不变） |
| **`GET /api/reports/:id/field-csv`** | **视野统计 CSV（mm²，与报告页同一冻结结果）** |
| `POST /api/reports/export` | 批量导出 `{ids, format:'csv'\|'png'\|'zip'}` |
| `GET/POST /api/comparisons`、`GET/PUT /api/comparisons/:id`、`GET /api/comparisons/:id/csv` | 报告比较（见上表） |
