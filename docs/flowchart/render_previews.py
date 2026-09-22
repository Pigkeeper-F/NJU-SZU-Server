# -*- coding: utf-8 -*-
"""按内容边界正确裁切预览图 + 用 PDF 抽取文本核对是否有缺字/重字。

背景：draw.io CLI `-x -f png -b 10` 是按**内容边界**（不是页面边界）加边框导出的，
      所以页面坐标 → PNG 像素的映射必须先用 .drawio 里的元素算出内容左上角。
"""
import sys
import xml.etree.ElementTree as ET
from PIL import Image

DRAWIO = 'flow-agent-process.drawio'
PNG = 'render/flow-agent-process.drawio.png'
PDF = 'render/flow-agent-process.drawio.pdf'
BORDER = 10.0          # CLI -b 10
SCALE = 2.0            # CLI -s 2


def content_origin(path):
    """递归解析 mxCell 的绝对坐标，返回内容左上角 (min_x, min_y)。"""
    root = ET.fromstring(open(path, encoding='utf-8').read())
    cells = {}
    for c in root.iter('mxCell'):
        if c.get('vertex') != '1':      # 只统计顶点：edge 的 mxGeometry 没有 x/y
            continue
        g = c.find('mxGeometry')
        if g is None:
            continue
        cells[c.get('id')] = (c.get('parent'), float(g.get('x') or 0), float(g.get('y') or 0))

    def absolute(cid):
        """沿父链累加坐标；顶层元素的 (x,y) 已是页面绝对坐标。"""
        x = y = 0.0
        cur = cid
        while cur and cur in cells:
            parent, px, py = cells[cur]
            x += px
            y += py
            if parent in ('0', '1'):
                break
            cur = parent
        return x, y

    xs, ys = [], []
    for cid in cells:
        x, y = absolute(cid)
        xs.append(x)
        ys.append(y)
    return min(xs), min(ys)


def crop(name, px, py, pw, ph, target_w=1232, ox=0.0, oy=0.0):
    im = Image.open(PNG)
    x0 = int((px - ox + BORDER) * SCALE)
    y0 = int((py - oy + BORDER) * SCALE)
    box = (max(x0, 0), max(y0, 0), min(x0 + int(pw * SCALE), im.size[0]), min(y0 + int(ph * SCALE), im.size[1]))
    c = im.crop(box)
    s = target_w / float(c.size[0])
    c.resize((target_w, int(c.size[1] * s)), Image.LANCZOS).save('render/' + name)
    print(f'{name}: page({px},{py},{pw}x{ph}) -> png{box} -> {target_w}x{int(c.size[1]*s)}')


if __name__ == '__main__':
    ox, oy = content_origin(DRAWIO)
    print('内容左上角(页面坐标):', ox, oy)
    im = Image.open(PNG)
    sc = 1280.0 / im.size[0]
    im.resize((1280, int(im.size[1] * sc)), Image.LANCZOS).save('render/preview-full.png')
    print('preview-full', im.size, '->', (1280, int(im.size[1] * sc)))
    crop('crop-top.png', 30, 12, 1660, 330, ox=ox, oy=oy)
    crop('crop-nodes.png', 30, 540, 1700, 720, ox=ox, oy=oy)
