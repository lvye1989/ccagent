# -*- coding: utf-8 -*-
"""Isolated definition IO, typed inputs, bounded results and explicit baking.

Loading ANY third-party definition is confirmation-gated by the caller. Disabling
the solver is not a sandbox: custom component deserialization can execute code.
"""
import os
import Rhino
import System
import clr
try:
    text = unicode
except NameError:
    text = str


def load_api():
    plugin = Rhino.RhinoApp.GetPlugInObject("Grasshopper")
    if plugin is None:
        raise RuntimeError("Grasshopper plugin is unavailable")
    plugin.LoadEditor()
    clr.AddReference("Grasshopper")
    import Grasshopper
    return Grasshopper


def guid(value):
    return System.Guid(str(value))


def object_by_id(ghdoc, value):
    obj = ghdoc.FindObject(guid(value), False)
    if obj is None:
        raise ValueError("Grasshopper component/parameter GUID not found: %s; inspect definition first" % value)
    return obj


def parameter_info(param, index=None):
    result = {"parameter_id": str(param.InstanceGuid), "name": text(param.Name), "nickname": text(param.NickName),
              "type": text(param.TypeName), "sources": int(param.SourceCount), "access": str(param.Access)}
    if index is not None: result["index"] = index
    return result


def inspect_definition(api, ghdoc, limit):
    components = []
    for obj in list(ghdoc.Objects)[:limit]:
        row = {"component_id": str(obj.InstanceGuid), "component_type_id": str(obj.ComponentGuid),
               "name": text(obj.Name), "nickname": text(obj.NickName), "class": obj.GetType().FullName,
               "assembly": obj.GetType().Assembly.GetName().Name}
        if isinstance(obj, api.Kernel.IGH_Component):
            row["inputs"] = [parameter_info(p, i) for i, p in enumerate(obj.Params.Input)]
            row["outputs"] = [parameter_info(p, i) for i, p in enumerate(obj.Params.Output)]
        elif isinstance(obj, api.Kernel.IGH_Param):
            row["parameter"] = parameter_info(obj)
        if isinstance(obj, api.Kernel.Special.GH_NumberSlider):
            row["slider"] = {"minimum": float(obj.Slider.Minimum), "maximum": float(obj.Slider.Maximum), "value": float(obj.CurrentValue)}
        components.append(row)
    return {"components": components, "component_count": ghdoc.Objects.Count, "truncated": ghdoc.Objects.Count > limit}


def input_parameter(api, ghdoc, value):
    # Component input socket GUIDs are not always indexed by FindObject.
    for obj in ghdoc.Objects:
        if str(obj.InstanceGuid).lower() == value.lower(): return obj
        if isinstance(obj, api.Kernel.IGH_Component):
            for param in obj.Params.Input:
                if str(param.InstanceGuid).lower() == value.lower(): return param
    raise ValueError("Input parameter_id not found; inspect definition first")


