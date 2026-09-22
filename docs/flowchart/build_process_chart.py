# -*- coding: utf-8 -*-
"""流程智能体 —— 业务流程与能力节点流程图（draw.io）

内容来源：
1. 业务说明：流程智能体分两步 —— 研究写作过程（6 步）+ 投稿审稿到发表过程（3 步）
2. 模块能力说明表（v3 按新理解重绘）：
   - 两条并行准备流水线：数据流水线（下载更新数据 → 数据清洗 → 人工审核验收标准）
     与参数流水线（更新参数数据 → 文献数据挖掘 → 人工审核验收标准）
   - 两条流水线的产物（清洗后的活动数据 + 参数数据）共同构成「计算」的输入
   - 计算有两种方式：① 直接计算（计算方法不变，直接改 input 得到结果）；
     ② 接入新模块（先「数据对齐」并把对齐方法写成代码，再运行计算）
   - 计算输出后：结果要人审核 → 有问题则自动定位（数据 / 对齐 / 运行代码）→ 回退修正

设计约定（沿用 drawio-flowcharts 既有风格 + 论文流程图规范）：
- 主流程横向（阶段一 6 步 / 阶段二 3 步）；流水线与计算区内部按行/列展开
- 蓝色圆角框 = 智能体自动执行；橙色菱形 = 人工审核/判断；绿色 = 输出；紫色 = 定位与诊断
- 虚线灰箭头 = 未通过/定位后的回退路径；全部正交走线，无阴影无渐变
- 全图中文字体：Microsoft YaHei；字号统一按 FONT_SCALE 放大，保证缩到论文宽度仍可读
"""
import os
import re
import xml.dom.minidom as minidom
from xml.sax.saxutils import quoteattr

BASE = os.path.dirname(os.path.abspath(__file__))
# 全图字号统一放大系数：画布 1660pt 宽，正文 12pt 缩到论文宽度后仅约 3pt 不可读，
# 放大后正文 16pt，配合"整页横向插图"排版可读。
FONT_SCALE = 1.35


def V(cid, value, style, x, y, w, h, parent="1"):
    return (f'<mxCell id="{cid}" value={quoteattr(value)} style={quoteattr(style)} '
            f'vertex="1" parent="{parent}"><mxGeometry x="{x}" y="{y}" width="{w}" '
            f'height="{h}" as="geometry"/></mxCell>')


def E(cid, style, source, target, value="", points=None, offset=None, parent="1"):
    geom = '<mxGeometry relative="1" as="geometry">'
    if points:
        geom += '<Array as="points">' + ''.join(
            f'<mxPoint x="{px}" y="{py}"/>' for px, py in points) + '</Array>'
    if offset:
        geom += f'<mxPoint x="{offset[0]}" y="{offset[1]}" as="offset"/>'
    geom += '</mxGeometry>'
    return (f'<mxCell id="{cid}" value={quoteattr(value)} style={quoteattr(style)} '
            f'edge="1" parent="{parent}" source="{source}" target="{target}">{geom}</mxCell>')


def scale_fonts(xml_str):
    """把 XML 里所有显式字号（style 的 fontSize=N 与 html 值里的 font-size:Npx）按 FONT_SCALE 放大。"""
    xml_str = re.sub(r'fontSize=(\d+(?:\.\d+)?)',
                     lambda m: 'fontSize=%d' % round(float(m.group(1)) * FONT_SCALE), xml_str)
    xml_str = re.sub(r'font-size:(\d+(?:\.\d+)?)px',
                     lambda m: 'font-size:%dpx' % round(float(m.group(1)) * FONT_SCALE), xml_str)
    return xml_str


def wrap(did, name, W, H, cells):
    body = scale_fonts(''.join(cells))
    xml = (f'<mxfile host="ZCode" type="device"><diagram id="{did}" name="{name}">'
           f'<mxGraphModel dx="900" dy="700" grid="0" gridSize="10" guides="1" tooltips="1" '
           f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" '
           f'pageHeight="{H}" math="0" shadow="0" adaptiveColors="auto">'
           f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>{body}</root>'
           f'</mxGraphModel></diagram></mxfile>')
    minidom.parseString(xml)          # 校验 XML 合法
    return xml


