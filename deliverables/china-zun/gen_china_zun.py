# -*- coding: utf-8 -*-
# 北京中信大厦（中国尊 / CITIC Tower, KPF 设计）Rhino 8 模型离线生成器。
#
# 依据 KPF 公布的形体法则：
#   - 圆角方形平面（superellipse, n = 3.2）
#   - 宽度竖向渐变：底部 78 m -> 腰部 54 m -> 顶部 69 m
#   - 总高 528 m，地上 108 层
#   - 外框为全高巨型交叉斜撑（diagrid，菱形竹编肌理）+ 核心筒
#   - 塔冠城门式通透格栅
#
# 单位：米。原点 = 塔楼底面中心。
# 产出 8 个语义 mesh 对象，供 RhinoAction import_export 一次性导入。

import math
import os

import numpy as np
import rhino3dm as r3

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(OUT_DIR, 'china-zun.3dm')

HEIGHT = 528.0
N_SUPER = 3.2  # 2 = 菱形, inf = 方, 3.2 约等于中国尊的圆角方形

# (z, 平面宽度 W)：底 78 / 腰 54 @300 m / 顶 69，KPF 口径
CTRL = [
    (0.0, 75.0), (9.0, 78.0), (30.0, 76.4), (60.0, 72.8), (100.0, 68.4),
    (150.0, 63.0), (200.0, 58.6), (250.0, 55.4), (300.0, 54.0), (330.0, 54.2),
    (370.0, 56.0), (410.0, 58.8), (450.0, 62.0), (485.0, 65.4), (510.0, 68.0),
    (522.0, 69.0), (528.0, 69.0),
]
_CZ = np.array([p[0] for p in CTRL], float)
_CW = np.array([p[1] for p in CTRL], float)


def _tan(j):
    if j == 0:
        return (_CW[1] - _CW[0]) / (_CZ[1] - _CZ[0])
    if j == len(_CW) - 1:
        return (_CW[-1] - _CW[-2]) / (_CZ[-1] - _CZ[-2])
    return (_CW[j + 1] - _CW[j - 1]) / (_CZ[j + 1] - _CZ[j - 1])


def width_at(z):
    # 分段三次 Hermite 插值出该标高的平面宽度
    z = float(min(max(z, _CZ[0]), _CZ[-1]))
    i = min(max(int(np.searchsorted(_CZ, z, side='right') - 1), 0), len(_CZ) - 2)
    z0, z1, w0, w1 = _CZ[i], _CZ[i + 1], _CW[i], _CW[i + 1]
    h = z1 - z0
    s = (z - z0) / h
    t0, t1 = _tan(i), _tan(i + 1)
    return ((2 * s ** 3 - 3 * s ** 2 + 1) * w0 + (s ** 3 - 2 * s ** 2 + s) * h * t0
            + (-2 * s ** 3 + 3 * s ** 2) * w1 + (s ** 3 - s ** 2) * h * t1)


def tower_xy(z, theta, scale=1.0):
    a = width_at(z) * scale / 2.0
    ct, st = math.cos(theta), math.sin(theta)
    e = 2.0 / N_SUPER
    x = a * math.copysign(abs(ct) ** e, ct if ct else 1.0)
    y = a * math.copysign(abs(st) ** e, st if st else 1.0)
    return x, y


def surf_pt(z, theta, offset=0.0, scale=1.0):
    # 塔身外表面上一点；offset 沿近似径向向外推
    x, y = tower_xy(z, theta, scale)
    n = math.hypot(x, y)
    if n > 1e-9 and offset:
        x += offset * x / n
        y += offset * y / n
    return (x, y, z)


def newell(vs):
    nx = ny = nz = 0.0
    m = len(vs)
    for i in range(m):
        x1, y1, z1 = vs[i]
        x2, y2, z2 = vs[(i + 1) % m]
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    return (nx, ny, nz)


class MeshBuilder(object):
    # 累积顶点/面；每个面自带一个内参考点，收尾按 Newell 法线统一翻正。
    # 合并多个凸构件时必须逐构件给 ref（不能用全局质心），否则远离质心的
    # 杆件会被翻成内法线。

    def __init__(self):
        self.V = []
        self.F = []

    def add_pt(self, p):
        self.V.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.V) - 1

    def add_face(self, idx, ref):
        self.F.append((tuple(int(i) for i in idx), tuple(ref)))

    def fix_normals(self):
        for k, (idx, ref) in enumerate(self.F):
            vs = [self.V[i] for i in idx]
            n = newell(vs)
            c = np.mean(np.asarray(vs, float), axis=0)
            d = c - np.asarray(ref, float)
            if n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0:
                self.F[k] = (idx[::-1], ref)

    def to_mesh(self):
        self.fix_normals()
        m = r3.Mesh()
        for v in self.V:
            m.Vertices.Add(*v)
        for idx, _ in self.F:
            if len(idx) in (3, 4):
                m.Faces.AddFace(*idx)
            else:
                # n 边形封盖 -> 以首顶点为锥顶扇形三角化，保持绕序
                for k in range(1, len(idx) - 1):
                    m.Faces.AddFace(idx[0], idx[k], idx[k + 1])
        m.Normals.ComputeNormals()
        m.Compact()
        return m


