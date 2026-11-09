# 五库文献流程：实现状态与边界

更新：2026-11-07  
集成分支：`integration/literature-wanfang-parity`  

> 这份文件是给后续 agent 和研究者看的“事实状态”。不要把它当成“全自动投稿流水线已完成”的宣传页。
> 这里明确区分：**已实现并验证**、**已实现但未真实站点验证**、**未实现/受权限限制**。

## 0. 五库全文真机验证总表（2026-11-09 复验）

| 数据库 | 自动检索 | 自动下载 PDF | 证据目录 | 登录方式 |
|---|---|---|---|---|
| 万方 | ✅ 3 条 | ✅ 1.29 MB PDF | `.workbench/final5/wanfang/` | 深大机构登录（`fsso.wanfangdata.com.cn`） |
| 知网 | ✅ 3 条 | ✅ 1.66 MB PDF | `.workbench/fixsample/cnki/` | 深大机构登录（`fsso.cnki.net`） |
| Web of Science | ✅ 2–3 条 | ✅ 104 KB PDF | `.workbench/fixsample/wos/` | 深大 accproxy 校外通道 |
| Scopus | ✅ 3 条 | ✅ 2.34 MB PDF | `.workbench/final5/scopus/` | 深大 accproxy 校外通道 |
| Google Scholar | ✅ 3 条 | ✅ 91 KB PDF | `.workbench/final5/google-scholar/` | 无需登录（免费索引库） |

2026-11-09 复验同时修了三处工程问题：

1. **headless 被站点识别**：后台模式默认 UA 带 `HeadlessChrome`，万方/Scopus/Scholar 直接判成机器人
   （Scholar 出验证码、另两库结果页空白）。启动改为发送普通桌面 Chrome 的 UA + `--lang=zh-CN`，
   五库在无窗口模式下全部恢复。
2. **WoS 结果页被开在新标签**：代理镜像有时把 summary 开在新 tab 而把表单页留在 `basic-search`，
   原流程只看当前页 → 误报“列表未加载”。现在会采纳标题匹配的新 summary 标签并回写绑定。
3. **研究标签跨批次堆积**：每轮检索留一个 summary 页，累计到 22 个后浏览器变慢、其他库开始超时。
   新增 `_retire_stale_pages()`：只清理同一来源的旧页，绝不碰研究者其他页面。
4. **抽样时 WoS 半截页被判失败**：镜像渲染的行数可能少于结果头声称的数量，
   抽样模式（非正式检索）允许在“列表已停止加载且行可读”时接受；
   正式检索仍严格拒绝半截页（113 项 WoS 回归保证）。

## 1. 五库与检索

已接入的五库配置（`config/confirmed-climate-research.json`，按生产/排放两条线共 10 组）：

| 数据库 | 来源 key | 接入方式 |
|---|---|---|
| 中国知网 | `cnki` | 持久浏览器，人工登录/机构权限 |
| 万方 | `wanfang` | 持久浏览器，人工登录/机构权限 |
| Web of Science | `web-of-science` | 持久浏览器，机构订阅 |
| Scopus | `scopus` | 持久浏览器，机构订阅 |
| Google Scholar | `google-scholar` | 持久浏览器，可能人机验证 |

> **五库不含 PMC/PubMed。** PMC、Europe PMC、OpenAlex、PubMed 是其他流程使用的开放检索/全文源；
> 在本五库任务里，PMC/Europe PMC 只作为**全文与补充材料解析器**出现，不参与五库检索，也不是“第六个库”。
> 代码层已由 `tools/literature-confirmed-plan.js` 的 `FIVE_SOURCE_KEYS` 白名单强制：五库方案
> 出现 `pmc` 等非五库来源会直接报错，不会准备任务。
>
> **界面边界（2026-11-04 已收紧为严格五库）**：文献任务的来源勾选只剩五项
> （Google Scholar、知网、万方、Web of Science、Scopus）。`PubMed / PMC / OpenAlex / Europe PMC /
> Semantic Scholar` 已在 `tools/literature-sources.json` 标记为 `state: "registered"` 并写明原因，
> 不再进入执行链：请求这些来源会得到冻结文案“尚未接通以下检索来源…”。
> 条目**保留**而不是物理删除，因为 PMC/Europe PMC 仍是全文与补充材料解析器，历史任务也靠这些 key 识别；
> `fulltext` 解析路径不经过来源注册表，已验证不受影响（`test_literature_pipeline.py` 20 项、
> `test_literature_search_open.py` 86 项、`test-literature-sources.js`、`test-research-question.js` 31 项、
> `test-literature-ui-stage2.js`、`test-literature-runtime-ui.js` 全绿）。
> 另有两个**既有失败**与本次改动无关：`test-literature-auxiliary.js`（400/409 忙态顺序）、
> `test-literature-http-stage2.js`（409/202 逐项核查关口）；`test-literature-screening-live.js` 需 `--live`。