# ---------------- 样式 ----------------
F = 'fontFamily=Microsoft YaHei;'
AUTO = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#DAE8FC;strokeColor=#6C8EBF;fontSize=12;' + F
HUMAN = 'rhombus;whiteSpace=wrap;html=1;fillColor=#FFE6CC;strokeColor=#D79B00;fontSize=12;' + F
OUTB = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#D5E8D4;strokeColor=#82B366;fontSize=12;' + F
PARAM = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#E1D5E7;strokeColor=#9673A6;fontSize=12;' + F
CONT = ('rounded=1;whiteSpace=wrap;html=1;fillColor=#FAFAFA;strokeColor=#B3B3B3;'
        'container=1;collapsible=0;verticalAlign=top;fontSize=12;' + F)
EDG = ('edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#333333;'
       'endArrow=classic;endSize=4;fontSize=11;' + F)
DASH = ('edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#999999;dashed=1;'
        'endArrow=classic;endSize=4;fontSize=11;' + F)
TXT = 'text;html=1;align=center;verticalAlign=middle;' + F

_seq = [0]


def title_txt(x, y, w, h, text, size=14, align='left', color='#1F2933', bold=True, parent='1'):
    _seq[0] += 1
    st = (f'text;html=1;align={align};verticalAlign=middle;fontSize={size};'
          f'fontColor={color};' + ('fontStyle=1;' if bold else '') + F)
    return V('lt%d' % _seq[0], text, st, x, y, w, h, parent=parent)


def small(t, size=9.5, color='#5B6B7C'):
    """框内第二行小字注解"""
    return f'<font style="font-size:{size}px;color:{color}">{t}</font>'


cells = []
PAGE_W, PAGE_H = 1720, 1360

# ---------------- 标题与图例 ----------------
cells.append(title_txt(40, 22, 1000, 34, '流程智能体 · 业务流程与能力节点', 22))
cells.append(title_txt(40, 60, 1000, 22,
                       '两阶段主流程（研究写作 6 步 → 投稿发表 3 步）+ 数据/参数两条流水线 → 计算（两种方式）',
                       11, 'left', '#5B6B7C', False))

cells.append(V('lgbox', '', 'rounded=1;html=1;fillColor=#FFFFFF;strokeColor=#DCDCDC;' + F,
               1178, 16, 502, 68))
cells.append(V('lg1', '', AUTO, 1190, 26, 34, 18))
cells.append(title_txt(1230, 24, 200, 20, '智能体自动执行', 11, 'left', '#1F2933', False))
cells.append(V('lg2', '', HUMAN, 1420, 22, 30, 26))
cells.append(title_txt(1456, 24, 220, 20, '人工审核 / 判断', 11, 'left', '#1F2933', False))
cells.append(V('lg3', '', OUTB, 1190, 56, 34, 18))
cells.append(title_txt(1230, 54, 200, 20, '输出 / 成果', 11, 'left', '#1F2933', False))
cells.append('<mxCell id="lg4" value="未通过 → 回退修正" style='
             + quoteattr(DASH) + ' edge="1" parent="1">'
             '<mxGeometry relative="1" as="geometry"><mxPoint x="1420" y="69" as="sourcePoint"/>'
             '<mxPoint x="1520" y="69" as="targetPoint"/></mxGeometry></mxCell>')

# ---------------- 阶段一：研究写作过程（6 步） ----------------
cells.append(V('phase1', '', CONT, 40, 96, 1640, 216))
cells.append(title_txt(20, 10, 700, 26, '阶段一 · 研究写作过程（6 步）', 14, parent='phase1'))
S1 = [
    ('s1', '① 文献调研', '相关知识检索与整理', AUTO),
    ('s2', '② 科学问题的凝练与提取', '从文献中提炼研究问题', AUTO),
    ('s3', '③ 数据获取、清洗处理', '清洗标准由自然语言确定<br>不同类型用不同方法', AUTO),
    ('s4', '④ 模型的选择与运行', '运行模型 → 得到结果', AUTO),
    ('s5', '⑤ 图表的绘制', '结果可视化', AUTO),
    ('s6', '⑥ 文章的撰写和修改', '成稿与迭代修改', AUTO),
]
for i, (sid, name, detail, sty) in enumerate(S1):
    x = 24 + i * 272
    cells.append(V(sid, f'<b>{name}</b><br>' + small(detail), sty, x, 60, 246, 78, parent='phase1'))
    if i:
        cells.append(E('e' + sid, EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;',
                       S1[i - 1][0], sid, parent='phase1'))
cells.append(V('badge3', '▲ 人工审核：确定验收标准', TXT + 'fontSize=9;fontColor=#B25000;',
               24 + 2 * 272, 146, 246, 18, parent='phase1'))
cells.append(V('badge4', '▲ 结果要人审核（有问题 → 回退）',
               TXT + 'fontSize=9;fontColor=#B25000;', 24 + 3 * 272, 146, 246, 18, parent='phase1'))