def tube(mb, p0, p1, hw, hh=None):
    # 方截面杆件：p0 -> p1，局部半宽 hw / hh
    hh = hw if hh is None else hh
    p0 = np.asarray(p0, float)
    p1 = np.asarray(p1, float)
    d = p1 - p0
    L = float(np.linalg.norm(d))
    if L < 1e-9:
        return
    d /= L
    up = np.array([0.0, 0.0, 1.0])
    if abs(float(d @ up)) > 0.995:
        up = np.array([1.0, 0.0, 0.0])
    u = np.cross(up, d)
    u /= np.linalg.norm(u)
    v = np.cross(d, u)
    offs = [u * hw + v * hh, -u * hw + v * hh, -u * hw - v * hh, u * hw - v * hh]
    base = len(mb.V)
    for o in offs:
        mb.add_pt(p0 + o)
    for o in offs:
        mb.add_pt(p1 + o)
    c = (p0 + p1) * 0.5  # 凸管自身质心 -> 严格外法线
    for i in range(4):
        j = (i + 1) % 4
        mb.add_face([base + i, base + j, base + 4 + j, base + 4 + i], c)
    mb.add_face([base + 3, base + 2, base + 1, base + 0], c)
    mb.add_face([base + 4, base + 5, base + 6, base + 7], c)


def polyline_tube(mb, pts, hw, hh=None):
    for a, b in zip(pts[:-1], pts[1:]):
        tube(mb, a, b, hw, hh)


def build_skin():
    # 塔身玻璃外皮：superellipse 环 + 竖向分层
    mb = MeshBuilder()
    NSEG, NLVL = 72, 76
    zs = [HEIGHT * i / NLVL for i in range(NLVL + 1)]
    ths = [2 * math.pi * k / NSEG for k in range(NSEG)]
    ids = [[mb.add_pt(surf_pt(z, t)) for t in ths] for z in zs]
    for i in range(NLVL):
        for k in range(NSEG):
            k2 = (k + 1) % NSEG
            c = np.mean([mb.V[x] for x in (ids[i][k], ids[i][k2],
                                           ids[i + 1][k2], ids[i + 1][k])], axis=0)
            mb.add_face([ids[i][k], ids[i][k2], ids[i + 1][k2], ids[i + 1][k]],
                        (0.0, 0.0, float(c[2])))
    for ring, is_top in ((ids[-1], True), (ids[0], False)):
        ctr = mb.add_pt((0.0, 0.0, zs[-1] if is_top else zs[0]))
        ref = (0.0, 0.0, HEIGHT - 8.0 if is_top else 8.0)
        for k in range(NSEG):
            k2 = (k + 1) % NSEG
            mb.add_face(([ring[k], ring[k2], ctr] if is_top
                         else [ring[k2], ring[k], ctr]), ref)
    return mb


def build_diagrid():
    # 外框巨型交叉斜撑：16 列 x 18 行，菱形单元约 13.5 m x 58.6 m
    mb = MeshBuilder()
    NC, NR = 16, 18
    OFF, HW = 1.15, 0.55
    node = {}
    for rr in range(NR + 1):
        for cc in range(-NR, NC + NR + 1):
            node[(rr, cc)] = surf_pt(HEIGHT * rr / NR,
                                     2 * math.pi * (cc % NC) / NC, OFF)
    for cc in range(NC):
        polyline_tube(mb, [node[(rr, cc + rr)] for rr in range(NR + 1)], HW)
        polyline_tube(mb, [node[(rr, cc - rr)] for rr in range(NR + 1)], HW)
    return mb


def build_mullions():
    # 幕墙竖向肋：48 根，贴合曲面的分段折线
    mb = MeshBuilder()
    NM, STEP, OFF = 48, 4, 0.30
    zs = [HEIGHT * i / 76 for i in range(77)]
    for k in range(NM):
        th = 2 * math.pi * k / NM + math.pi / NM
        polyline_tube(mb, [surf_pt(z, th, OFF) for z in zs[::STEP]], 0.14, 0.30)
    return mb