- 检索式按来源分别保存，不再把一条 Scholar 语法复制给所有库。
- 开跑前有逐项核查（研究范围、来源与检索式、纳排与交付、执行边界）；确认快照写入任务目录。
- 任务、讨论、确认记录、候选与材料按任务隔离；新建/切换不会自动重跑。

## 2. 篇关摘三态筛选

代码入口：`tools/literature-screening.js`、`tools/literature-screening-pipeline.js`、`tools/literature_screening.py`、`tools/literature_metadata.py`。

| 判定 | 含义 | 全文队列 |
|---|---|---|
| `include` | 已明确满足全部必要条件 | 下载 PDF/全文 |
| `pending` | 没有明确排除证据，但关键资格待全文确认 | **也下载**，默认不提取 |
| `exclude` | 规则明确不符合且无其他合格部分 | 不下载，保留排除理由 |

硬规则：

- 未取得完整摘要 → 自动转 `pending`，不能用检索片段当摘要排除。
- 模型不可用 → 停在 `screening_unavailable`，不会自动排除任何文献。
- 全文阶段开始前会校验筛选记录与规则版本；未筛选/过期时暂停，不会把全部候选直接下载。
- 排除项保留在状态与审计文件里，不静默删除。

**结论：三态筛选 + “确定不是就不下载”的闸门已实现。**

## 3. 全文与补充材料

代码入口：`tools/literature_fulltext.py`、`tools/literature_fulltext_browser.py`、`tools/literature_cnki_fulltext.py`、`tools/literature_wanfang_fulltext.py`、`tools/literature_materials.py`。

已实现：

- 正文优先级：平台原生 PDF（知网/万方/出版社）→ Europe PMC/PMC PDF → PMC JATS 全文 → 文章页 HTML → DOI 落地页。
  （这里的 PMC/Europe PMC 只是在解析全文，不是五库检索来源。）
- **万方原生全文适配（2026-11-03，同日补齐与知网同级的处理）**：`literature_wanfang_fulltext.py`
  导航官方详情页（`d.wanfangdata.com.cn/periodical|thesis|conference/...`），核对题名/DOI；
  身份与页面结构连续两次一致后才点击；购买/付费/订阅控件不进入候选；点击前把点击痕迹写入
  `wanfang_flow`（全生命周期最多两次点击），中断后不静默重复点击，需显式 `--restart-wanfang`；
  下载事件必须归属本任务页面；支持 `metadata_only`/`materials_only`，并在详情页采集补充材料。
  登录/付费/机构权限文本返回 `access_required`，不绕过、不把错误页当 PDF。
  落盘证据按来源标注（`wanfang_normal_navigation`）并保留 `acquisition_method`，失败文案不再复用知网措辞。
  **离线回归 28 项已通过。2026-11-03 真实站点实测：检索 → 详情页 → 唯一控件 → 点击全部正常，
  点击目标确认为万方原生下载服务 `oss.wanfangdata.com.cn/file/download/perio_*.aspx`；
  8 篇样本与 3 次重试全部跳转 `my.wanfangdata.com.cn/auth/user/alllogin.do`，无匿名 PDF；
  按篇点击痕迹（`wanfang_flows`）在真实重试中生效，未发生重复点击。**
- 正文完整性：PDF 校验 `%PDF`/EOF/大小/传输；HTML/JATS 校验核心章节，`partial` 不进入提取。
- 补充材料：按已验证文章页枚举附件，保留原格式；区分 `downloaded / missing / needs_attention / uninspected / none_declared`。
- 断点续跑、单篇重试、访问受限逐篇暂缓、已保存文件按 SHA 复用。
- **CDP 原生下载兜底**：研究者浏览器通过 CDP 附着时，Chrome 可能直接保存文件而不发 Playwright `Download` 事件；任务页设置 page-scoped 下载目录，只接受完成且通过 PDF 校验的文件。**2026-11-06 修复知网竞态**：知网会先抛一个 0 字节 `Download` 事件，真实 PDF 随后写入下载目录；适配器在事件读取失败时回退到下载目录取文件，并要求 `%%EOF`（末 2 KiB 内）才接受，避免截断文件被当成功。
- **PMC 补充材料**：PMC 附件页可能返回 JavaScript proof-of-work 挑战；改用 Europe PMC 稳定 OA 包
  `https://www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/supplementaryFiles`，按 JATS 文件名取 ZIP 成员，不实现/绕过验证挑战。
