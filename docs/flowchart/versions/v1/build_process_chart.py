# -*- coding: utf-8 -*-
"""流程智能体 —— 业务流程与能力节点流程图（draw.io）

内容来源（两张材料）：
1. 业务说明：流程智能体分两步 —— 研究写作过程（6 步）+ 投稿审稿到发表过程（3 步）
2. 模块能力说明表：数据获取/清洗/计算、新模块接入（数据对齐）、参数与文献数据挖掘

设计约定（沿用 drawio-flowcharts 既有风格 + 论文流程图规范）：
- 主流程横向（阶段一 6 步 / 阶段二 3 步），能力节点内部流程纵向
- 蓝色圆角框 = 智能体自动执行；橙色菱形 = 人工审核/判断；绿色 = 输出
- 虚线灰箭头 = 未通过时的回退路径；全部正交走线，无阴影无渐变
- 全文中文字体：Microsoft YaHei（保证 draw.io CLI 导出 PNG 时中文不出现豆腐块）
"""
import os
import xml.dom.minidom as minidom
from xml.sax.saxutils import quoteattr

BASE = os.path.dirname(os.path.abspath(__file__))


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


def wrap(did, name, W, H, cells):
    body = ''.join(cells)
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
AUTO = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#DAE8FC;strokeColor=#6C8EBF;' + F
HUMAN = 'rhombus;whiteSpace=wrap;html=1;fillColor=#FFE6CC;strokeColor=#D79B00;' + F
OUTB = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#D5E8D4;strokeColor=#82B366;' + F
PARAM = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#E1D5E7;strokeColor=#9673A6;' + F
CONT = ('rounded=1;whiteSpace=wrap;html=1;fillColor=#FAFAFA;strokeColor=#B3B3B3;'
        'container=1;collapsible=0;verticalAlign=top;' + F)
EDG = ('edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#333333;'
       'endArrow=classic;endSize=4;' + F)
DASH = ('edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#999999;dashed=1;'
        'endArrow=classic;endSize=4;' + F)
TXT = 'text;html=1;align=center;verticalAlign=middle;' + F


def small(t, size=9, color='#5B6B7C', align='center'):
    """小字注解（放在框内第二行或框下）"""
    return (f'<font style="font-size:{size}px;color:{color}">{t}</font>'
            if align == 'center' else t)


_seq = [0]


def title_txt(x, y, w, h, text, size=14, align='left', color='#1F2933', bold=True, parent='1'):
    _seq[0] += 1
    st = (f'text;html=1;align={align};verticalAlign=middle;fontSize={size};'
          f'fontColor={color};' + ('fontStyle=1;' if bold else '') + F)
    return V('lt%d' % _seq[0], text, st, x, y, w, h, parent=parent)


cells = []
PAGE_W, PAGE_H = 1720, 1300

# ---------------- 标题与图例 ----------------
cells.append(title_txt(40, 22, 1000, 34, '流程智能体 · 业务流程与能力节点', 22))
cells.append(title_txt(40, 60, 1000, 22,
                       '两阶段主流程（研究写作 6 步 → 投稿发表 3 步）+ 三个关键能力节点的内部流程',
                       11, 'left', '#5B6B7C', False))

