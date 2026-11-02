(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CleanExecutionPlan = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  // A deliberately narrow execution adapter. The visible approved source stays
  // unchanged; this is not a general natural-language policy interpreter.
  const KNOWN_SOURCE = "## 候选规则草稿\n\n用户“所有的都按着你的推荐的来”适用于此前 v0.1 的推荐；此后 AI 新增的执行细节不自动视为确认。\n\n### 适用范围\n\n仅规范化本批原始表，供后续处理；不涉及商品级估算、汇总或模型计算。\n\n### 输入\n\n- 数据来源：`3f7c827b-FBSH_1992_Afghanistan_练习样本.csv`。\n- 核验依据：`44ae677d-数据来源与范围.txt`，采用摘录范围及用途限制；原包一致性声明不作为独立验证结论。\n- CSV当前位于reference；正式执行时的数据输入副本及版本绑定：待确认。\n\n### 处理步骤\n\n1. 按CSV引号规则读取，保持长表、原13字段及顺序、80条记录及原顺序。\n2. 编码按文本保留，包括前导单引号；年份按整数、Value按十进制验证，不舍入，保留原始文本。\n3. 保留全部原值，包括零值、负值、名称、单位及E/I标记；不翻译、不换算、不自行解释未知含义。\n4. 不补齐组合、不补零、不插补；重复仅报告，不删除；不因数值相同合并不同条目。\n5. 建立原文件名、原数据行号与输出行号的对应关系，并提供字段字典。\n\n### 异常处理\n\n- 全行重复及候选业务键重复仅报告，不自动删除。\n- Flag定义、库存变化符号方向及原包一致性缺乏证据时标注unknown。\n- 解析失败、键冲突、代码名称冲突的具体停止或处置策略：待确认。\n\n### 验收条件\n\n以下为已接受推荐中的候选核验要求，不代表已有结果通过。\n\n### 清洗核验规则\n\n| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n| C1 | 全部原字段 | 核对表头、记录数、字段数及行对应关系 | 原13字段、80条记录；每条输入唯一对应输出，顺序不变 | 全部 | v0.1 R1、R6；用户整体接受推荐 |\n| C2 | Year Code、Year、Value | 验证整数、十进制解析及年份一致性 | 年份可解析且相等；Value精确解析，无舍入 | 全部 | v0.1 R2、C2、C5；用户整体接受推荐 |\n| C3 | Area、Year、Unit、Element Code | 检查本批允许值 | Afghanistan；1992；1000 t；要素码为5511、5611、5911、5074、5142、5521之一 | 全部 | v0.1 C3；用户整体接受推荐 |\n| C4 | Area Code (M49)、Item Code、Element Code、Year | 检查组合键唯一性 | 无重复；发现重复仅报告 | 全部 | v0.1 C4；用户整体接受推荐 |\n| C5 | 全部原字段；代码与名称字段 | 检查新增空值及同代码名称冲突 | 无新增空值；同代码无名称冲突 | 全部 | v0.1 C2、C5；用户整体接受推荐 |\n\n### 原值与结果核对\n\n仅保留原值，不进行改值。依据：用户整体接受v0.1关于保留全部原字段内容、编码单引号、零值、负值、名称、单位及Flag的推荐。\n\n### 人工核验标准\n\n采用来源说明的摘录范围和用途限制，CSV作为记录核对证据。人工结论由研究者给出。\n\n| 编号 | 核验内容 | 检查方法 | 通过条件 | 必需 | 依据 |\n|---|---|---|---|---|---|\n| H1 | 样本用途与范围 | 对照来源说明、方案及结果说明 | 明确为不完整练习样本，未声称完整覆盖或可直接用于正式模型 | 是 | 附件：44ae677d-数据来源与范围.txt，“摘录条件”及最后一段；v0.1 H1 |\n| H2 | 不同条目独立保留 | 查看原数据行28—35及对应输出、处理记录 | Starchy Roots与Potatoes and products均保留，无因数值相同删除或合并 | 是 | 附件：3f7c827b-FBSH_1992_Afghanistan_练习样本.csv，数据行28—35；v0.1 H2 |\n| H3 | 未知含义的表述 | 对照字典、来源说明及原数据行44、49 | 未无依据解释E/I或库存变化符号方向；未知明确标注 | 是 | 附件：3f7c827b-FBSH_1992_Afghanistan_练习样本.csv，Flag字段及数据行44、49；附件：44ae677d-数据来源与范围.txt全文；v0.1 H3 |\n\n### 输出\n\nUTF-8 CSV长表，原13字段及顺序、全部记录及顺序不变；另附字段字典、输入行到输出行对应关系及处理与检查记录。\n\n### 待确认问题\n\n- 正式执行的数据输入副本及版本绑定。\n- 解析失败、重复键或代码名称冲突时的具体处置策略。\n\n以上缺项建议回到本模块继续讨论，不以AI后续新增方案代替研究者决定。";
  const ADAPTER = 'fbsh80-a-preserve-v1';
  const FILE = /(?:[a-f0-9]{8}-)?FBSH_1992_Afghanistan_练习样本\.csv/g;
  const FILE_NAME = /^(?:[a-f0-9]{8}-)?FBSH_1992_Afghanistan_练习样本\.csv$/;
  const SCOPE = /(?:[a-f0-9]{8}-)?数据来源与范围\.txt/g;
  const HEADERS = ['Area Code', 'Area Code (M49)', 'Area', 'Item Code', 'Item Code (FBS)', 'Item', 'Element Code', 'Element', 'Year Code', 'Year', 'Unit', 'Value', 'Flag'];
  const TABLE = '| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|';
  const MANUAL_TABLE = '| 编号 | 核验内容 | 检查方法 | 通过条件 | 必需 | 依据 |\n|---|---|---|---|---|---|';
  const OLD_INPUT = '- CSV当前位于reference；正式执行时的数据输入副本及版本绑定：待确认。';
  const OLD_ERRORS = '- 解析失败、键冲突、代码名称冲突的具体停止或处置策略：待确认。';
  const RESOLVED_ERRORS = '- 解析失败时保存错误位置与证据并停止，不猜测修复；全行或业务键重复仅报告，保留全部记录，不删除、不合并；代码名称冲突时保留原文、列出冲突依据，核验不予通过。';
  const OLD_TAIL = '### 待确认问题\n\n- 正式执行的数据输入副本及版本绑定。\n- 解析失败、重复键或代码名称冲突时的具体处置策略。\n\n以上缺项建议回到本模块继续讨论，不以AI后续新增方案代替研究者决定。';
  const RESOLVED_TAIL = '### 已解决的执行衔接\n\n- 正式输入副本及版本已绑定，执行时核对上述文件名和SHA-256；原始参考材料保留。\n- 解析失败保存证据后停止；重复仅报告并保留；代码名称冲突保留原文和依据，核验不予通过。\n\n本执行版按用户本轮同步平台并直接执行的明确要求，仅解决以上技术衔接。原讨论、原规则和历史版本保留；C1—C5及H1—H3标准不变。H1—H3人工结论仍由研究者填写，本次不代签，也不新增换算。';
  const RESOLVED_TITLE = '## 已确认A规则（执行衔接更新）';
  const BINDING_LINE = /^- CSV输入已绑定：reference原件 `([^`\r\n]+)`；执行input副本 `([^`\r\n]+)`；SHA-256：`([a-f0-9]{64})`。原件保留，执行前核对副本校验值。$/m;
  function normalize(text) {
    return text.replace(/\r\n?/g, '\n').trim().replace(FILE, 'INPUT.csv').replace(SCOPE, 'SCOPE.txt');
  }
  function originalDetails(text) {
    if (typeof text !== 'string' || normalize(text) !== normalize(KNOWN_SOURCE)) return null;
    const original = text.replace(/\r\n?/g, '\n');
    const inputNames = [...new Set(original.match(FILE) || [])];
    const scopeNames = [...new Set(original.match(SCOPE) || [])];
    if (inputNames.length !== 1 || scopeNames.length !== 1) return null;
    return { original, inputNames, scopeNames };
  }
  function bindingLine(binding) {
    return '- CSV输入已绑定：reference原件 `' + binding.sourceName + '`；执行input副本 `' + binding.inputName + '`；SHA-256：`' + binding.sha256 + '`。原件保留，执行前核对副本校验值。';
  }
  function resolvedText(original, binding) {
    // An upload alias can differ between the reference and data areas. Re-point
    // every CSV citation, including H2/H3 evidence, to the frozen input alias;
    // the backend must establish byte identity before saving this version.
    return original.trim().replace(FILE, binding.inputName).replace('## 候选规则草稿', RESOLVED_TITLE)
      .replace(OLD_INPUT, bindingLine(binding)).replace(OLD_ERRORS, RESOLVED_ERRORS)
      .replace(OLD_TAIL, RESOLVED_TAIL);
  }
  function recognize(text) {
    const raw = originalDetails(text);
    if (raw) return Object.assign(raw, { binding: null });
    if (typeof text !== 'string') return null;
    const normalizedLines = text.replace(/\r\n?/g, '\n').trim();
    const line = normalizedLines.match(BINDING_LINE);
    if (!line || !normalizedLines.startsWith(RESOLVED_TITLE + '\n')) return null;
    const binding = { sourceName: line[1], inputName: line[2], sha256: line[3] };
    const restored = normalizedLines.replace(RESOLVED_TITLE, '## 候选规则草稿')
      .replace(line[0], OLD_INPUT).replace(RESOLVED_ERRORS, OLD_ERRORS)
      .replace(RESOLVED_TAIL, OLD_TAIL);
    const details = originalDetails(restored);
    if (!details || !FILE_NAME.test(binding.sourceName) || binding.inputName !== details.inputNames[0]) return null;
    // Re-generation makes the resolved variant just as strict as the source:
    // inserting any additional scientific or processing policy is rejected.
    if (normalizedLines !== resolvedText(details.original, binding)) return null;
    return Object.assign(details, { original: normalizedLines, binding });
  }
  function row(id, field, method, condition, basis) {
    return '| ' + [id, field, method, condition, '全部', basis].join(' | ') + ' |';
  }
  function prepare(text) {
    const recognized = recognize(text);
    if (!recognized) return null;
    const { original, inputNames, scopeNames, binding } = recognized;
    const humanRows = original.split('\n').filter(line => /^\| H[123] \|/.test(line));
    if (humanRows.length !== 3) return null;
    const automatic = [
      row('C1_fields', HEADERS.join('、'), '必需字段', '全部存在', '原A规则C1：原13字段'),
      row('C1_records', '记录数', '记录数', '最小=80；最大=80', '原A规则C1：80条记录'),
      row('C2_year_code', 'Year Code', '数值范围', '最小=1992；最大=1992', '原A规则C2和C3：年份相等且为1992'),
      row('C2_year', 'Year', '数值范围', '最小=1992；最大=1992', '原A规则C2和C3：年份相等且为1992'),
      row('C3_area', 'Area', '允许值', 'Afghanistan', '原A规则C3'),
      row('C3_year_code', 'Year Code', '允许值', '1992', '原A规则C2和C3；原文不变'),
      row('C3_year', 'Year', '允许值', '1992', '原A规则C2和C3；原文不变'),
      row('C3_unit', 'Unit', '允许值', '1000 t', '原A规则C3'),
      row('C3_element', 'Element Code', '允许值', '5511、5611、5911、5074、5142、5521', '原A规则C3'),
      row('C4_key', 'Area Code (M49)、Item Code、Element Code、Year', '唯一键', '组合不重复', '原A规则C4；发现重复仅报告，仍逐条保留')
    ];
    const limitation = '本版结构化检查器不单独证明列顺序、输入输出同序、Value十进制解析及代码名称唯一对应；这些项目须附独立检查证据，不能只凭本表声称全部满足。';
    const executionText = [
      '# A规则等价执行表达',
      '',
      '本版仅将原A文本展开为当前检查器可读取的结构；原稿、讨论和历史版本另行完整保留，未改变数据政策。',
      '数据：' + inputNames[0] + '；来源说明：' + scopeNames[0] + '。',
      ...(binding ? [bindingLine(binding), RESOLVED_ERRORS] : []),
      '仅规范化本批练习样本，不涉及估算、汇总或模型计算。文件仍为13字段、80记录，字段和记录均按原位置、原文本写出。',
      '编码单引号、年份、Value、零、负数、名称、单位和Flag文本均保持原样；整数和十进制解析只作检查，不改写文本。',
      '不翻译、不换算、不补齐、不插补、不合并、不删除。重复仅报告；失败或冲突保留原文件和问题证据，不猜测修复。',
      '附字段字典、输入到输出的逐条对应表、实际处理与检查记录；仅导出本模块结果，不进入计算。H1、H2、H3结论由研究者填写，不写成人工已通过。',
      limitation,
      '',
      '### 清洗核验规则',
      '',
      TABLE,
      ...automatic,
      '',
      '### 原值与结果核对',
      '',
      '仅保留原值，不进行改值。依据：用户已采用原A规则，全部13字段内容、单引号、零、负数、名称、单位及Flag均保持原文。',
      '',
      '### 人工核验标准',
      '',
      MANUAL_TABLE,
      ...humanRows,
      ''
    ].join('\n');
    return {
      schema: 1, adapter: ADAPTER, text, executionText,
      inputReferenceNames: inputNames, standardReferenceNames: scopeNames,
      binding,
      limitations: [limitation],
      // The backend must hash and freeze both texts. No hash is guessed here.
      sourceSha256: null
    };
  }
  function resolve(text, binding) {
    const recognized = recognize(text);
    if (!recognized || !binding || typeof binding !== 'object') return null;
    const bound = { sourceName: binding.sourceName, inputName: binding.inputName, sha256: binding.sha256 };
    if (typeof bound.sourceName !== 'string' || !FILE_NAME.test(bound.sourceName) || typeof bound.inputName !== 'string' || !FILE_NAME.test(bound.inputName) || typeof bound.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bound.sha256)) return null;
    // Never silently replace a version already bound to different bytes.
    if (recognized.binding) return JSON.stringify(recognized.binding) === JSON.stringify(bound) ? prepare(text) : null;
    return prepare(resolvedText(recognized.original, bound));
  }
  return { prepare, resolve };
});