def set_inputs(api, ghdoc, rhino_doc, inputs):
    types = api.Kernel.Types
    for entry in inputs:
        param = input_parameter(api, ghdoc, entry["parameter_id"])
        kind, branches = entry["type"], entry["branches"]
        if isinstance(param, api.Kernel.Special.GH_NumberSlider):
            if kind not in ("number", "integer") or len(branches) != 1 or branches[0]["path"] != [0] or len(branches[0]["values"]) != 1:
                raise ValueError("Slider requires one number at path [0]")
            value = float(branches[0]["values"][0])
            if value < float(param.Slider.Minimum) or value > float(param.Slider.Maximum):
                raise ValueError("Slider value outside its range")
            param.SetSliderValue(System.Decimal(value))
            continue
        if not isinstance(param, api.Kernel.IGH_Param) or not hasattr(param, "PersistentData"):
            raise ValueError("Input must be a persistent parameter or a number slider")
        if param.SourceCount:
            raise ValueError("Input has connected sources; set the upstream parameter instead of severing connections")
        goo_type = param.PersistentData.GetType().GetGenericArguments()[0]
        tree = api.Kernel.Data.GH_Structure[goo_type]()
        for branch in branches:
            ghpath = api.Kernel.Data.GH_Path(System.Array[System.Int32](branch["path"]))
            tree.EnsurePath(ghpath)
            for value in branch["values"]:
                if kind == "number": goo = types.GH_Number(float(value))
                elif kind == "integer": goo = types.GH_Integer(int(value))
                elif kind == "boolean": goo = types.GH_Boolean(bool(value))
                elif kind == "string": goo = types.GH_String(value)
                elif kind == "point": goo = types.GH_Point(Rhino.Geometry.Point3d(*value))
                elif kind == "vector": goo = types.GH_Vector(Rhino.Geometry.Vector3d(*value))
                elif kind == "geometry":
                    obj = rhino_doc.Objects.FindId(guid(value))
                    if obj is None: raise ValueError("Referenced Rhino geometry no longer exists")
                    goo = api.Kernel.GH_Convert.ToGeometricGoo(obj.Geometry.Duplicate())
                else: raise ValueError("Unsupported Grasshopper input type")
                if goo is None or not goo_type.IsInstanceOfType(goo):
                    raise ValueError("Input type %s does not match parameter %s" % (kind, param.TypeName))
                tree.Append(goo, ghpath)
        param.SetPersistentData(tree)
        param.ExpireSolution(False)


def output_param(api, ghdoc, selected):
    obj = object_by_id(ghdoc, selected["component_id"])
    index = selected.get("output_index", 0)
    if isinstance(obj, api.Kernel.IGH_Component):
        if index >= obj.Params.Output.Count: raise ValueError("Output index out of range")
        return obj.Params.Output[index]
    if isinstance(obj, api.Kernel.IGH_Param) and index == 0: return obj
    raise ValueError("Selected object is not an output parameter/component")


def geometric(value):
    if isinstance(value, Rhino.Geometry.GeometryBase): return value.Duplicate()
    if isinstance(value, Rhino.Geometry.Point3d): return Rhino.Geometry.Point(value)
    if isinstance(value, Rhino.Geometry.Line): return Rhino.Geometry.LineCurve(value)
    if isinstance(value, (Rhino.Geometry.Circle, Rhino.Geometry.Arc, Rhino.Geometry.Rectangle3d)): return value.ToNurbsCurve()
    if isinstance(value, Rhino.Geometry.Box): return value.ToBrep()
    return None


def serialize_value(goo):
    if goo is None: return None
    value = goo.ScriptVariable()
    g = geometric(value)
    if g is not None:
        box = g.GetBoundingBox(True)
        return {"type": g.GetType().Name, "valid": bool(g.IsValid), "bounding_box": {
            "min": [box.Min.X, box.Min.Y, box.Min.Z], "max": [box.Max.X, box.Max.Y, box.Max.Z]}}
    if isinstance(value, (bool, int, float, str)): return value
    if isinstance(value, (System.Double, System.Decimal, System.Single)): return float(value)
    if isinstance(value, (System.Int32, System.Int64)): return int(value)
    return text(value)[:1000]


