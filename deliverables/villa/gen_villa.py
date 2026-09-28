# -*- coding: utf-8 -*-
"""
现代两层别墅（平屋面 + 二层露台 + 泳池 + 庭院）——离线 rhino3dm 生成器

几何约定：单位米，Z 向上，地块 x∈[-25,25] y∈[-20,20]，原始地面 z=0。
房屋主体 x∈[-9,9]，一层 y∈[-4,8]，二层 y∈[-4,2.6]（其余成为二层露台）。

所有体块均为凸体，法线由 Newell 公式 +「面心-体质心」点积自动定向，
每个凸体单独计算质心，避免合并网格时翻面错误。
"""
import os
import sys
import rhino3dm

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- 体块工具


def box_polys(x0, x1, y0, y1, z0, z1):
    return [
        [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)],
        [(x0, y0, z1), (x0, y1, z1), (x1, y1, z1), (x1, y0, z1)],
        [(x0, y0, z0), (x0, y0, z1), (x1, y0, z1), (x1, y0, z0)],
        [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)],
        [(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)],
        [(x1, y0, z0), (x1, y0, z1), (x1, y1, z1), (x1, y1, z0)],
    ]


def octa_polys(cx, cy, cz, rx, ry, rz):
    v = [
        (cx + rx, cy, cz), (cx - rx, cy, cz),
        (cx, cy + ry, cz), (cx, cy - ry, cz),
        (cx, cy, cz + rz), (cx, cy, cz - rz),
    ]
    tris = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4),
            (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]
    return [[v[i] for i in t] for t in tris]


def taper_prism_polys(cx, cy, z0, z1, r0, r1, sides=6):
    """上下不同半径的正棱柱（树干），仍是凸体"""
    import math as _m
    bot, top = [], []
    for i in range(sides):
        a = 2 * _m.pi * i / sides + _m.pi / sides
        bot.append((cx + r0 * _m.cos(a), cy + r0 * _m.sin(a), z0))
        top.append((cx + r1 * _m.cos(a), cy + r1 * _m.sin(a), z1))
    polys = [list(reversed(bot)), list(top)]
    for i in range(sides):
        j = (i + 1) % sides
        polys.append([bot[i], bot[j], top[j], top[i]])
    return polys


class Builder(object):
    """累积一组凸体，输出一个 Mesh（自动去重顶点 + 逐凸体定向法线）"""

    def __init__(self, offset=(0.0, 0.0, 0.0)):
        self.verts = []
        self.faces = []
        self.lookup = {}
        self.offset = offset

    def _idx(self, p):
        k = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
        i = self.lookup.get(k)
        if i is None:
            i = len(self.verts)
            self.lookup[k] = i
            self.verts.append(k)
        return i

    def add(self, polys):
        n = 0
        cx = cy = cz = 0.0
        for p in polys:
            for q in p:
                cx += q[0]; cy += q[1]; cz += q[2]; n += 1
        if n == 0:
            return
        cx /= n; cy /= n; cz /= n
        for p in polys:
            m = len(p)
            nx = ny = nz = 0.0
            for i in range(m):
                a = p[i]; b = p[(i + 1) % m]
                nx += (a[1] - b[1]) * (a[2] + b[2])
                ny += (a[2] - b[2]) * (a[0] + b[0])
                nz += (a[0] - b[0]) * (a[1] + b[1])
            fx = sum(q[0] for q in p) / m - cx
            fy = sum(q[1] for q in p) / m - cy
            fz = sum(q[2] for q in p) / m - cz
            if nx * fx + ny * fy + nz * fz < 0:
                p = list(reversed(p))
            self.faces.append([self._idx(q) for q in p])

    def box(self, x0, x1, y0, y1, z0, z1):
        self.add(box_polys(x0, x1, y0, y1, z0, z1))

    def count(self):
        return len(self.faces)

    def mesh(self):
        m = rhino3dm.Mesh()
        ox, oy, oz = self.offset
        for q in self.verts:
            m.Vertices.Add(q[0] + ox, q[1] + oy, q[2] + oz)
        for f in self.faces:
            if len(f) == 3:
                m.Faces.AddFace(f[0], f[1], f[2])
            elif len(f) == 4:
                m.Faces.AddFace(f[0], f[1], f[2], f[3])
            else:
                for i in range(1, len(f) - 1):
                    m.Faces.AddFace(f[0], f[i], f[i + 1])
        m.Normals.ComputeNormals()
        m.Compact()
        return m