def build_bands():
    # 结构转梁 / 遮阳环：19 道（约每 4 层一道）
    mb = MeshBuilder()
    NB, SEG, OFF = 19, 48, 0.75
    for rr in range(NB):
        z = HEIGHT * rr / (NB - 1)
        ring = [surf_pt(z, 2 * math.pi * k / SEG, OFF) for k in range(SEG)]
        ring.append(ring[0])
        polyline_tube(mb, ring, 0.20, 0.45)
    return mb


def build_crown():
    # 塔冠"城门"格栅。
    # 上一版把竖肋放在 superellipse 的角部扇区上、且肋与压顶环用了不同径向
    # 偏移，导致冠部轮廓不闭合、节点错位（两轮 vision 都读成 jagged）。
    # 这一版改为：沿整个顶部周长等角布一圈竖肋，肋/底环/顶环共用同一偏移，
    # 因此必然闭合；再在四面中线各开一道"城门"高跨。
    mb = MeshBuilder()
    Z0, Z1 = 486.0, HEIGHT
    OFF, HW = 2.20, 0.30
    N = 96
    ang = [2 * math.pi * k / N for k in range(N)]

    # 整圈竖肋：等高，从底环到顶环
    for th in ang:
        polyline_tube(mb, [surf_pt(Z0, th, OFF), surf_pt(Z1, th, OFF)], HW, HW)

    # 底环 / 顶环：与竖肋同一 OFF，端点严格相接
    for z, half_z in ((Z0, 0.55), (Z1 - 0.55, 0.55)):
        ring = [surf_pt(z, th, OFF) for th in ang]
        ring.append(ring[0])
        polyline_tube(mb, ring, HW + 0.10, half_z)

    # 四面"城门"高跨：每面中线处加两根通高立柱 + 一道拱梁
    for side in range(4):
        mid = math.pi / 4 + side * math.pi / 2
        for dth in (-0.055, 0.055):
            th = mid + dth
            polyline_tube(mb, [surf_pt(Z0, th, OFF + 0.35),
                               surf_pt(Z1, th, OFF + 0.35)], 0.42, 0.42)
        arc = [surf_pt(Z1 - 3.2 - (abs(j) * 0.055) ** 2 * 520.0, mid + j * 0.055,
                       OFF + 0.35) for j in range(-3, 4)]
        polyline_tube(mb, arc, 0.34, 0.62)

    # 屋面格栅：按顶部 superellipse 外接方格布扁梁
    W = width_at(Z1) / 2.0 + OFF
    n = 9
    for i in range(n):
        o = -W + 2 * W * i / (n - 1)
        polyline_tube(mb, [(o, -W, Z1 - 1.6), (o, W, Z1 - 1.6)], 0.16, 0.34)
        polyline_tube(mb, [(-W, o, Z1 - 1.6), (W, o, Z1 - 1.6)], 0.16, 0.34)
    # 屋面板
    seg = 48
    roof = [mb.add_pt(surf_pt(Z1 - 2.4, 2 * math.pi * k / seg, OFF)) for k in range(seg)]
    ctr = mb.add_pt((0.0, 0.0, Z1 - 2.4))
    for k in range(seg):
        k2 = (k + 1) % seg
        mb.add_face([roof[k], roof[k2], ctr], (0.0, 0.0, Z1 - 12.0))
    return mb


def build_core():
    # 核心筒（内隐结构，示意全高）
    mb = MeshBuilder()
    SEG = 32
    rings = []
    for z, s in ((0.0, 0.30), (120.0, 0.27), (300.0, 0.245),
                 (430.0, 0.265), (508.0, 0.29)):
        rings.append((z, [mb.add_pt(surf_pt(z, 2 * math.pi * k / SEG, -1.6, s))
                          for k in range(SEG)]))
    for (z0, r0), (z1, r1) in zip(rings[:-1], rings[1:]):
        for k in range(SEG):
            k2 = (k + 1) % SEG
            mb.add_face([r0[k], r0[k2], r1[k2], r1[k]], (0.0, 0.0, (z0 + z1) / 2.0))
    mb.add_face(list(reversed(rings[0][1])), (0.0, 0.0, 12.0))
    mb.add_face(list(rings[-1][1]), (0.0, 0.0, 490.0))
    return mb