- **WoS/Scopus 索引记录解析（2026-11-06）**：通用 `fetch_page` 遇到 accproxy 的 Scopus/WoS 记录页时，
  提取 DOI → 解析出版社 → 把出版社 host 重写为 accproxy → 优先取 `citation_pdf_url`。
  Scopus 直接读页面 DOI；WoS 用官方 Export（Plain text / Full Record）读 `DI` 字段，再退回 Crossref 题名反查。
  真机各 1/1 落 PDF：Scopus 2,338,023 字节、WoS 9 页 104,784 字节。
- **附件链接跨进程持久化**：稳定、无 token/签名的链接写入 `fulltext/material-links.json`；`materials.json` 本身不写临时链接。
- 直接/包下载没有打开子窗口时，不再把“无需清理”误报成“清理失败”。

## 4. 真实冒烟证据（2026-11-02）

开放获取 PMC 样本 3 篇（`PMC13714334`、`PMC13722600`、`PMC13718310`）：

- 正文完整 3/3：PDF 2 篇 + JATS/HTML 1 篇。
- 补充材料 `AAS-71-0-s001.docx` 成功下载，892,828 字节；该篇 `materials_completeness = complete`。
- 另两篇补充材料仍为 `unverified`（页面验证/补材入口未闭合），未虚报齐全。
- 任务目录：`.workbench/literature/d615944d-ffe3-4d1a-bd91-585f12042d57/`（本机运行产物，不随 Git 提交）。

回归：

- `python tools/test_literature_materials.py`：28 项
- `python tools/test_literature_materials_browser.py`：32 项
- `python tools/test_literature_fulltext.py`：71 项
- `python tools/test_literature_cnki_fulltext.py`：83 项
- `python tools/test_literature_wanfang_fulltext.py`：7 项（离线点击/付费拦截）
- `python tools/test_literature_fulltext_browser.py`：27 项
- `python tools/test_literature_cdp_download.py`：8 项
- `node tools/check-contract.js`：`ALL_CHECKS_PASS`

## 5. 尚未完成 / 不要宣称完成

1. **知网真实自动 PDF：首篇已闭环，批量未验证**
   - 2026-11-06 研究者在专用浏览器完成深大机构登录（页头 `.ecp_header_unitName` 显示“深圳大学”），
     同一适配器随后完成首篇真实自动落盘：`肉鸡规模养殖通风系统与CFD仿真技术应用研究`，
     6 页 / 742,130 字节 / `fetched_pdf`，`pdf_magic=true`、`eof_marker=true`、`transfer_completed=true`，
     证据目录 `.workbench/cnki-login-demo4/job/fulltext/`。
   - 同日修复两个执行层缺陷：① 知网 `WebFastLoad` 在 `%%EOF` 后追加 `<FileProperty>` 元数据，
     PDF 校验改为“末 2 KiB 内出现 `%%EOF`”，不再要求文件以 EOF 结尾；
     ② CDP 附着模式下知网先抛一个 0 字节 `Download` 事件、真实 PDF 落在 page-scoped 下载目录，
     适配器在事件读取失败时回退到该目录取文件，并要求 EOF 才接受，避免把截断文件当成功。
   - 仍未闭环：批量/频率限制、CAJ-only 样本、多个完全同名结果（按安全规则暂停，需人工确认）、
     其他订阅出版社。不能声称“知网全文已全量自动获取”。

