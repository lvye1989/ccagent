# -*- coding: utf-8 -*-
"""探测：苏博模型包围盒 + rhino3dm 关键 API 行为确认"""
import sys
import rhino3dm

SRC = r"C:\Users\Windows11\Desktop\CCAGENT-Rhino\Rhino-2026-09-21T12-45-10-977Z-660b5523\models\suzhou-museum.3dm"

model = rhino3dm.File3dm.Read(SRC)
print("objects:", len(model.Objects))


def obj_bbox(geo):
    """返回 (min, max) 或 None"""
    try:
        if isinstance(geo, rhino3dm.Mesh):
            bb = geo.GetBoundingBox()
        elif isinstance(geo, rhino3dm.Brep):
            bb = geo.GetBoundingBox()
        else:
            bb = None
        if bb is None:
            return None
        return ((bb.Min.X, bb.Min.Y, bb.Min.Z), (bb.Max.X, bb.Max.Y, bb.Max.Z))
    except Exception as e:
        return None


mn = [1e18] * 3
mx = [-1e18] * 3
kinds = {}
none_cnt = 0
for o in model.Objects:
    geo = o.Geometry
    kinds[type(geo).__name__] = kinds.get(type(geo).__name__, 0) + 1
    bb = obj_bbox(geo)
    if bb is None:
        none_cnt += 1
        continue
    for i in range(3):
        mn[i] = min(mn[i], bb[0][i])
        mx[i] = max(mx[i], bb[1][i])

print("geometry kinds:", kinds)
print("bbox_failed:", none_cnt)
print("doc bbox min:", [round(v, 3) for v in mn])
print("doc bbox max:", [round(v, 3) for v in mx])

# API 确认
m = rhino3dm.File3dm()
m.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Meters
L = rhino3dm.Layer()
L.Name = "测试层"
L.Color = (10, 20, 30, 255)
li = m.Layers.Add(L)
print("Layers.Add ->", li, type(li))
M = rhino3dm.Material()
M.DiffuseColor = (200, 100, 50, 255)
M.Transparency = 0.5
mi = m.Materials.Add(M)
print("Materials.Add ->", mi, type(mi))
g = rhino3dm.Mesh()
g.Vertices.Add(0, 0, 0)
g.Vertices.Add(1, 0, 0)
g.Vertices.Add(0, 1, 0)
g.Vertices.Add(0, 0, 1)
g.Faces.AddFace(0, 1, 2)
g.Faces.AddFace(0, 1, 3)
g.Faces.AddFace(0, 2, 3)
g.Faces.AddFace(1, 2, 3)
print("len(Vertices)", len(g.Vertices), "len(Faces)", len(g.Faces))
g.Normals.ComputeNormals()
g.Compact()
print("IsValid", g.IsValid)
A = rhino3dm.ObjectAttributes()
A.Name = "测试物件"
A.LayerIndex = li
A.MaterialIndex = mi
A.MaterialSource = rhino3dm.ObjectMaterialSource.MaterialFromObject
gu = m.Objects.AddMesh(g, A)
print("AddMesh ->", gu, type(gu))
print("OK")
