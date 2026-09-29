# -*- coding: utf-8 -*-
# 苏州博物馆新馆 · 主入口大厅（贝聿铭）Rhino 8 离线生成器
# 依据：中央大厅高 16 m、主体檐口约 6 m；粉墙黛瓦（白墙 + 中国黑花岗石勾边）
# 单位：米。原点 = 入口立面中线与地面交点；+Y 为正面（水庭一侧）。

import math
import os

import numpy as np
import rhino3dm as r3

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'suzhou-entrance.3dm')

# ---- 控制标高 / 平面尺寸（m）----
PL = 0.60                                          # 台基顶面
EAVE_C, EAVE_W, EAVE_E = 7.20, 5.40, 3.40          # 中央 / 两翼 / 端墙 檐口
APEX = 13.60                                       # 中央山墙脊
CUP_Z0, CUP_Z1, CUP_APEX = 11.50, 14.80, 16.20     # 中央方亭（灯笼体）
WC, WW, WE = 10.0, 22.0, 32.0                      # 中央 / 两翼 / 端墙 半宽
DH, DW, DE = 24.0, 18.0, 9.0                       # 进深：大厅 / 两翼 / 端墙
POOL_Y = 34.0                                      # 水庭前缘


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


class MB(object):
    """累积顶点/面；每面带一个内参考点，收尾按 Newell 法线统一翻正。"""

    def __init__(self):
        self.V = []
        self.F = []

    def add_pt(self, p):
        self.V.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.V) - 1

    def add_face(self, idx, ref):
        self.F.append((tuple(int(i) for i in idx), tuple(ref)))

    def fix(self):
        for k, (idx, ref) in enumerate(self.F):
            vs = [self.V[i] for i in idx]
            n = newell(vs)
            c = np.mean(np.asarray(vs, float), axis=0)
            d = c - np.asarray(ref, float)
            if n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0:
                self.F[k] = (idx[::-1], ref)

    def to_mesh(self):
        self.fix()
        m = r3.Mesh()
        for v in self.V:
            m.Vertices.Add(*v)
        for idx, _ in self.F:
            if len(idx) in (3, 4):
                m.Faces.AddFace(*idx)
            else:
                for k in range(1, len(idx) - 1):
                    m.Faces.AddFace(idx[0], idx[k], idx[k + 1])
        m.Normals.ComputeNormals()
        m.Compact()
        return m


# ---------------------------------------------------------------- 基本体
def add_prism(mb, prof, y0, y1):
    # prof: [(x, z), ...] 闭合多边形，沿 Y 拉伸
    n = len(prof)
    ref = (sum(p[0] for p in prof) / n, (y0 + y1) / 2.0, sum(p[1] for p in prof) / n)
    f = [mb.add_pt((p[0], y1, p[1])) for p in prof]
    b = [mb.add_pt((p[0], y0, p[1])) for p in prof]
    for i in range(n):
        j = (i + 1) % n
        mb.add_face([f[i], f[j], b[j], b[i]], ref)
    mb.add_face(f, ref)
    mb.add_face(b[::-1], ref)


def add_box(mb, x0, x1, y0, y1, z0, z1):
    add_prism(mb, [(x0, z0), (x1, z0), (x1, z1), (x0, z1)], y0, y1)


def add_gable(mb, x0, x1, y0, y1, z_eave, z_apex, thickness=0.0):
    # 人字坡（山墙）：檐口矩形 -> 屋脊（脊线平行 Y）
    xm = (x0 + x1) / 2.0
    add_prism(mb, [(x0, z_eave), (x1, z_eave), (xm, z_apex)], y0, y1)


def add_hip(mb, x0, x1, y0, y1, z0, z1, inset):
    # 四坡顶：底矩形 @z0 -> 脊线 @z1（脊线平行 X）
    yc = (y0 + y1) / 2.0
    b = [mb.add_pt(p) for p in [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]]
    r0 = mb.add_pt((x0 + inset, yc, z1))
    r1 = mb.add_pt((x1 - inset, yc, z1))
    ref = ((x0 + x1) / 2.0, yc, (z0 + z1) / 2.0)
    mb.add_face([b[0], b[1], r1, r0], ref)
    mb.add_face([b[2], b[3], r0, r1], ref)
    mb.add_face([b[1], b[2], r1], ref)
    mb.add_face([b[3], b[0], r0], ref)
    mb.add_face([b[3], b[2], b[1], b[0]], ref)


def add_pyramid(mb, x0, x1, y0, y1, z0, z1):
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    b = [mb.add_pt(p) for p in [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]]
    ap = mb.add_pt((cx, cy, z1))
    ref = (cx, cy, (z0 + z1) / 2.0)
    for i in range(4):
        j = (i + 1) % 4
        mb.add_face([b[i], b[j], ap], ref)
    mb.add_face([b[3], b[2], b[1], b[0]], ref)