2. **万方：机构登录后小样已闭环（匿名会话仍是登录/付费墙）**
   - `literature_wanfang_fulltext.py` 已实现官方详情页定位、题名/DOI 核对、稳定性复核、
     付费控件排除、按篇点击痕迹与两次上限、Download/CDP/PDF 响应捕获（含归属校验）、
     补充材料采集和登录/付费拦截；离线 28 项通过。
   - 2026-11-03 匿名实测：无痕检索 8 篇、重试 3 次，全部在点击官方下载控件后跳转
     `my.wanfangdata.com.cn/auth/user/alllogin.do`，`service` 指向真实下载端点
     `oss.wanfangdata.com.cn/file/download/perio_*.aspx`；没有一篇拿到 PDF。
   - **2026-11-04 机构登录实测（小样 2 篇）：2/2 拿到原版 PDF，付费墙消失。**
     研究者在平台专用浏览器完成深大统一身份认证后，万方页头显示机构名“深圳大学”；
     同一适配器点击官方下载控件 → `fulltext/files/` 落盘 1.29 MB/12 页 与 2.95 MB/13 页，
     `parser_status=valid`、`identity_method=pdf_text_title`、`acquisition_method=wanfang_official_download`。
     第 2 篇首次 `page_not_ready`，按其自身提示显式重试即成功——不是权限问题。
     证据目录：`.workbench/wanfang-login-demo/job/fulltext/`（`status.json` + `files/`）。
   - 仍未闭环的部分：知网同样路线、大规模批次的站点频率限制、CAJ-only 样本、订阅出版社全文。
     小样成功不等于“万方全文已全量自动获取”。
   - **机构登录路线（2026-11-04 核实并由主人确认为后续主路线）**：深圳大学已订购万方系列
     （期刊/学位论文/会议/外文/标准/地方志），机构登录有两条实测可用的校外通道：
     ① Shibboleth/CARSI 联邦登录
     `https://shibboleth.wanfangdata.com.cn/Shibboleth.sso/Login?entityID=https%3A%2F%2Fidp.szu.edu.cn%2Fidp%2Fshibboleth&target=https%3A%2F%2Fshibboleth.wanfangdata.com.cn%2F`
     （302 到 `idp.szu.edu.cn` 的 SAML2 SSO，即深大统一身份认证；万方 FSSO 机构列表中
     “深圳大学”的 entityID 即 `https://idp.szu.edu.cn/idp/shibboleth`）；
     ② EZproxy `http://ezproxy.lib.szu.edu.cn/login?url=https%3A%2F%2Fc.wanfangdata.com.cn%2Fperiodical`
     （302 到 `www.lib.szu.edu.cn/erauth/extcas.aspx`）。
     做法（已实测）：在持久研究浏览器 profile（CDP 9222，`SOC-database-pipeline-clean/.codex/skills/soc-paper-fetch/state/user-data`）
     里由研究者本人登录一次，适配器复用同一 profile 的 cookie 重跑；不在代码里代填账号密码、不绕过登录/验证码。
     登录态落在 `.wanfangdata.com.cn` 的 `CASTGC` 与 `shibboleth.wanfangdata.com.cn` 的 `_shibsession_*`。
   - **多机构通用化（2026-11-04，仅万方）**：命中 `login` 登录墙时，适配器在专用浏览器**新开一个标签**
     打开万方自己的 `https://fsso.wanfangdata.com.cn/`（“万方数据高校/机构外部访问系统”），
     由研究者选择**自己所在学校**并完成认证；代码不写死任何学校 entityID，同一 profile 只开一次。
     这与知网现有范式一致：代码只认“墙”，不认“学校”（知网对应入口 `https://fsso.cnki.net/`，
     2026-11-06 已作为白名单目标接入，见下条）。
     离线 35 项（含 7 项新增：登录墙识别、只开一次、无 context 兜底、入口不含 entityID）。
   - **任务前「账号与权限」面板（2026-11-05，2026-11-06 扩到五库 + EZproxy）**：文献挖掘 → 文献任务顶部一块，
     按钮为「打开机构登录」（万方 `https://fsso.wanfangdata.com.cn/`）、「知网机构登录」
     （`https://fsso.cnki.net/`）、「Web of Science 登录」
     （深大图书馆校外通道 `https://www.lib.szu.edu.cn/er/access/18818`，经
     `www-webofscience-com.accproxy.lib.szu.edu.cn` 带机构权限）、
     「Scopus 登录」（深大图书馆校外通道 `https://www.lib.szu.edu.cn/er/access/18457`，经
     `www-scopus-com.accproxy.lib.szu.edu.cn`；直连 `/signin.uri` 在新版返回 404，
     Clarivate 个人登录页没有机构入口）、「EZproxy 统一登录」
     （默认 `http://ezproxy.lib.szu.edu.cn/login`，可用环境变量 `LITERATURE_EZPROXY` 覆盖）、
     「打开万方会员」（`https://svip.wanfangdata.com.cn/`）、「检查登录状态」。
     后端 `POST /api/literature/access-page` 只接受
     `institution|purchase|cnki|wos|scopus|ezproxy` 六个白名单目标（拒绝任意 URL、拒绝多余字段）；
     `POST /api/literature/access-status` 只接受
     `wanfang|cnki|wos|scopus|ezproxy|all`，逐个返回 `signedIn/name/message`；两者都不读凭据、不代填、不代付。
     登录态仍由专用浏览器保存（勾“7天免登录”约 7 天），普通浏览器不共享。
     实现注意：登录后页头里的“万方会员”文案会消失，身份识别必须按页头容器
     `.anxs-8qwe-top-rt` 与机构标签 `.anxs-8qwe-list-jg` 读取，否则会把已登录误判成未登录。
     同时 `access_required` 也纳入自动开机构入口（此前只有 `login` / `verification`）。
     离线：`test_literature_access.py` 24 项、`test-literature-access.js`、`test_literature_wanfang_fulltext.py` 41 项。
   - **五库状态判定的验证边界（2026-11-06）**：
     - 已验证：六个入口 URL 可达（`fsso.cnki.net` 200、`access.clarivate.com` 200、
       EZproxy 302 到 `authserver.szu.edu.cn`）；判定逻辑离线用例 27 项通过。
     - 已验证（隐藏桌面真机冒烟，9333 独立 profile，未登录态）：五个来源均返回明确判定且无误报——
       万方“未登录或页面要求验证”、知网“未检测到个人登录（页面显示机构/个人登录入口）”、
       WoS“未登录（检测到登录表单）”、Scopus“仅预览（未获得机构/个人访问权限）”、
       EZproxy“需要完成统一身份认证/多因子认证”。其中知网曾把正文里的“机构”二字误当机构名，
       已改为“必须带冒号的机构/单位标签”才提取；EZproxy 跳到统一认证页时不再报“未判定”。
     - 已验证（2026-11-06 深大校外通道）：`/er/access/18818` 落到
       `www-webofscience-com.accproxy.lib.szu.edu.cn`（状态探测时进一步跳到中国镜像
       `webofscience-clarivate-cn.accproxy.lib.szu.edu.cn`），`/er/access/18457` 落到
       `www-scopus-com.accproxy.lib.szu.edu.cn`；Scopus 页头从“Scopus Preview”变为“Scopus”，
       说明机构权限生效。两条通道依赖已登录的 EZproxy 会话；会话过期时跳回深大统一认证。
     - 未验证：登录成功后的“已登录/机构名”显示（需研究者本人在可见 profile 完成登录），
       以及登录后各库真实全文。WoS/Scopus 的“可访问”只代表最终落在 `webofscience.com` /
       非 `signin.uri` 且无 Preview 标记，可能是 IP/机构授权，也可能只是页面结构变化；
       不能当作“个人已登录”。
     - EZproxy 限制：面板只负责“登录一次”，不重写适配器 URL。适配器仍走原始数据库地址，
       不会自动带上 EZproxy 机构权限；要覆盖出版社全文，还需要把全文导航改成
       `ezproxy.../login?url=<target>` 形式并真机验证。
   - **隐藏桌面跑实测（2026-11-05）**：`tools/hidden_research_browser.py` 用 `virtual-desktop` 技能在独立桌面启动
     独立 Chromium（独立 profile + CDP 端口 9333），窗口不出现在用户桌面；`launch` 由 detached keeper 持有桌面句柄
     （桌面句柄一关进程就会被带走）。登录态用 `seed` 通过 CDP 从可见浏览器复制 cookie（不落盘）。
     适配器支持 `LITERATURE_CDP_PORT=9333` 指向隐藏浏览器。已验证：CDP 连通、页面渲染、截图非空白；
     会话过期时两边都会退成“登录/注册”，需要在可见浏览器重登后再 seed。
   - **2026-11-04 实测修正**：匿名访问万方时先出现的是**滑块安全验证（`verification`）**，不是登录表单；
     早前只挂 `login` 的入口在真实新用户场景中永不触发。现改为 `login` 与 `verification` 都打开机构入口，
     文案分别提示“登录”与“可完成滑块或改用机构登录”。离线 38 项；清空 cookie 真机复验：返回
     `verification` 且新标签确实落在 `https://fsso.wanfangdata.com.cn/`（标题“万方数据高校/机构外部访问系统”），
     恢复 cookie 后页头“深圳大学”仍在。
   - **2026-11-04 UI 实测发现（未修）**：① 单篇 `page_not_ready` 会让整批暂停，后续 7 篇保持 `pending`，
     与界面“继续其余文献”的文案不一致，需人工反复点「继续获取全文」；② 下载点击弹出的
     `oss.wanfangdata.com.cn/Fulltext/Download?fileId=...` 页面不会被关闭，同一篇重复 2–3 个，
     一次 10 篇试跑后专用浏览器累积到 19 个标签；③ 部分文献的下载页需手动点“点击此处”，
     适配器只报 `page_not_ready`，未在文案里指出该操作。

