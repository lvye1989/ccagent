# -*- coding: utf-8 -*-
"""Isolated native regression for the reported 528 m loft and cap recovery."""
import os, sys, io, json, math, time, traceback
import Rhino, System
sys.dont_write_bytecode = True
root = os.path.dirname(__file__)
source = os.path.join(root, "ccagent_rhino_architecture.py")
scope = {"Rhino":Rhino,"System":System,"math":math,"json":json}
with open(source, "rb") as f: exec(compile(f.read(),source,"exec"),scope,scope)
active = Rhino.RhinoDoc.ActiveDoc
before = (active.RuntimeSerialNumber, active.Modified, sorted(str(o.Id) for o in active.Objects))
doc = Rhino.RhinoDoc.CreateHeadless(None)
doc.ModelUnitSystem = Rhino.UnitSystem.Meters
doc.ModelAbsoluteTolerance = 0.01
rows = []
export_path = None
def check(name, fn):
    try:
        fn()
        rows.append({"name":name,"ok":True})
    except Exception as error:
        rows.append({"name":name,"ok":False,"error":str(error),"trace":traceback.format_exc()[-1800:]})
p = {"sections":[{"z":z,"width":w,"depth":w} for z,w in [(0,69),(90,65.5),(180,61.5),(260,57.5),(330,51.5),(385,47),(430,48.5),(480,53.5),(528,58.5)]],
     "corner_ratio":0.14,"concavity":0.03,"crown_dip":0,"cap":True,"name":"Cap regression","layer":"Regression"}
def solid():
    result = scope['_loft'](doc,p)
    assert result['is_solid'] and len(result['created_guids']) == 1
    geometry = doc.Objects.FindId(System.Guid(result['created_guids'][0])).Geometry
    assert geometry.IsValid and geometry.IsSolid
    bounds = geometry.GetBoundingBox(True)
    assert abs(bounds.Min.Z) < 0.01 and abs(bounds.Max.Z - 528) < 0.01
def fallback():
    G=Rhino.Geometry
    curves=[scope['_ring'](s,p,s['z']/528.0) for s in p['sections']]
    side=G.Brep.CreateFromLoft(curves,G.Point3d.Unset,G.Point3d.Unset,G.LoftType.Normal,False)
    capped=scope['_join_planar_loft_caps'](side,curves,doc.ModelAbsoluteTolerance)
    assert len(capped)==1 and capped[0].IsValid and capped[0].IsSolid
def reject_nonplanar():
    count=doc.Objects.Count
    try: scope['_loft'](doc,dict(p,crown_dip=2))
    except ValueError as error:
        assert 'non-planar' in str(error)
        assert doc.Objects.Count==count
        return
    raise AssertionError('A nonplanar crown must not be silently flattened or opened')
def export_model():
    global export_path
    out=os.path.join(System.Environment.GetFolderPath(System.Environment.SpecialFolder.DesktopDirectory),'CCAGENT-Rhino','native-tests')
    if not os.path.isdir(out): os.makedirs(out)
    export_path=os.path.join(out,'model-file-check-'+str(System.Guid.NewGuid())+'.3dm')
    model=Rhino.FileIO.File3dm()
    for obj in doc.Objects: model.Objects.Add(obj.Geometry,obj.Attributes)
    assert model.Write(export_path,8)
    restored=Rhino.FileIO.File3dm.Read(export_path)
    assert restored and restored.Objects.Count == doc.Objects.Count
    with open(export_path,'rb') as f: assert f.read(24).startswith(b'3D Geometry File Format ')
try:
    check('reported_528m_planar_loft_is_solid',solid)
    check('exact_profile_cap_fallback_is_solid',fallback)
    check('nonplanar_crown_rejected_without_geometry',reject_nonplanar)
    check('verified_3dm_export_for_file_delivery',export_model)
finally:
    doc.Dispose()
    rows.append({"name":"active_user_document_preserved","ok":before==(active.RuntimeSerialNumber,active.Modified,sorted(str(o.Id) for o in active.Objects))})
    out=os.path.join(System.Environment.GetFolderPath(System.Environment.SpecialFolder.DesktopDirectory),'CCAGENT-Rhino','native-tests')
    if not os.path.isdir(out): os.makedirs(out)
    with io.open(os.path.join(out,'architecture-live-results.json'),'w',encoding='utf-8') as f:
        f.write(unicode(json.dumps({'passed':sum(r['ok'] for r in rows),'failed':sum(not r['ok'] for r in rows),'tests':rows,'export_path':export_path},ensure_ascii=False,indent=2)))
