# -*- coding: utf-8 -*-
"""Opt-in native API regression. Uses and disposes a separate headless document.
Run only through the fixed test-rhino-toolkit-live.ps1 developer harness.
"""
import os
import sys
sys.dont_write_bytecode = True
import io
import json
import time
import traceback
import Rhino
import System
import scriptcontext as sc

root = os.path.dirname(__file__)
output_root = os.path.join(System.Environment.GetFolderPath(System.Environment.SpecialFolder.DesktopDirectory), "CCAGENT-Rhino", "native-tests")
if not os.path.isdir(output_root): os.makedirs(output_root)
if root not in sys.path: sys.path.insert(0, root)
import ccagent_rhino_toolkit as tk
import ccagent_grasshopper as gh
reload(tk)
reload(gh)
G = Rhino.Geometry
rows = []
original = sc.doc
active_serial = Rhino.RhinoDoc.ActiveDoc.RuntimeSerialNumber
doc = Rhino.RhinoDoc.CreateHeadless(None)
doc.ModelUnitSystem = Rhino.UnitSystem.Meters
doc.ModelAbsoluteTolerance = 0.001
sc.doc = doc


def check(name, fn):
    started = time.time()
    try:
        result = fn()
        rows.append({"name": name, "ok": True, "duration_ms": int((time.time()-started)*1000)})
        return result
    except Exception as error:
        rows.append({"name": name, "ok": False, "error": str(error), "trace": traceback.format_exc()[-1800:]})
        return None


def action(name, p):
    result = tk.execute_toolkit(doc, name, p)
    for object_id in result.get("created_guids", []):
        assert doc.Objects.FindId(System.Guid(object_id)).Geometry.IsValid
    return result


def curve(points):
    return str(doc.Objects.AddPolyline([G.Point3d(*v) for v in points]))


def expect_failure(fn):
    try: fn()
    except Exception: return True
    raise AssertionError("Expected rejection")


def grasshopper_tests():
    api = gh.load_api()
    ghdoc = api.Kernel.GH_Document()
    ghdoc.Enabled = False
    a, b = api.Kernel.Parameters.Param_Number(), api.Kernel.Parameters.Param_Number()
    points = api.Kernel.Parameters.Param_Point()
    for obj, name in [(a,"Input_A"),(b,"Input_B"),(points,"Bake_Points")]:
        obj.CreateAttributes()
        obj.NickName = name
        ghdoc.AddObject(obj, False)
    proxies = [proxy for proxy in api.Instances.ComponentServer.ObjectProxies if proxy.Desc.Name == "Addition" and proxy.Desc.Category == "Maths"]
    assert proxies, "Built-in Addition component was not found"
    addition = proxies[0].CreateInstance()
    addition.CreateAttributes()
    ghdoc.AddObject(addition, False)
    addition.Params.Input[0].AddSource(a)
    addition.Params.Input[1].AddSource(b)
    fixture = os.path.join(output_root, "toolkit-fixture-" + str(System.Guid.NewGuid()) + ".gh")
    assert api.Kernel.GH_DocumentIO(ghdoc).SaveQuiet(fixture)
    a_id, b_id, point_id, add_id = [str(x.InstanceGuid) for x in (a,b,points,addition)]
    ghdoc.Dispose()
    graph_before = api.Instances.ActiveCanvas.Document if api.Instances.ActiveCanvas is not None else None
    enabled_before = api.Kernel.GH_Document.EnableSolutions
    assert enabled_before, "User paused GH solver; solve tests require it enabled"
    before_bytes = open(fixture,"rb").read()
    inspection = gh.run_grasshopper(doc,{"definition_path":fixture,"operation":"inspect","max_items":100})
    assert inspection["solver_ran"] is False and inspection["component_count"] == 4
    rows.append({"name":"gh_inspect_isolated_definition","ok":True})
    p = {"definition_path":fixture,"operation":"solve","max_items":100,
         "inputs":[{"parameter_id":a_id,"type":"number","branches":[{"path":[0],"values":[2.0,4.0]},{"path":[1],"values":[10.0]}]},
                   {"parameter_id":b_id,"type":"number","branches":[{"path":[0],"values":[3.0]}]}],
         "outputs":[{"component_id":add_id,"output_index":0}]}
    solved = gh.run_grasshopper(doc,p)
    assert solved["solution_ok"], solved["errors"]
    branches = solved["outputs"][0]["branches"]
    assert branches[0]["values"] == [5.0,7.0] and branches[1]["values"] == [13.0], branches
    rows.append({"name":"gh_typed_tree_addition_solve","ok":True})
    p["operation"] = "bake"
    p["inputs"] = [{"parameter_id":point_id,"type":"point","branches":[{"path":[0],"values":[[1,2,3],[4,5,6]]}]}]
    p["outputs"] = [{"component_id":point_id,"output_index":0}]
    p["layer"] = "Toolkit GH Bake"
    # Arithmetic inputs were empty in the file, so give valid persistent values
    # to avoid unrelated addition errors when testing an explicit point bake.
    p["inputs"] += [{"parameter_id":x,"type":"number","branches":[{"path":[0],"values":[1.0]}]} for x in (a_id,b_id)]
    baked = gh.run_grasshopper(doc,p)
    assert len(baked["created_guids"]) == 2
    rows.append({"name":"gh_selected_output_bake","ok":True})
    p["max_items"] = 1
    expect_failure(lambda: gh.run_grasshopper(doc,p))
    rows.append({"name":"gh_bake_budget_rejects_partial_bake","ok":True})
    assert open(fixture,"rb").read() == before_bytes
    assert api.Kernel.GH_Document.EnableSolutions == enabled_before
    assert api.Instances.ActiveCanvas is None or api.Instances.ActiveCanvas.Document == graph_before
    rows.append({"name":"gh_user_canvas_solver_and_file_preserved","ok":True})
    return fixture