3. **WoS/Scopus：自动检索已通；Scopus 全文已通一篇，WoS 全文待补**
   - 2026-11-06 把检索入口切到深大 accproxy（可用 `LITERATURE_WOS_SEARCH` / `LITERATURE_SCOPUS_SEARCH` 覆盖）：
     WoS `www-webofscience-com.accproxy.lib.szu.edu.cn`、Scopus `www-scopus-com.accproxy.lib.szu.edu.cn`。
     真机：WoS 3 条、Scopus 3 条；`test_literature_search_open.py` 86 项通过。
     修复：WoS 中国镜像字段选择器、OneTrust 同意遮罩拦截点击、提交后异步跳转等待、
     WoS 登录误判（“Sign in to access”只是个性化提示，不是登录墙）。
   - Scopus 全文链路已验证 1/1：Scopus 记录页 → 提取 DOI → 出版社 host 重写为 accproxy →
     `link-springer-com.accproxy.lib.szu.edu.cn/content/pdf/...pdf` 落盘（OA 样本）。
     证据 `.workbench/scopus-login-demo4/job/fulltext/`。
   - WoS 全文链路已验证 1/1：`full-record` 页不暴露 DOI，改为点击官方 Export → Plain text file →
     Full Record 下载纯文本，读取 `DI` 字段 → DOI → 出版社 host 重写 accproxy → PDF 落盘
     （`Effects of heat stress on broiler meat quality`，9 页 / 104,784 字节 / `fetched_pdf`）。
     证据 `.workbench/wos-doi-demo/job/fulltext/`。无 DOI 的老文献（如 2013 年 Revue de Médecine Vétérinaire 样本）
     导出没有 `DI`，Crossref 也查不到，仍只回退摘要——这是样本本身没有 DOI，不是链路失败。
   - 订阅出版社（Elsevier/Springer/Wiley 非 OA）仍取决于学校订阅；不绕过订阅墙、验证码或下载配额。

