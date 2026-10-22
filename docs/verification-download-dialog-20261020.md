# 下载窗口提示与能力边界验证 · 2026-10-20

## 本次问题

用户点击开始下载，清单为空，灰色 example.org 仅为 placeholder。原窗口未充分区分“方案已审核”和“已有可下载文件地址”，也未明确数据库查询页面不能当作原始 CSV 下载。当前通用下载器仍限制每个文件20MB，不支持FAOSTAT按年导出。

## 调整

- 空清单时直接说明原因并禁用开始按钮；示例域名、非HTTP(S)、带登录凭据、超过5个文件和FAOSTAT查询页均先校验，不创建运行记录。
- 仅将方案中有已支持文件扩展名的URL作为预填候选，普通来源网页不再自动变成下载清单。最终执行仍核对方案审核快照，服务端下载安全校验保持。
- 宽窗口与全宽输入区，明确真实地址填写方法；FAOSTAT TM案例显示官方页面普通导航与先导出、再上传的操作说明。
- 保持20MB上限。没有增加数据库自动查询能力，没有下载FAO数据，没有修改用户正式任务或方案。

## 验证

- `node tools/test-download-routing.js`：DOWNLOAD_ROUTING_TESTS_PASS。验证无效清单不联网、不改变方案/历史，数据库页面不预填，有效文件地址仍走原下载接口，审核变化阻止执行。
- `node tools/test-source-download.js`：SOURCE_DOWNLOAD_TESTS_PASS，原文件与来源记录、重定向、大小限制及清洗交接测试通过。
- `node tools/check-contract.js`：ALL_CHECKS_PASS。仅豁免固定的FAOSTAT官方帮助导航标签，非第三方资源或API调用。
- localhost:18126独立测试页面实际验证：空清单、example.org示例地址、FAOSTAT查询页面均明确提示且按钮禁用；有效格式启用按钮，但没有实际执行下载。刷新后审核状态与文件数保留。正式18125浏览器数据未改动。

## 官方来源核对

2026-10-20查阅 https://bulks-faostat.fao.org/production/datasets_E.json ：TM条目 FileSize=410792KB，FileRows=52410630，DateUpdate=2025-12-23，FileLocation为 Trade_DetailedTradeMatrix_E_All_Data_(Normalized).zip。该整库包不能当作只含2024年的数据，且超过本下载器限制；本次只读取目录，未获取整包。

截图：`../../../更新备份/20261020-download-dialog/下载地址提示.png`。