# 图例（右上）
cells.append(V('lg1', '', AUTO, 1190, 26, 34, 18))
cells.append(title_txt(1230, 24, 200, 20, '智能体自动执行', 11, 'left', '#1F2933', False))
cells.append(V('lg2', '', HUMAN, 1420, 22, 30, 26))
cells.append(title_txt(1456, 24, 220, 20, '人工审核 / 判断', 11, 'left', '#1F2933', False))
cells.append(V('lg3', '', OUTB, 1190, 56, 34, 18))
cells.append(title_txt(1230, 54, 200, 20, '输出 / 成果', 11, 'left', '#1F2933', False))
cells.append(E('lg4', DASH, '', '', value='未通过 → 回退修正', offset=(60, 0)))
# 虚线图例单独用一条无端点短线表达
cells[-1] = ('<mxCell id="lg4" value="未通过 → 回退修正" style='
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
    cells.append(V(sid, f'<b>{name}</b><br>' + small(detail, 9.5), sty, x, 60, 246, 78, parent='phase1'))
    if i:
        cells.append(E('e' + sid, EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;',
                       S1[i - 1][0], sid, parent='phase1'))
# 人工审核标注（③ 与 ④ 为材料中点名的人工环节）
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
    cells.append(V(sid, f'<b>{name}</b><br>' + small(detail, 9.5), AUTO, x, 60, 460, 78, parent='phase2'))
    if i:
        cells.append(E('e' + sid, EDG + 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;',
                       S2[i - 1][0], sid, parent='phase2'))
cells.append(V('p2badge', '▲ 智能体定位问题 / 生成修改建议，人工确认后进入下一步',
               TXT + 'fontSize=9;fontColor=#B25000;', 40, 146, 700, 18, parent='phase2'))

# 阶段一 → 阶段二 主连接
cells.append(E('ph_link', EDG + 'exitX=0.06;exitY=1;entryX=0.06;entryY=0;', 'phase1', 'phase2'))

# ---------------- 能力节点细化 ----------------
cells.append(title_txt(40, 552, 900, 28, '能力节点细化（关键模块的内部流程）', 15))

# ---- A：数据获取与清洗 / 计算 ----
cells.append(V('nodeA', '', CONT, 40, 588, 536, 646))
cells.append(title_txt(20, 10, 480, 26, '能力节点 A · 数据获取与清洗 → 计算', 13, parent='nodeA'))
cells.append(V('a1', '下载更新数据' + '<br>' + small('（活动数据）', 9.5), AUTO, 48, 56, 440, 62, parent='nodeA'))
cells.append(V('a2', '数据清洗' + '<br>' + small('自然语言确定清洗标准；不同类型不同方法', 9.5),
               AUTO, 48, 152, 440, 62, parent='nodeA'))
cells.append(V('a3', '人工审核：<br>验收标准是否通过？', HUMAN, 148, 246, 240, 104, parent='nodeA'))
cells.append(V('a4', '计算' + '<br>' + small('方法不变，直接改 input 得到结果', 9.5),
               AUTO, 48, 384, 440, 62, parent='nodeA'))
cells.append(V('a5', '输出数据（结果要人审核）', OUTB, 48, 480, 440, 62, parent='nodeA'))
cells.append(E('ea1', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'a1', 'a2', parent='nodeA'))
cells.append(E('ea2', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'a2', 'a3', parent='nodeA'))
cells.append(E('ea3', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'a3', 'a4', value='通过', parent='nodeA'))
cells.append(E('ea4', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'a4', 'a5', parent='nodeA'))
cells.append(E('ea_loop', DASH + 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', 'a3', 'a2',
               value='未通过', points=[(40, 298), (40, 183)], parent='nodeA'))
cells.append(E('ea_loop2', DASH + 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', 'a5', 'a2',
               value='有问题', points=[(26, 511), (26, 183)], parent='nodeA'))
cells.append(V('a_note', '未通过/有问题 → 更新清洗与验收标准后重新清洗（不改变计算方法）',
               TXT + 'fontSize=9.5;align=left;fontColor=#7A8794;', 48, 566, 440, 40, parent='nodeA'))

# ---- B：新模块接入（数据对齐） ----
cells.append(V('nodeB', '', CONT, 600, 588, 536, 646))
cells.append(title_txt(20, 10, 480, 26, '能力节点 B · 新模块接入：数据对齐', 13, parent='nodeB'))
cells.append(V('b1', '完成数据对齐' + '<br>' + small('自然语言形成对齐文档', 9.5),
               AUTO, 48, 48, 440, 60, parent='nodeB'))
cells.append(V('b2', '人工审核：<br>对齐文档是否通过？', HUMAN, 148, 128, 240, 100, parent='nodeB'))
cells.append(V('b3', '对齐方法写成代码', AUTO, 48, 250, 440, 58, parent='nodeB'))
cells.append(V('b4', '运行计算 → 得到输出数据' + '<br>' + small('（若有需求）绘图查看是否符合规律', 9.5),
               AUTO, 48, 328, 440, 62, parent='nodeB'))
cells.append(V('b5', '人工审核：<br>结果是否存在问题？', HUMAN, 148, 412, 240, 100, parent='nodeB'))
cells.append(V('b6', '自动定位：数据 / 对齐 / 运行代码', PARAM, 48, 536, 440, 58, parent='nodeB'))
cells.append(E('eb1', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'b1', 'b2', parent='nodeB'))
cells.append(E('eb2', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'b2', 'b3', value='通过', parent='nodeB'))
cells.append(E('eb3', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'b3', 'b4', parent='nodeB'))
cells.append(E('eb4', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'b4', 'b5', parent='nodeB'))
cells.append(E('eb5', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'b5', 'b6', value='有问题', parent='nodeB'))
cells.append(E('eb_loop', DASH + 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', 'b6', 'b3',
               value='定位后修正', points=[(40, 565), (40, 279)], parent='nodeB'))
cells.append(E('eb_loop2', DASH + 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', 'b2', 'b1',
               value='未通过', points=[(112, 178), (112, 78)], parent='nodeB'))
cells.append(V('b_ok', '通过 → 输出数据可用', TXT + 'fontSize=9.5;fontColor=#3F7A46;',
               48, 604, 440, 20, parent='nodeB'))

# ---- C：参数数据与文献数据挖掘 ----
cells.append(V('nodeC', '', CONT, 1160, 588, 520, 646))
cells.append(title_txt(20, 10, 460, 26, '能力节点 C · 参数数据与文献数据挖掘', 13, parent='nodeC'))
cells.append(V('c1', '更新参数数据', AUTO, 44, 60, 432, 60, parent='nodeC'))
cells.append(V('c2', '文献数据挖掘' + '<br>' + small('（威源的完整流程）', 9.5),
               AUTO, 44, 160, 432, 62, parent='nodeC'))
cells.append(V('c3', '人工审核：<br>确定验收标准是否通过？', HUMAN, 140, 262, 240, 104, parent='nodeC'))
cells.append(V('c4', '参数与文献数据更新完成（输出）', OUTB, 44, 408, 432, 62, parent='nodeC'))
cells.append(E('ec1', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'c1', 'c2', parent='nodeC'))
cells.append(E('ec2', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'c2', 'c3', parent='nodeC'))
cells.append(E('ec3', EDG + 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;', 'c3', 'c4', value='通过', parent='nodeC'))
cells.append(E('ec_loop', DASH + 'exitX=0;exitY=0.5;entryX=0;entryY=0.5;', 'c3', 'c2',
               value='未通过', points=[(36, 314), (36, 191)], parent='nodeC'))
cells.append(V('c_note', '结果要人审核；若存在问题，查看并更新清洗与验收标准。',
               TXT + 'fontSize=9.5;align=left;fontColor=#7A8794;', 44, 500, 432, 40, parent='nodeC'))

# 底部来源说明
cells.append(title_txt(40, 1252, 1200, 24,
                       '内容来源：业务说明（两阶段 9 步）+ 模块能力说明表；菱形与橙色标注为人工环节，虚线为未通过回退路径。',
                       10, 'left', '#8A8A8A', False))

# ---------------- 输出 ----------------
out = os.path.join(BASE, 'flow-agent-process.drawio')
xml = wrap('flowAgentProcess', '流程智能体业务流程', PAGE_W, PAGE_H, cells)
with open(out, 'w', encoding='utf-8') as f:
    f.write(xml)
print('written', out, len(xml), 'chars,', len(cells), 'cells')
