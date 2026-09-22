# -*- coding: utf-8 -*-
"""流程智能体 —— 业务流程与能力节点流程图（draw.io）

内容来源：
1. 业务说明：研究写作过程（6 步）+ 投稿审稿到发表过程（3 步）
2. 模块能力说明表：
   - 数据流水线（下载更新数据 → 数据清洗 → 人工审核确定验收标准）
   - 参数流水线（更新参数数据 → 文献数据挖掘 → 人工审核确定验收标准）
   - 两条流水线的产出共同构成「计算」的输入
   - 计算为一个模块，分两种方式：① 直接计算（方法不变，直接改 input 得到结果）；
     ② 接入模块后（完成数据对齐 → 把对齐方法写成代码 → 运行计算）
   - 计算得到输出数据后：结果要人审核 → 有问题则自动定位（数据 / 对齐 / 运行代码）→ 回退修正

v4 布局（按需求调整）：
- 左侧竖排两条流水线：数据流水线在上、参数流水线在下（各自横向展开）
- 右侧为「计算（竖图）」：一个计算模块 → 分支 1. 直接计算 / 2. 接入模块后 → 输出数据
- 底部独立一行：结果审核与回退

全图中文字体：Microsoft YaHei；字号统一按 FONT_SCALE 放大，保证缩到论文宽度仍可读。
"""
import os
import re
import xml.dom.minidom as minidom
from xml.sax.saxutils import quoteattr

BASE = os.path.dirname(os.path.abspath(__file__))
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
    minidom.parseString(xml)
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
    return f'<font style="font-size:{size}px;color:{color}">{t}</font>'


cells = []
PAGE_W, PAGE_H = 1720, 1420