# ------------------------------------------------------------------ 墙体

def wall_openings(axis, fixed, u0, u1, z0, z1, t, openings):
    """带洞口的墙：返回若干实心盒。openings = [(a,b,za,zb)]，互不重叠"""
    polys = []

    def seg(a, b, za, zb):
        if b - a <= 1e-6 or zb - za <= 1e-6:
            return
        if axis == 'x':
            polys.extend(box_polys(a, b, fixed - t / 2, fixed + t / 2, za, zb))
        else:
            polys.extend(box_polys(fixed - t / 2, fixed + t / 2, a, b, za, zb))

    cur = u0
    for (a, b, za, zb) in sorted(openings, key=lambda o: o[0]):
        a = max(a, u0); b = min(b, u1)
        if b <= a:
            continue
        if a > cur:
            seg(cur, a, z0, z1)
        if za > z0:
            seg(a, b, z0, za)
        if zb < z1:
            seg(a, b, zb, z1)
        cur = max(cur, b)
    if cur < u1:
        seg(cur, u1, z0, z1)
    return polys


def pane_polys(axis, fixed, a, b, za, zb, gap=0.03, t=0.018):
    a += gap; b -= gap; za += gap; zb -= gap
    if axis == 'x':
        return box_polys(a, b, fixed - t / 2, fixed + t / 2, za, zb)
    return box_polys(fixed - t / 2, fixed + t / 2, a, b, za, zb)


def frame_polys(axis, fixed, a, b, za, zb, t=0.16, w=0.06, spacing=1.25):
    polys = []

    def bx(p, q, zz0, zz1):
        if axis == 'x':
            polys.extend(box_polys(p, q, fixed - t / 2, fixed + t / 2, zz0, zz1))
        else:
            polys.extend(box_polys(fixed - t / 2, fixed + t / 2, p, q, zz0, zz1))

    bx(a, b, za, za + w)
    bx(a, b, zb - w, zb)
    bx(a, a + w, za, zb)
    bx(b - w, b, za, zb)
    span = b - a
    n = max(1, int(round(span / spacing)))
    for i in range(1, n):
        u = a + span * i / n
        bx(u - w / 2, u + w / 2, za, zb)
    return polys


# ------------------------------------------------------------ 别墅参数

PLINTH_TOP = 0.45
L1_Z0, L1_Z1 = 0.45, 4.05
SLAB_Z0, SLAB_Z1 = 4.05, 4.35
L2_Z0, L2_Z1 = 4.35, 7.65
ROOF_Z0, ROOF_Z1 = 7.65, 8.05

X0, X1 = -9.0, 9.0
Y_FRONT, Y_BACK = 8.0, -4.0          # 一层进深（Y_FRONT 为入口面）
L2_Y_FRONT = 2.6                      # 二层退台线
WT = 0.25                             # 外墙厚

L1_WALLS = [
    # (axis, fixed, u0, u1, [(a,b,za,zb)]) — 洞口：入口门 / 落地玻璃 / 窗
    ('x', Y_FRONT, -8.875, 8.875, [(-1.2, 1.2, 0.45, 2.75),
                                   (3.4, 7.4, 0.45, 2.95),
                                   (-7.6, -4.2, 1.35, 2.95)]),
    ('x', Y_BACK, -8.875, 8.875, [(-7.4, -2.4, 0.45, 2.95),
                                  (0.9, 3.9, 1.35, 2.95),
                                  (5.4, 8.1, 1.35, 2.95)]),
    ('y', X0, -4.125, 8.125, [(-1.6, 1.4, 1.35, 2.95),
                              (4.2, 6.6, 1.35, 2.95)]),
    ('y', X1, -4.125, 8.125, [(-3.2, -0.2, 0.45, 2.95),
                              (2.2, 5.6, 1.35, 2.95)]),
]