cells.append(V('p1note', '说明：③④ 两步由人工确认验收标准与结果，未通过则回到清洗与标准设定。',
               TXT + 'fontSize=9.5;align=left;fontColor=#7A8794;', 24, 176, 900, 20, parent='phase1'))

# ---------------- 阶段二：投稿—审稿—发表（3 步） ----------------
cells.append(V('phase2', '', CONT, 40, 336, 1640, 196))
cells.append(title_txt(20, 10, 800, 26, '阶段二 · 投稿—审稿—发表过程（3 步）', 14, parent='phase2'))
S2 = [
    ('u1', '⑦ 投稿前的全流程校验与投稿', '研究过程（数据/代码/图表/稿件）校验后投稿'),
    ('u2', '⑧ 回复评审意见与最终校验', '按评审意见修改并回复，最终校验'),
    ('u3', '⑨ 文章接收后校稿阶段的校验', '校样核对与最终版确认'),
]
for i, (sid, name, detail) in enumerate(S2):
    x = 40 + i * 560
    cells.append(V(sid, f'<b>{name}</b><br>' + small(detail), AUTO, x, 60, 460, 78, parent='phase2'))
    if i:
        cells.append(E('e' + sid, EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;',
                       S2[i - 1][0], sid, parent='phase2'))
cells.append(V('p2badge', '▲ 智能体定位问题 / 生成修改建议，人工确认后进入下一步',
               TXT + 'fontSize=9;fontColor=#B25000;', 40, 146, 700, 18, parent='phase2'))

cells.append(E('ph_link', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'phase1', 'phase2'))

# ================================================================
# 能力节点（v3 重绘）：数据/参数两条流水线 → 计算（两种方式）
# ================================================================
cells.append(title_txt(40, 552, 1100, 28,
                       '能力节点细化：数据流水线 ＋ 参数流水线 → 计算（两种方式）→ 结果审核', 15))

# ---- A：数据流水线（活动数据） ----
cells.append(V('nodeA', '', CONT, 40, 588, 780, 300))
cells.append(title_txt(20, 10, 700, 26, '数据流水线 · 活动数据', 13, parent='nodeA'))
cells.append(V('a1', '下载更新数据<br>' + small('（活动数据）'), AUTO, 30, 70, 210, 68, parent='nodeA'))
cells.append(V('a2', '数据清洗<br>' + small('自然语言确定清洗标准；<br>不同类型不同方法'),
               AUTO, 280, 58, 250, 92, parent='nodeA'))
cells.append(V('a3', '人工审核：<br>验收标准通过？', HUMAN, 570, 50, 200, 112, parent='nodeA'))
cells.append(E('ea1', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'a1', 'a2', parent='nodeA'))
cells.append(E('ea2', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'a2', 'a3', parent='nodeA'))
cells.append(E('ea_loop', DASH + 'exitX=0.5;exitY=1;entryX=0.75;entryY=1;', 'a3', 'a2',
               value='未通过：更新清洗与验收标准', points=[(670, 210), (467, 210)], parent='nodeA'))
cells.append(V('a_note', '产出：清洗后的活动数据（计算输入之一）',
               TXT + 'fontSize=9.5;align=left;fontColor=#7A8794;', 30, 248, 720, 30, parent='nodeA'))

# ---- B：参数流水线（参数 / 文献） ----
cells.append(V('nodeB', '', CONT, 860, 588, 820, 300))
cells.append(title_txt(20, 10, 700, 26, '参数流水线 · 参数与文献（威源的完整流程）', 13, parent='nodeB'))
cells.append(V('b1', '更新参数数据', AUTO, 30, 70, 200, 68, parent='nodeB'))
cells.append(V('b2', '文献数据挖掘<br>' + small('（威源的完整流程）'), AUTO, 276, 58, 250, 92, parent='nodeB'))
cells.append(V('b3', '人工审核：<br>确定验收标准', HUMAN, 566, 50, 200, 112, parent='nodeB'))
cells.append(E('eb1', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'b1', 'b2', parent='nodeB'))
cells.append(E('eb2', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'b2', 'b3', parent='nodeB'))
cells.append(E('eb_loop', DASH + 'exitX=0.5;exitY=1;entryX=0.75;entryY=1;', 'b3', 'b2',
               value='未通过：更新清洗与验收标准', points=[(666, 210), (463, 210)], parent='nodeB'))
cells.append(V('b_note', '产出：参数数据（计算输入之一）',
               TXT + 'fontSize=9.5;align=left;fontColor=#7A8794;', 30, 248, 760, 30, parent='nodeB'))