4. **非 PMC 补充材料未验证**
   - 通用页面扫描已实现；Elsevier/Springer/Wiley/Frontiers/MDPI 等真实补充材料入口未逐一实测。
   - “没找到”不等于“作者声明没有”；状态必须保留 `unverified/needs_attention`。

5. **五库正式生产批次未完整跑完**
   - 已有一条历史任务越过知网第一篇停点，但 3814 条级任务没有全部跑完，PDF 覆盖未声明完整。

## 6. 继续验证的最小步骤

1. 用研究者已登录的持久浏览器启动一个“小样测试”任务。
2. 准备 3–5 篇有权限的知网样本：正常 PDF、仅 CAJ、下载报错、带附件、需登录各一类；
   另准备 3 篇有权限的万方样本（PDF、CAJ-only、付费墙各一类）。
3. 执行：检索/导入 → 去重 → 篇关摘筛选 → 全文获取。
4. 检查 `fulltext/status.json`、`materials.json`、`download-diagnostics.jsonl` 和实际文件。
5. 只有实际文件落盘并通过校验，才把对应能力标为“已验证”。

## 7. 给后续 agent 的硬约束

- 不把“页面显示 Full access”当作“文件已下载”；以 `fulltext/files/` 与 `fulltext/materials/` 的实际文件为准。
- 不把人工下载、隔离测试或旧任务缓存算作自动下载成功。
- 不绕过登录、订阅、验证码、下载配额；遇到就记录 `access_required/login/verification` 并保留页面。
- 不把“未找到补充材料”写成“作者声明没有”；只有明确声明才 `none_declared`。
- 修改前端时保持现有工作台风格与既有 class/DOM 结构，不借机重做界面。