def octagon(cx, cz, r):
    return [(cx + r * math.cos(math.pi / 8 + k * math.pi / 4),
             cz + r * math.sin(math.pi / 8 + k * math.pi / 4)) for k in range(8)]


def add_ring_prism(mb, outer, inner, y0, y1):
    # 带洞的环形棱柱：白墙山墙上要留出玻璃洞
    n = len(outer)
    ox = sum(p[0] for p in outer) / n
    oz = sum(p[1] for p in outer) / n
    ix = sum(p[0] for p in inner) / n
    iz = sum(p[1] for p in inner) / n
    ref = ((ox + ix) / 2.0, (y0 + y1) / 2.0, (oz + iz) / 2.0)
    of = [mb.add_pt((p[0], y1, p[1])) for p in outer]
    ob = [mb.add_pt((p[0], y0, p[1])) for p in outer]
    nf = [mb.add_pt((p[0], y1, p[1])) for p in inner]
    nb = [mb.add_pt((p[0], y0, p[1])) for p in inner]
    for i in range(n):
        j = (i + 1) % n
        mb.add_face([of[i], of[j], ob[j], ob[i]], ref)
        mb.add_face([nf[j], nf[i], nb[i], nb[j]], ref)
        mb.add_face([of[j], of[i], nf[i], nf[j]], ref)
        mb.add_face([ob[i], ob[j], nb[j], nb[i]], ref)


def add_band(mb, p0, p1, half_w, y0, y1):
    # 沿 p0->p1（XZ 平面内线段）的等宽带
    dx, dz = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dz)
    if L < 1e-9:
        return
    nx, nz = dz / L * half_w, -dx / L * half_w
    add_prism(mb, [(p0[0] - nx, p0[1] - nz), (p1[0] - nx, p1[1] - nz),
                   (p1[0] + nx, p1[1] + nz), (p0[0] + nx, p0[1] + nz)], y0, y1)


# ---------------------------------------------------------------- 构件
def build_walls():
    # 白墙：三段跌落的实体（中央最高、两翼次之、端墙最低）
    mb = MB()
    add_box(mb, -WC, WC, 0.0, DH, PL, EAVE_C)                     # 中央大厅
    for s in (-1, 1):
        a, b = sorted((s * WC, s * WW))
        add_box(mb, a, b, 0.0, DW, PL, EAVE_W)                    # 两翼
        c, d = sorted((s * WW, s * WE))
        add_box(mb, c, d, 0.0, DE, PL, EAVE_E)                    # 端墙
    # 中央山墙（檐口以上）：带玻璃洞的白墙环
    add_ring_prism(mb, [(-WC, EAVE_C), (WC, EAVE_C), (0.0, APEX)],
                   [(-9.30, EAVE_C + 0.12), (9.30, EAVE_C + 0.12), (0.0, APEX - 1.05)],
                   0.0, 0.90)
    return mb


def build_roof():
    # 深灰屋面：中式坡顶的抽象化。中央为大尺度人字坡，两翼四坡，端墙单坡。
    mb = MB()
    add_gable(mb, -WC, WC, 0.9, DH + 0.35, EAVE_C, APEX)          # 中央
    for s in (-1, 1):
        a, b = sorted((s * WC, s * WW))
        add_hip(mb, a, b, -0.35, DW + 0.35, EAVE_W, EAVE_W + 1.9, 2.6)
        c, d = sorted((s * WW, s * WE))
        add_prism(mb, [(c, EAVE_E), (d, EAVE_E), (d, EAVE_E + 0.95)],
                  -0.35, DE + 0.35)                               # 端墙单坡
    return mb


def build_lantern():
    # 中央方亭（灯笼体）：白墙 + 四坡攒尖顶 + 宝顶
    mb = MB()
    add_box(mb, -5.0, 5.0, 2.0, 8.0, CUP_Z0, CUP_Z1)
    add_pyramid(mb, -5.45, 5.45, 1.55, 8.45, CUP_Z1, CUP_APEX)
    add_box(mb, -0.30, 0.30, 4.7, 5.3, CUP_APEX, CUP_APEX + 1.15)  # 宝顶
    return mb


def build_glass():
    # 玻璃：入口门厅凹龛、山墙高侧窗、方亭百叶带
    mb = MB()
    add_box(mb, -4.60, 4.60, -0.30, 1.05, PL, EAVE_C)            # 入口玻璃幕
    add_prism(mb, [(-9.30, EAVE_C), (9.30, EAVE_C), (0.0, APEX - 1.05)],
              0.15, 0.42)                                         # 山墙高侧窗
    add_box(mb, -4.85, 4.85, 1.90, 2.10, 12.10, 13.55)            # 方亭前百叶
    add_box(mb, -4.20, 4.20, -0.35, 0.95, 6.35, 6.95)             # 门上横窗
    return mb