# ---- C：计算（两种方式）与结果审核 ----
cells.append(V('nodeC', '', CONT, 40, 916, 1640, 392))
cells.append(title_txt(20, 8, 1200, 26,
                       '计算（两种方式）与结果审核 —— 输入：清洗后的活动数据 ＋ 参数数据', 13, parent='nodeC'))

# 方式一：直接计算
cells.append(V('c_m1', '方式一 · 直接计算<br>' + small('计算方法不变，直接改 input 得到结果'),
               AUTO, 40, 56, 320, 84, parent='nodeC'))
# 方式二：接入新模块（先对齐、再写代码、再计算）
cells.append(V('c_m2lab', '方式二 · 接入新模块', TXT + 'fontSize=9.5;align=left;fontColor=#3F5A73;',
               40, 154, 320, 24, parent='nodeC'))
cells.append(V('c_align', '数据对齐<br>' + small('自然语言形成对齐文档 + 人工审核'),
               AUTO, 40, 184, 320, 84, parent='nodeC'))
cells.append(V('c_code', '对齐方法写成代码', AUTO, 400, 184, 240, 84, parent='nodeC'))
# 共用的计算
cells.append(V('c_calc', '计算<br>' + small('两个方式共用<br>同一套计算方法'),
               AUTO, 690, 56, 210, 212, parent='nodeC'))
# 输出与审核
cells.append(V('c_out', '输出数据', OUTB, 950, 120, 170, 84, parent='nodeC'))
cells.append(V('c_audit', '人工审核：<br>结果是否存在问题？', HUMAN, 1170, 102, 230, 120, parent='nodeC'))
cells.append(V('c_plot', '（若有需求）绘图查看是否符合规律',
               TXT + 'fontSize=9;fontColor=#7A8794;', 950, 210, 190, 26, parent='nodeC'))
cells.append(V('c_ok', '无问题 → 计算完成，数据可用于后续步骤',
               TXT + 'fontSize=9.5;fontColor=#3F7A46;', 1330, 232, 270, 26, parent='nodeC'))
cells.append(V('c_locate', '有问题 → 自动定位（数据 / 对齐 / 运行代码）→ 查看更新清洗与验收标准',
               PARAM, 950, 286, 650, 62, parent='nodeC'))

cells.append(E('ec1', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.3;', 'c_m1', 'c_calc',
               value='直接算', parent='nodeC'))
cells.append(E('ec2', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'c_align', 'c_code', parent='nodeC'))
cells.append(E('ec3', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.75;', 'c_code', 'c_calc',
               value='对齐后算', parent='nodeC'))
cells.append(E('ec4', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'c_calc', 'c_out', parent='nodeC'))
cells.append(E('ec5', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'c_out', 'c_audit', parent='nodeC'))
cells.append(E('ec6', EDG + 'exitX=0.35;exitY=1;entryX=0.5;entryY=0;', 'c_audit', 'c_locate',
               value='有问题', parent='nodeC'))
cells.append(E('ec7', DASH + 'exitX=0;exitY=0.5;entryX=0.5;entryY=1;', 'c_locate', 'c_align',
               value='按定位结果回退修正', points=[(70, 317), (200, 317)], parent='nodeC'))

# 两条流水线的产出汇入计算（跨容器连线：活动数据 + 参数数据 一起构成计算输入）
cells.append(E('in_data', EDG + 'exitX=0.5;exitY=1;entryX=0.35;entryY=0;', 'nodeA', 'c_calc',
               value='活动数据', points=[(430, 956), (803, 956)]))
cells.append(E('in_param', EDG + 'exitX=0.5;exitY=1;entryX=0.65;entryY=0;', 'nodeB', 'c_calc',
               value='参数数据', points=[(1270, 962), (866, 962)]))

# 底部来源说明
cells.append(title_txt(40, 1324, 1400, 24,
                       '内容来源：业务说明（两阶段 9 步）+ 模块能力说明表；'
                       '菱形与橙色标注为人工环节，虚线为未通过/定位后的回退路径。'
                       '「参数数据进入计算」为依据"直接改 input 得到结果"的推断，待业务确认。',
                       10, 'left', '#8A8A8A', False))

# ---------------- 输出 ----------------
out = os.path.join(BASE, 'flow-agent-process.drawio')
xml = wrap('flowAgentProcess', '流程智能体业务流程', PAGE_W, PAGE_H, cells)
with open(out, 'w', encoding='utf-8') as f:
    f.write(xml)
print('written', out, len(xml), 'chars,', len(cells), 'cells')