L2_WALLS = [
    ('x', L2_Y_FRONT, -8.875, 8.875, [(-8.2, 8.2, 4.55, 7.35)]),
    ('x', Y_BACK, -8.875, 8.875, [(-7.2, -3.6, 5.25, 7.25),
                                  (-0.4, 3.6, 5.25, 7.25),
                                  (5.4, 8.1, 5.25, 7.25)]),
    ('y', X0, -4.125, 2.725, [(-2.6, 1.6, 5.25, 7.25)]),
    ('y', X1, -4.125, 2.725, [(-2.6, 1.6, 5.25, 7.25)]),
]

OFFSET = (0.0, 0.0, 0.0)
if len(sys.argv) > 1:
    OFFSET = (float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3]))


# ---------------------------------------------------------------- 组装

def build(offset):
    objs = []          # (名称, 图层, 材质, 面数, mesh)

    def emit(name, layer, mat, b):
        objs.append((name, layer, mat, b.count(), b.mesh()))

    # ===== 场地 =====
    b = Builder(offset)
    b.box(-25, 25, -20, 20, -0.30, 0.0)                      # 草坪基底
    emit("场地_草坪", "别墅_场地", "grass", b)

    b = Builder(offset)
    b.box(-14, 14, -14, 12, 0.0, 0.18)                       # 硬质铺装平台
    emit("场地_硬质铺装", "别墅_铺装", "paving", b)

    b = Builder(offset)
    b.box(-3, 3, 12, 19.5, 0.0, 0.12)                        # 车道
    emit("场地_车道", "别墅_铺装", "paving", b)

    b = Builder(offset)
    b.box(-8, 1, -13, -8, 0.06, 0.12)                        # 水面
    emit("水景_泳池水面", "别墅_水景", "water", b)

    b = Builder(offset)
    # 池缘：外圈 x[-8.5,1.5] y[-13.5,-7.5]，内圈即水面 x[-8,1] y[-13,-8]，四条边带
    b.box(-8.5, 1.5, -13.5, -13.0, 0.18, 0.36)              # 南侧边带
    b.box(-8.5, 1.5, -8.0, -7.5, 0.18, 0.36)                 # 北侧边带
    b.box(-8.5, -8.0, -13.0, -8.0, 0.18, 0.36)               # 西侧边带
    b.box(1.0, 1.5, -13.0, -8.0, 0.18, 0.36)                 # 东侧边带
    emit("水景_泳池池缘", "别墅_石材", "stone", b)

    b = Builder(offset)
    b.box(-24.75, -24.5, -19.75, 19.75, 0.0, 1.8)            # 围墙四面 + 双门柱
    b.box(24.5, 24.75, -19.75, 19.75, 0.0, 1.8)
    b.box(-24.75, 24.75, -19.75, -19.5, 0.0, 1.8)
    b.box(-24.75, -3.2, 19.5, 19.75, 0.0, 1.8)
    b.box(3.2, 24.75, 19.5, 19.75, 0.0, 1.8)
    b.box(-3.7, -3.2, 19.25, 20.0, 0.0, 2.15)
    b.box(3.2, 3.7, 19.25, 20.0, 0.0, 2.15)
    emit("场地_围墙", "别墅_石材", "stone", b)

    # ===== 绿化 =====
    TREES = [(-19, -13, 1.9), (-19.5, 9.5, 1.7), (19, -14, 2.0),
             (20, 8, 1.8), (6.5, -17, 1.6), (12.5, 16, 1.9)]
    b = Builder(offset)
    for (tx, ty, r) in TREES:
        b.add(taper_prism_polys(tx, ty, 0.0, 2.5, 0.26, 0.16, 6))
    emit("绿化_树干", "别墅_绿化", "trunk", b)

    b = Builder(offset)
    for (tx, ty, r) in TREES:
        b.add(octa_polys(tx, ty, 3.9, r, r, r * 0.85))
    emit("绿化_树冠", "别墅_绿化", "foliage", b)

    # ===== 主体：台基 / 台阶 =====
    b = Builder(offset)
    b.box(-9.6, 9.6, -4.6, 8.6, 0.18, PLINTH_TOP)
    emit("别墅_石材台基", "别墅_石材", "stone", b)

    b = Builder(offset)
    b.box(-2.2, 3.2, 8.6, 9.0, 0.18, 0.45)
    b.box(-2.2, 3.2, 9.0, 9.4, 0.18, 0.36)
    b.box(-2.2, 3.2, 9.4, 9.8, 0.18, 0.27)
    emit("入口_台阶", "别墅_石材", "stone", b)

    # ===== 一层 =====
    bw = Builder(offset)   # 墙体
    bg = Builder(offset)   # 玻璃
    bf = Builder(offset)   # 门窗框
    for (axis, fixed, u0, u1, ops) in L1_WALLS:
        bw.add(wall_openings(axis, fixed, u0, u1, L1_Z0, L1_Z1, WT, ops))
        for (a, bq, za, zb) in ops:
            bg.add(pane_polys(axis, fixed, a, bq, za, zb))
            bf.add(frame_polys(axis, fixed, a, bq, za, zb))
    emit("一层_墙体", "别墅_墙体", "white", bw)
    emit("一层_玻璃", "别墅_玻璃", "glass", bg)
    emit("一层_门窗框", "别墅_门窗框", "frame", bf)

    b = Builder(offset)
    b.add(wall_openings('x', 1.5, -8.875, 0.0, L1_Z0, L1_Z1, 0.15,
                        [(-3.6, -2.6, 0.45, 2.55)]))
    b.add(wall_openings('y', 2.0, -4.0, 1.5, L1_Z0, L1_Z1, 0.15,
                        [(-1.2, -0.2, 0.45, 2.55)]))
    emit("一层_隔墙", "别墅_墙体", "white", b)

    # ===== 二层楼板（预留楼梯洞口）=====
    b = Builder(offset)
    b.box(-9.125, 4.2, -4.125, 8.125, SLAB_Z0, SLAB_Z1)
    b.box(6.6, 9.125, -4.125, 8.125, SLAB_Z0, SLAB_Z1)
    b.box(4.2, 6.6, -4.125, -3.8, SLAB_Z0, SLAB_Z1)
    b.box(4.2, 6.6, 2.2, 8.125, SLAB_Z0, SLAB_Z1)
    emit("二层_楼板", "别墅_楼板", "concrete", b)

    # ===== 二层 =====
    bw = Builder(offset)
    bg = Builder(offset)
    bf = Builder(offset)
    for (axis, fixed, u0, u1, ops) in L2_WALLS:
        bw.add(wall_openings(axis, fixed, u0, u1, L2_Z0, L2_Z1, WT, ops))
        for (a, bq, za, zb) in ops:
            bg.add(pane_polys(axis, fixed, a, bq, za, zb))
            bf.add(frame_polys(axis, fixed, a, bq, za, zb))
    emit("二层_墙体", "别墅_墙体", "white", bw)
    emit("二层_玻璃", "别墅_玻璃", "glass", bg)
    emit("二层_门窗框", "别墅_门窗框", "frame", bf)

    b = Builder(offset)
    # 沿 Y 向布置，避开二层楼板的楼梯洞口（x 4.2..6.6）
    b.add(wall_openings('y', 2.0, -3.875, 2.475, L2_Z0, L2_Z1, 0.15,
                        [(0.2, 1.2, 4.35, 6.45)]))
    emit("二层_隔墙", "别墅_墙体", "white", b)

    # ===== 屋面 =====
    b = Builder(offset)
    b.box(-9.9, 9.9, -4.9, 3.5, ROOF_Z0, ROOF_Z1)
    emit("屋面_屋面板", "别墅_屋面", "roof", b)

    b = Builder(offset)
    b.box(-9.79, 9.79, -4.79, -4.57, ROOF_Z1, 8.65)
    b.box(-9.79, 9.79, 3.28, 3.5, ROOF_Z1, 8.65)
    b.box(-9.79, -9.57, -4.79, 3.5, ROOF_Z1, 8.65)
    b.box(9.57, 9.79, -4.79, 3.5, ROOF_Z1, 8.65)
    emit("屋面_女儿墙", "别墅_屋面", "roof", b)

    # ===== 二层露台 =====
    b = Builder(offset)
    b.box(-8.9, 8.9, 2.72, 8.1, SLAB_Z1, SLAB_Z1 + 0.08)
    emit("露台_木地板", "别墅_木作", "wood", b)

    bm = Builder(offset)
    bgl = Builder(offset)
    RAIL_Z0, RAIL_Z1 = SLAB_Z1 + 0.08, SLAB_Z1 + 0.08 + 1.05
    edges = [('y', -8.86, 2.72, 8.05), ('y', 8.86, 2.72, 8.05),
             ('x', 8.05, -8.86, 8.86)]
    for (axis, fixed, u0, u1) in edges:
        n = max(1, int(round((u1 - u0) / 1.1)))
        for i in range(n + 1):
            u = u0 + (u1 - u0) * i / n
            if axis == 'x':
                bm.box(u - 0.03, u + 0.03, fixed - 0.04, fixed + 0.04,
                       RAIL_Z0, RAIL_Z1)
            else:
                bm.box(fixed - 0.04, fixed + 0.04, u - 0.03, u + 0.03,
                       RAIL_Z0, RAIL_Z1)
        # 上下横梁 + 玻璃
        if axis == 'x':
            bm.box(u0, u1, fixed - 0.04, fixed + 0.04, RAIL_Z1 - 0.07, RAIL_Z1)
            bm.box(u0, u1, fixed - 0.03, fixed + 0.03, RAIL_Z0, RAIL_Z0 + 0.05)
            bgl.box(u0, u1, fixed - 0.008, fixed + 0.008,
                    RAIL_Z0 + 0.05, RAIL_Z1 - 0.07)
        else:
            bm.box(fixed - 0.04, fixed + 0.04, u0, u1, RAIL_Z1 - 0.07, RAIL_Z1)
            bm.box(fixed - 0.03, fixed + 0.03, u0, u1, RAIL_Z0, RAIL_Z0 + 0.05)
            bgl.box(fixed - 0.008, fixed + 0.008, u0, u1,
                    RAIL_Z0 + 0.05, RAIL_Z1 - 0.07)
    emit("露台_栏杆金属", "别墅_金属", "metal", bm)
    emit("露台_栏杆玻璃", "别墅_玻璃", "glass", bgl)

    # ===== 楼梯（20 级，0.28 踏面 / 0.195 踢面，穿二层洞口）=====
    b = Builder(offset)
    for i in range(20):
        y0 = -3.6 + i * 0.28
        b.box(4.4, 6.4, y0, y0 + 0.28, L1_Z0, L1_Z0 + (i + 1) * 0.195)
    emit("楼梯", "别墅_楼梯", "concrete", b)

    # ===== 入口雨棚 + 入户门 =====
    b = Builder(offset)
    b.box(-2.6, 4.6, 7.9, 11.6, 3.35, 3.55)
    emit("入口_雨棚", "别墅_木作", "wood", b)

    b = Builder(offset)
    b.box(-1.9, -1.68, 11.05, 11.27, 0.18, 3.35)
    b.box(3.9, 4.12, 11.05, 11.27, 0.18, 3.35)
    emit("入口_雨棚柱", "别墅_金属", "metal", b)

    b = Builder(offset)
    b.box(-1.2, 1.2, 7.92, 8.02, 0.45, 2.75)
    emit("入口_入户门", "别墅_木作", "wood", b)

    return objs