# ---------------- 标题与图例 ----------------
cells.append(title_txt(40, 22, 1000, 34, '流程智能体 · 业务流程与能力节点', 22))
cells.append(title_txt(40, 60, 1000, 22,
                       '两阶段主流程（研究写作 6 步 → 投稿发表 3 步）+ 数据/参数流水线 → 计算（一个模块，两种方式）',
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
# 能力节点（v4）：左侧竖排两条流水线 + 右侧计算竖图 + 底部结果审核
# ================================================================
cells.append(title_txt(40, 552, 1200, 28,
                       '能力节点细化：左侧两条流水线（数据 / 参数）→ 右侧计算（一个模块，两种方式）→ 结果审核', 15))


def pipeline(prefix, x, y, title, s1_text, s1_small, s2_text, s2_small, s3_text, note):
    """一条流水线容器：步骤1 → 步骤2 → 人工审核（含未通过回流）

    容器 id 统一为 node+大写前缀（nodeA / nodeB），与跨容器连线的引用保持一致。
    """
    cid = 'node' + prefix.upper()
    out = []
    out.append(V(cid, '', CONT, x, y, 720, 280))
    out.append(title_txt(20, 10, 660, 26, title, 13, parent=cid))
    out.append(V(prefix + '1', s1_text + '<br>' + small(s1_small), AUTO, 30, 62, 200, 64, parent=cid))
    out.append(V(prefix + '2', s2_text + '<br>' + small(s2_small), AUTO, 252, 52, 240, 84, parent=cid))
    out.append(V(prefix + '3', s3_text, HUMAN, 512, 40, 190, 108, parent=cid))
    out.append(E('e' + prefix + '1', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;',
                 prefix + '1', prefix + '2', parent=cid))
    out.append(E('e' + prefix + '2', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;',
                 prefix + '2', prefix + '3', parent=cid))
    out.append(E('e' + prefix + '_loop', DASH + 'exitX=0.5;exitY=1;entryX=0.5;entryY=1;',
                 prefix + '3', prefix + '2', value='未通过：更新清洗与验收标准',
                 points=[(607, 200), (372, 200)], parent=cid))
    out.append(V(prefix + '_note', note, TXT + 'fontSize=9.5;align=left;fontColor=#7A8794;',
                 30, 228, 660, 30, parent=cid))
    return out


# 左列上：数据流水线；左列下：参数流水线（按需求放在数据流水线下方）
cells += pipeline('a', 40, 588, '数据流水线 · 活动数据',
                  '下载更新数据', '（活动数据）',
                  '数据清洗', '自然语言确定清洗标准；<br>不同类型不同方法',
                  '人工审核：<br>验收标准通过？',
                  '产出：清洗后的活动数据（计算输入之一）')
cells += pipeline('b', 40, 888, '参数流水线 · 参数与文献',
                  '更新参数数据', '（参数数据）',
                  '文献数据挖掘', '（威源的完整流程）',
                  '人工审核：<br>确定验收标准',
                  '产出：参数数据（计算输入之一）')

# ---------------- 右列：计算（竖图） ----------------
cells.append(V('nodeC', '', CONT, 800, 588, 880, 580))
cells.append(title_txt(20, 8, 840, 26, '计算（竖图）· 一个计算模块，两种方式', 13, parent='nodeC'))
cells.append(V('c_calc', '<b>计算</b><br>' + small('输入：清洗后的活动数据 ＋ 参数数据<br>两种方式共用同一套计算方法'),
               AUTO, 330, 46, 220, 96, parent='nodeC'))
cells.append(V('c_m1', '<b>1. 直接计算</b><br>' + small('计算方法不变，直接改 input 得到结果'),
               AUTO, 80, 186, 270, 76, parent='nodeC'))
cells.append(V('c_m2', '<b>2. 接入模块后</b><br>' + small('先做数据对齐，再写代码运行'),
               AUTO, 450, 186, 270, 66, parent='nodeC'))
cells.append(V('c_align', '数据对齐<br>' + small('自然语言形成对齐文档 + 人工审核'),
               AUTO, 450, 272, 270, 66, parent='nodeC'))
cells.append(V('c_code', '对齐方法写成代码', AUTO, 450, 358, 270, 56, parent='nodeC'))
cells.append(V('c_run', '运行计算', AUTO, 450, 434, 270, 56, parent='nodeC'))
cells.append(V('c_out', '输出数据', OUTB, 300, 500, 280, 56, parent='nodeC'))
# 计算模块 → 两种方式的分支
cells.append(E('ec_b1', EDG + 'exitX=0.25;exitY=1;entryX=0.5;entryY=0;', 'c_calc', 'c_m1',
               points=[(385, 158), (215, 158)], parent='nodeC'))
cells.append(E('ec_b2', EDG + 'exitX=0.75;exitY=1;entryX=0.5;entryY=0;', 'c_calc', 'c_m2',
               points=[(495, 158), (585, 158)], parent='nodeC'))
# 方式二的链路
cells.append(E('ec_al', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'c_m2', 'c_align', parent='nodeC'))
cells.append(E('ec_cd', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'c_align', 'c_code', parent='nodeC'))
cells.append(E('ec_rn', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'c_code', 'c_run', parent='nodeC'))
# 两条分支汇入输出数据
cells.append(E('ec_o1', EDG + 'exitX=0.5;exitY=1;entryX=0.25;entryY=0;', 'c_m1', 'c_out',
               points=[(215, 480), (370, 480)], parent='nodeC'))
cells.append(E('ec_o2', EDG + 'exitX=0.5;exitY=1;entryX=0.75;entryY=0;', 'c_run', 'c_out',
               points=[(585, 480), (510, 480)], parent='nodeC'))

# 两条流水线的产出汇入计算模块（跨容器连线，从右边缘进入计算左侧）
cells.append(E('in_data', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.35;', 'nodeA', 'c_calc',
               value='活动数据', points=[(790, 728), (790, 668)]))
cells.append(E('in_param', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.65;', 'nodeB', 'c_calc',
               value='参数数据', points=[(775, 1028), (775, 696)], offset=(170, 0)))

# ---------------- 底部：结果审核与回退 ----------------
cells.append(V('nodeR', '', CONT, 40, 1188, 1640, 172))
cells.append(title_txt(20, 8, 600, 24, '结果审核与回退', 13, parent='nodeR'))
cells.append(V('r1', '人工审核：<br>结果是否存在问题？', HUMAN, 60, 46, 260, 104, parent='nodeR'))
cells.append(V('r2', '有问题 → 自动定位（数据 / 对齐 / 运行代码）', PARAM, 380, 58, 400, 80, parent='nodeR'))
cells.append(V('r3', '→ 查看更新清洗与验收标准，按定位结果回退修正', PARAM, 820, 58, 480, 80, parent='nodeR'))
cells.append(V('r4', '无问题 → 计算完成，数据可用于后续步骤',
               TXT + 'fontSize=9.5;fontColor=#3F7A46;', 1300, 58, 310, 80, parent='nodeR'))
cells.append(E('er1', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'r1', 'r2',
               value='有问题', parent='nodeR'))
cells.append(E('er2', EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;', 'r2', 'r3', parent='nodeR'))
# 回退：定位到数据/参数问题 → 回到流水线；定位到对齐/运行代码 → 回到计算竖图
cells.append(E('er_back1', DASH + 'exitX=0.25;exitY=0;entryX=0.75;entryY=1;', 'r2', 'nodeB',
               value='数据问题 → 回退流水线'))
cells.append(E('er_back2', DASH + 'exitX=0.66;exitY=0;entryX=0.34;entryY=1;', 'r3', 'nodeC',
               value='对齐/代码问题 → 回退计算'))

# 底部来源说明
cells.append(title_txt(40, 1384, 1500, 24,
                       '内容来源：业务说明（两阶段 9 步）+ 模块能力说明表；菱形与橙色标注为人工环节，'
                       '虚线为未通过 / 定位后的回退路径。「参数数据进入计算」为依据"直接改 input 得到结果"的推断，待业务确认。',
                       10, 'left', '#8A8A8A', False))

# ---------------- 输出 ----------------
out = os.path.join(BASE, 'flow-agent-process.drawio')
xml = wrap('flowAgentProcess', '流程智能体业务流程', PAGE_W, PAGE_H, cells)
with open(out, 'w', encoding='utf-8') as f:
    f.write(xml)
print('written', out, len(xml), 'chars,', len(cells), 'cells')