def build_podium():
    # 塔座与入口体块：塔楼底部悬垂褶皱落到地面
    mb = MeshBuilder()
    SEG = 72
    for z0, z1, sc, off in ((0.0, 9.0, 1.30, 2.0), (9.0, 18.0, 1.14, 1.2)):
        r0 = [mb.add_pt(surf_pt(z0, 2 * math.pi * k / SEG, off, sc)) for k in range(SEG)]
        r1 = [mb.add_pt(surf_pt(z1, 2 * math.pi * k / SEG, off, sc)) for k in range(SEG)]
        for k in range(SEG):
            k2 = (k + 1) % SEG
            mb.add_face([r0[k], r0[k2], r1[k2], r1[k]], (0.0, 0.0, (z0 + z1) / 2.0))
        mb.add_face(list(reversed(r0)), (0.0, 0.0, z0 + 2.0))
        mb.add_face(list(r1), (0.0, 0.0, z1 - 2.0))
    # 四周裙房平台：沿用同一 superellipse 轮廓外扩，避免上一版四点菱形
    # 平台在角部戳出尖角块（vision 读作"基座边缘零星突出物"）。
    PSEG = 48
    for z0, z1, sc, off in ((0.0, 4.0, 1.95, 3.0), (0.0, 7.5, 1.62, 2.4)):
        a = [mb.add_pt(surf_pt(z0, 2 * math.pi * k / PSEG, off, sc)) for k in range(PSEG)]
        b = [mb.add_pt(surf_pt(z1, 2 * math.pi * k / PSEG, off, sc)) for k in range(PSEG)]
        for k in range(PSEG):
            k2 = (k + 1) % PSEG
            mb.add_face([a[k], a[k2], b[k2], b[k]], (0.0, 0.0, (z0 + z1) / 2.0))
        mb.add_face(list(reversed(a)), (0.0, 0.0, z0 + 1.0))
        mb.add_face(list(b), (0.0, 0.0, z1 - 1.0))
    return mb


def build_context():
    # 场地基座（CBD 绿轴意象），一块薄板
    mb = MeshBuilder()
    R = 150.0
    lo = [(-R, -R, -1.5), (R, -R, -1.5), (R, R, -1.5), (-R, R, -1.5)]
    hi = [(-R, -R, 0.0), (R, -R, 0.0), (R, R, 0.0), (-R, R, 0.0)]
    ids = [mb.add_pt(p) for p in lo + hi]
    c = (0.0, 0.0, -0.75)
    for k in range(4):
        k2 = (k + 1) % 4
        mb.add_face([ids[k], ids[k2], ids[4 + k2], ids[4 + k]], c)
    mb.add_face([ids[3], ids[2], ids[1], ids[0]], c)
    mb.add_face([ids[4], ids[5], ids[6], ids[7]], c)
    return mb


# ---------------------------------------------------------------- 组装
PARTS = [
    ('00_场地基座', build_context, (128, 128, 128), 1.0, 0.0),
    ('01_塔座裙房', build_podium, (176, 182, 190), 1.0, 0.0),
    ('02_塔身玻璃外皮', build_skin, (148, 178, 205), 1.0, 0.55),
    ('03_外框巨型斜撑', build_diagrid, (206, 210, 214), 1.0, 0.0),
    ('04_幕墙竖向肋', build_mullions, (190, 196, 202), 1.0, 0.0),
    ('05_结构转梁环', build_bands, (214, 216, 220), 1.0, 0.0),
    ('06_塔冠城门格栅', build_crown, (222, 224, 228), 1.0, 0.0),
    ('07_核心筒', build_core, (96, 100, 106), 1.0, 0.0),
]


def main():
    model = r3.File3dm()
    model.Settings.ModelUnitSystem = r3.UnitSystem.Meters

    guids = []
    for name, fn, color, opacity, transp in PARTS:
        mb = fn()
        mesh = mb.to_mesh()
        if not mesh.IsValid:
            raise SystemExit('invalid mesh: ' + name)
        layer = r3.Layer()
        layer.Name = name
        layer.Color = (color[0], color[1], color[2], 255)
        li = model.Layers.Add(layer)
        mat = r3.Material()
        mat.Name = name
        mat.DiffuseColor = (color[0], color[1], color[2], 255)
        mat.Transparency = transp
        mi = model.Materials.Add(mat)
        attr = r3.ObjectAttributes()
        attr.Name = name
        attr.LayerIndex = li
        attr.MaterialIndex = mi
        attr.MaterialSource = r3.ObjectMaterialSource.MaterialFromObject
        g = model.Objects.AddMesh(mesh, attr)
        bb = mesh.GetBoundingBox()
        guids.append((name, len(mesh.Vertices), len(mesh.Faces),
                      (bb.Min.X, bb.Max.X), (bb.Min.Y, bb.Max.Y), (bb.Min.Z, bb.Max.Z)))
        print('%-18s V=%6d F=%6d  X[%.1f,%.1f] Y[%.1f,%.1f] Z[%.1f,%.1f]'
              % (name, len(mesh.Vertices), len(mesh.Faces),
                 bb.Min.X, bb.Max.X, bb.Min.Y, bb.Max.Y, bb.Min.Z, bb.Max.Z))

    model.Write(OUT_FILE, 8)
    print('\nwrote', OUT_FILE, os.path.getsize(OUT_FILE) // 1024, 'KB')
    print('parts', len(guids))


if __name__ == '__main__':
    main()