# ------------------------------------------------------------ 输出 .3dm

LAYERS = [
    ("别墅_场地", (110, 150, 90)),
    ("别墅_铺装", (198, 192, 182)),
    ("别墅_石材", (170, 166, 158)),
    ("别墅_墙体", (240, 238, 232)),
    ("别墅_楼板", (200, 198, 194)),
    ("别墅_玻璃", (150, 205, 225)),
    ("别墅_门窗框", (62, 64, 68)),
    ("别墅_屋面", (96, 100, 104)),
    ("别墅_木作", (170, 124, 76)),
    ("别墅_金属", (152, 157, 162)),
    ("别墅_水景", (58, 140, 178)),
    ("别墅_绿化", (76, 124, 66)),
    ("别墅_楼梯", (200, 198, 194)),
]

MATERIALS = {
    "grass":    ((86, 140, 74), 0.0),
    "paving":   ((198, 192, 182), 0.0),
    "stone":    ((170, 166, 158), 0.0),
    "white":    ((240, 238, 232), 0.0),
    "glass":    ((150, 205, 225), 0.72),
    "frame":    ((62, 64, 68), 0.0),
    "roof":     ((96, 100, 104), 0.0),
    "wood":     ((170, 124, 76), 0.0),
    "metal":    ((152, 157, 162), 0.0),
    "water":    ((58, 140, 178), 0.35),
    "foliage":  ((76, 124, 66), 0.0),
    "trunk":    ((98, 74, 52), 0.0),
    "concrete": ((200, 198, 194), 0.0),
}