def build_trim():
    # 中国黑花岗石勾边：檐口带、山墙斜边、勒脚
    mb = MB()
    # 入口面檐口横带（三段各一条）
    for x0, x1, z in ((-WC - 0.10, WC + 0.10, EAVE_C),
                      (-WW - 0.10, WW + 0.10, EAVE_W),
                      (-WE - 0.10, WE + 0.10, EAVE_E)):
        add_box(mb, x0, x1, 0.0, 0.62, z - 0.48, z + 0.06)
    # 中央山墙两条斜边
    for s in (-1, 1):
        add_band(mb, (s * (WC + 0.06), EAVE_C - 0.05), (s * 0.30, APEX - 0.12),
                 0.20, 0.0, 0.62)
    # 勒脚：白墙落地的深色基座
    add_box(mb, -WE - 0.25, WE + 0.25, -0.25, 0.30, PL - 0.55, PL)
    for s in (-1, 1):
        a, b = sorted((s * WC, s * WW))
        add_box(mb, a, b, -0.25, 0.30, PL - 0.55, PL)
    return mb


def build_windows():
    # 六角空窗：入口面两翼 + 方亭，贝聿铭的标志性母题
    mb = MB()
    for s in (-1, 1):
        add_prism(mb, octagon(s * 7.6, 3.40, 1.05), -0.06, 0.18)
    for s in (-1, 1):
        add_prism(mb, octagon(s * 3.30, CUP_Z1 - 2.35, 0.78), 1.86, 2.02)
    return mb


def build_pergola():
    # 两端侧廊屋面（照片中远景的斜檐片）
    mb = MB()
    for s in (-1, 1):
        a, b = sorted((s * WE, s * (WE + 14.0)))
        add_prism(mb, [(a, 3.05), (b, 3.45), (b, 3.95), (a, 3.55)], 1.0, 11.0)
    return mb


def build_terrace():
    # 台基 + 临水踏步
    mb = MB()
    add_box(mb, -WE - 7.0, WE + 7.0, -1.5, 7.2, -0.6, PL)
    for i in range(3):
        z = PL - (i + 1) * 0.15
        add_box(mb, -WE - 7.0, WE + 7.0, 7.2 + i * 0.7, 7.9 + i * 0.7, -0.6, z)
    return mb


def build_pool():
    # 北侧水庭（照片前景的大水面）
    mb = MB()
    add_box(mb, -95.0, 95.0, 9.0, 110.0, -0.35, 0.12)
    return mb


# ---------------------------------------------------------------- 组装
# (图层名, 生成器, 漫反射色, 不透明度)
PARTS = [
    ('01_水面',        build_pool,     (44, 74, 76),   0.62),
    ('02_台基与踏步',   build_terrace,  (206, 201, 191), 1.0),
    ('03_白墙',        build_walls,    (243, 241, 236), 1.0),
    ('04_深灰屋面',     build_roof,     (46, 49, 54),   1.0),
    ('05_中国黑勾边',   build_trim,     (32, 33, 36),   1.0),
    ('06_玻璃',        build_glass,    (66, 86, 99),   0.50),
    ('07_方亭',        build_lantern,  (243, 241, 236), 1.0),
    ('08_六角空窗',     build_windows,  (26, 28, 32),   1.0),
    ('09_两端侧廊',     build_pergola,  (52, 55, 60),   1.0),
]


def main():
    model = r3.File3dm()
    model.Settings.ModelUnitSystem = r3.UnitSystem.Meters
    total_v = total_f = 0
    for name, fn, color, opacity in PARTS:
        mesh = fn().to_mesh()
        if not mesh.IsValid:
            raise SystemExit('invalid mesh: ' + name)
        layer = r3.Layer()
        layer.Name = name
        layer.Color = (color[0], color[1], color[2], 255)
        li = model.Layers.Add(layer)
        mat = r3.Material()
        mat.Name = name
        mat.DiffuseColor = (color[0], color[1], color[2], 255)
        mat.Transparency = 1.0 - opacity
        mi = model.Materials.Add(mat)
        attr = r3.ObjectAttributes()
        attr.Name = name
        attr.LayerIndex = li
        attr.MaterialIndex = mi
        attr.MaterialSource = r3.ObjectMaterialSource.MaterialFromObject
        model.Objects.AddMesh(mesh, attr)
        bb = mesh.GetBoundingBox()
        total_v += len(mesh.Vertices)
        total_f += len(mesh.Faces)
        print('%-16s V=%6d F=%6d  X[%7.1f,%7.1f] Y[%7.1f,%7.1f] Z[%6.2f,%6.2f]'
              % (name, len(mesh.Vertices), len(mesh.Faces),
                 bb.Min.X, bb.Max.X, bb.Min.Y, bb.Max.Y, bb.Min.Z, bb.Max.Z))
    model.Write(OUT, 8)
    print('\nobjects %d  verts %d  faces %d' % (len(PARTS), total_v, total_f))
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


if __name__ == '__main__':
    main()