try:
    circle = str(doc.Objects.AddCircle(G.Circle(G.Plane.WorldXY, 5)))
    rectangle = curve([[0,0,0],[10,0,0],[10,8,0],[0,8,0],[0,0,0]])
    line = curve([[0,0,0],[0,0,10]])
    line2 = curve([[10,0,0],[10,0,10]])
    section = curve([[0,0,0],[10,0,0]])
    box = str(doc.Objects.AddBrep(G.BoundingBox(G.Point3d(0,0,0),G.Point3d(10,10,10)).ToBrep()))
    box2 = str(doc.Objects.AddBrep(G.BoundingBox(G.Point3d(5,5,5),G.Point3d(15,15,15)).ToBrep()))
    mesh = G.Mesh()
    for part in G.Mesh.CreateFromBrep(doc.Objects.FindId(System.Guid(box)).Geometry, G.MeshingParameters.FastRenderMesh): mesh.Append(part)
    mesh_id = str(doc.Objects.AddMesh(mesh))
    curve_cases = [("circle",{"radius":5}), ("ellipse",{"radius_x":5,"radius_y":3}),
                   ("arc",{"start":[0,0,0],"through":[5,5,0],"end":[10,0,0]}),
                   ("rectangle",{"width":8,"height":6}), ("polygon",{"radius":4,"sides":6}),
                   ("interpolate",{"points":[[0,0,0],[3,5,0],[7,3,0],[10,0,0]]}),
                   ("nurbs",{"points":[[0,0,0],[3,5,0],[7,3,0],[10,0,0]],"degree":3})]
    for op, args in curve_cases:
        check("create_curve_"+op,lambda op=op,args=args: action("create_curve",dict(args,operation=op)))
    check("cone",lambda: action("create_solid",{"operation":"cone","radius":4,"height":10}))
    check("torus",lambda: action("create_solid",{"operation":"torus","major_radius":5,"minor_radius":1}))
    curve_cases = [("join",[line,line2],{}),("explode",[rectangle],{}),("offset",[rectangle],{"distance":1}),
                   ("reverse",[circle],{}),("simplify",[rectangle],{}),("rebuild",[circle],{"point_count":12,"degree":3}),
                   ("split",[circle],{"parameters":[3.14]}),("trim",[circle],{"interval":[0,3.14]}),
                   ("fillet",[section,line2],{"pick_points":[[9,0,0],[10,0,1]],"radius":1})]
    for op, ids, args in curve_cases:
        check("curve_edit_"+op,lambda op=op,ids=ids,args=args: action("curve_edit",dict(args,operation=op,target_guids=ids)))
    top = curve([[0,0,10],[10,0,10]])
    for op, ids, args in [("planar",[rectangle],{}),("edge",[line,section,line2,top],{}),
                           ("revolve",[line2],{"axis_start":[0,0,0],"axis_end":[0,0,10]}),
                           ("sweep1",[section],{"rail_guids":[line]}),("sweep2",[section,top],{"rail_guids":[line,line2]}),
                           ("pipe",[line],{"radius":1})]:
        check("surface_"+op,lambda op=op,ids=ids,args=args: action("surface",dict(args,operation=op,target_guids=ids)))
    for op, args in [("cap",{}),("join",{}),("explode",{}),("offset",{"distance":1}),
                     ("fillet_edges",{"edge_indices":[0],"radius":0.5}),("chamfer_edges",{"edge_indices":[0],"radius":0.5}),
                     ("shell",{"face_indices":[0],"thickness":-0.5}),("split",{"cutter_guids":[box2]}),
                     ("trim_plane",{"origin":[0,0,5],"normal":[0,0,1]})]:
        check("solid_edit_"+op,lambda op=op,args=args: action("solid_edit",dict(args,operation=op,target_guids=[box])))
    for op in ["from_brep","join","explode","reduce","triangulate","quadrangulate","weld","unify_normals"]:
        args = {"operation":op,"target_guids":[box if op=="from_brep" else mesh_id]}
        if op=="reduce": args["face_count"] = 8
        check("mesh_"+op,lambda args=args: action("mesh",args))
    subd = check("subd_from_mesh",lambda: action("subd",{"operation":"from_mesh","target_guids":[mesh_id]}))
    if subd:
        for op in ["to_brep","subdivide"]:
            check("subd_"+op,lambda op=op:action("subd",{"operation":op,"target_guids":subd["created_guids"],"levels":1}))
    for op, args in [("copy",{}),("mirror",{}),("linear_array",{"vector":[20,0,0],"count":3}),
                     ("polar_array",{"center":[0,0,0],"count":4})]:
        check("copy_"+op,lambda op=op,args=args: action("copy_objects",dict(args,operation=op,target_guids=[box])))
    for op in ["select","deselect","hide","show","lock","unlock","rename"]:
        check("state_"+op,lambda op=op: action("object_state",{"operation":op,"target_guids":[box],"name":"Toolkit Box"}))
    for op,args in [("create",{}),("color",{"color":[20,100,200]}),("visibility",{"visible":False}),
                    ("visibility",{"visible":True}),("lock",{"locked":True}),("lock",{"locked":False}),
                    ("rename",{"new_name":"Toolkit Renamed"})]:
        check("layer_"+op,lambda op=op,args=args:action("layer_manage",dict(args,operation=op,layer="Toolkit Layer")))
    check("layer_delete_empty",lambda:action("layer_manage",{"operation":"delete_empty","layer":"Toolkit Renamed"}))
    for op in ["create","add","remove","ungroup"]:
        check("group_"+op,lambda op=op:action("group_manage",{"operation":op,"group":"Toolkit Group","target_guids":[box]}))
    for op,ids,args in [("measure",[box,circle,mesh_id],{}),("topology",[box,circle,mesh_id],{}),
                        ("divide_curve",[circle],{}),("closest_point",[circle,box,mesh_id],{"point":[2,3,4]}),
                        ("intersection",[box,box2],{}),("section",[box],{"origin":[0,0,5],"normal":[0,0,1]})]:
        check("inspect_"+op,lambda op=op,ids=ids,args=args:tk.inspect_geometry(doc,dict(args,operation=op,target_guids=ids)))
    check("locked_delete_rejected",lambda: (doc.Objects.Lock(System.Guid(box),True),expect_failure(lambda:action("object_state",{"operation":"delete","target_guids":[box]})),doc.Objects.Unlock(System.Guid(box),True)))
    check("delete",lambda:action("object_state",{"operation":"delete","target_guids":[box2]}))
    fixture = check("grasshopper_workflow",grasshopper_tests)
finally:
    sc.doc = original
    doc.Dispose()
    rows.append({"name":"active_user_document_preserved","ok":Rhino.RhinoDoc.ActiveDoc.RuntimeSerialNumber==active_serial})
    output = os.path.join(output_root,"toolkit-live-results.json")
    with io.open(output,"w",encoding="utf-8") as f:
        f.write(unicode(json.dumps({"passed":sum(r["ok"] for r in rows),"failed":sum(not r["ok"] for r in rows),"tests":rows,"fixture_path":globals().get("fixture")},ensure_ascii=False,indent=2)))
    print(output)