def write(path, objects, offset):
    m = rhino3dm.File3dm()
    m.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Meters

    layer_idx = {}
    for (name, rgb) in LAYERS:
        L = rhino3dm.Layer()
        L.Name = name
        L.Color = (rgb[0], rgb[1], rgb[2], 255)
        layer_idx[name] = m.Layers.Add(L)

    mat_idx = {}
    for key, (rgb, tr) in MATERIALS.items():
        M = rhino3dm.Material()
        M.DiffuseColor = (rgb[0], rgb[1], rgb[2], 255)
        M.Transparency = tr
        M.Name = key
        mat_idx[key] = m.Materials.Add(M)

    total_faces = 0
    for (name, layer, mat, nface, mesh) in objects:
        A = rhino3dm.ObjectAttributes()
        A.Name = name
        A.LayerIndex = layer_idx[layer]
        A.MaterialIndex = mat_idx[mat]
        A.MaterialSource = rhino3dm.ObjectMaterialSource.MaterialFromObject
        m.Objects.AddMesh(mesh, A)
        total_faces += nface

    ok = m.Write(path, 8)
    size = os.path.getsize(path) if os.path.exists(path) else -1
    print("  write %-28s objects=%2d faces=%5d bytes=%d ok=%s"
          % (os.path.basename(path), len(objects), total_faces, size, ok))
    return ok