def run_grasshopper(rhino_doc, p):
    file_path = p["definition_path"]
    if not os.path.isfile(file_path) or os.path.splitext(file_path)[1].lower() not in (".gh", ".ghx"):
        raise ValueError("Expected an existing .gh or .ghx definition")
    if os.path.getsize(file_path) > 50 * 1024 * 1024:
        raise ValueError("Definition exceeds 50 MiB")
    api = load_api()
    operation = p.get("operation", "solve")
    if operation not in ("inspect", "solve", "bake"): raise ValueError("Unsupported Grasshopper operation")
    if operation == "bake" and not p.get("outputs"): raise ValueError("Bake requires explicit output selectors")
    enabled_before = bool(api.Kernel.GH_Document.EnableSolutions)
    ghdoc = None
    try:
        # Deserialization is never allowed to start the solver implicitly.
        api.Kernel.GH_Document.EnableSolutions = False
        io = api.Kernel.GH_DocumentIO()
        if not io.Open(file_path):
            raise RuntimeError("Grasshopper could not deserialize this file. Check file integrity and installed component plugins")
        ghdoc = io.Document
        if ghdoc is None: raise RuntimeError("Grasshopper document is empty")
        ghdoc.Enabled = False
        if ghdoc.Objects.Count > 5000: raise ValueError("Definition exceeds 5000 components")
        limit = int(p.get("max_items", 200))
        result = {"definition_path": file_path, "operation": operation, "isolated_document": True,
                  "solver_ran": False, "source_file_modified": False}
        result.update(inspect_definition(api, ghdoc, min(limit, 500)))
        if operation == "inspect": return result
        if not enabled_before: raise ValueError("Grasshopper solver is disabled by the user; enable it before solving")
        set_inputs(api, ghdoc, rhino_doc, p.get("inputs", []))
        selected = p.get("outputs", [])
        if not selected:
            selected = [{"component_id": str(obj.InstanceGuid), "output_index": i}
                        for obj in ghdoc.Objects if isinstance(obj, api.Kernel.IGH_Component)
                        for i in range(obj.Params.Output.Count)][:100]
        params = [(item, output_param(api, ghdoc, item)) for item in selected]
        api.Kernel.GH_Document.EnableSolutions = True
        ghdoc.Enabled = True
        ghdoc.NewSolution(False, api.Kernel.GH_SolutionMode.Silent)
        ghdoc.Enabled = False
        result["solver_ran"] = True
        errors, warnings = [], []
        for obj in ghdoc.Objects:
            if isinstance(obj, api.Kernel.IGH_ActiveObject):
                for level, dest in [(api.Kernel.GH_RuntimeMessageLevel.Error, errors), (api.Kernel.GH_RuntimeMessageLevel.Warning, warnings)]:
                    for message in obj.RuntimeMessages(level):
                        if len(dest) < 100: dest.append({"component_id": str(obj.InstanceGuid), "message": text(message)[:1000]})
        result.update(errors=errors, warnings=warnings, outputs=[])
        budget = limit
        bake_geometry = []
        for selection, param in params:
            tree = param.VolatileData
            row = dict(selection, total_items=int(tree.DataCount), branches=[])
            row["truncated"] = tree.DataCount > budget
            if operation == "bake" and tree.DataCount > budget:
                raise ValueError("Bake exceeds max_items; no partial bake was performed")
            for i in range(tree.PathCount):
                if budget <= 0: break
                branch = tree.get_Branch(i)
                values = []
                for goo in branch:
                    if budget <= 0: break
                    values.append(serialize_value(goo))
                    budget -= 1
                    if operation == "bake":
                        value = geometric(goo.ScriptVariable()) if goo is not None else None
                        if value is None or not value.IsValid:
                            raise ValueError("Bake selected a non-geometric or invalid output; nothing baked")
                        bake_geometry.append(value)
                row["branches"].append({"path": list(tree.get_Path(i).Indices), "values": values})
            result["outputs"].append(row)
        if operation == "bake":
            if errors: raise RuntimeError("Grasshopper has runtime errors; bake refused: %s" % errors)
            if not bake_geometry: raise ValueError("Selected outputs contain no geometry")
            # Fixed toolkit utility validates all geometry before adding anything.
            from ccagent_rhino_toolkit import add_results
            result.update(add_results(rhino_doc, {"layer": p.get("layer", "Grasshopper Bake")}, bake_geometry))
        result["ok"] = True
        result["solution_ok"] = not bool(errors)
        return result
    finally:
        if ghdoc is not None:
            ghdoc.Enabled = False
            ghdoc.Dispose()
        api.Kernel.GH_Document.EnableSolutions = enabled_before