def main():
    out_origin = os.path.join(HERE, "villa.3dm")
    out_shift = os.path.join(HERE, "villa_import_offset.3dm")

    objs = build((0.0, 0.0, 0.0))
    print("build objects:", len(objs))
    total_faces = sum(o[3] for o in objs)
    print("total faces:", total_faces)

    write(out_origin, objs, (0.0, 0.0, 0.0))

    objs2 = build(OFFSET)
    write(out_shift, objs2, OFFSET)

    # 包围盒自查（未偏移版本）
    mn = [1e18] * 3
    mx = [-1e18] * 3
    for (name, layer, mat, nface, mesh) in objs:
        bb = mesh.GetBoundingBox()
        mn[0] = min(mn[0], bb.Min.X); mn[1] = min(mn[1], bb.Min.Y); mn[2] = min(mn[2], bb.Min.Z)
        mx[0] = max(mx[0], bb.Max.X); mx[1] = max(mx[1], bb.Max.Y); mx[2] = max(mx[2], bb.Max.Z)
    print("origin bbox min:", [round(v, 2) for v in mn])
    print("origin bbox max:", [round(v, 2) for v in mx])
    bad = [o[0] for o in objs if not o[4].IsValid]
    print("invalid meshes:", bad if bad else "none")


if __name__ == "__main__":
    main()
