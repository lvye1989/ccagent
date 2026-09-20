# -*- coding: utf-8 -*-
"""Bounded, fixed RhinoCommon operations. No command or source-code inputs."""
import math
import Rhino
import System

G = Rhino.Geometry
ACTIONS = set(["create_curve", "create_solid", "curve_edit", "surface", "solid_edit",
               "mesh", "subd", "copy_objects", "object_state", "layer_manage", "group_manage"])


def pt(v):
    return G.Point3d(*v)


def vec(v):
    result = G.Vector3d(*v)
    if not result.Unitize():
        raise ValueError("Direction must be nonzero")
    return result


def plane(p):
    return G.Plane(pt(p.get("origin", [0, 0, 0])), vec(p.get("normal", [0, 0, 1])))


def objects(doc, p, key="target_guids"):
    result = []
    for value in p.get(key, []):
        obj = doc.Objects.FindId(System.Guid(value))
        if obj is None or obj.IsDeleted:
            raise ValueError("Missing object %s" % value)
        result.append(obj)
    return result


def geometries(items, kind):
    result = []
    for obj in items:
        value = obj.Geometry
        if kind == G.Brep:
            value = G.Brep.TryConvertBrep(value)
        if value is None or not isinstance(value, kind):
            raise ValueError("Expected %s, got %s" % (kind.__name__, obj.Geometry.GetType().Name))
        result.append(value)
    return result


def attrs(doc, p, source=None):
    value = source.Attributes.Duplicate() if source else Rhino.DocObjects.ObjectAttributes()
    if p.get("name"):
        value.Name = p["name"]
    if p.get("layer"):
        index = doc.Layers.FindByFullPath(p["layer"], -1)
        if index < 0:
            layer = Rhino.DocObjects.Layer()
            layer.Name = p["layer"]
            index = doc.Layers.Add(layer)
        if index < 0:
            raise ValueError("Could not resolve output layer")
        if doc.Layers[index].IsLocked:
            raise ValueError("Output layer is locked")
        value.LayerIndex = index
    # Derived geometry must not masquerade as the original parametric tower.
    value.SetUserString("ccagent_loft", None)
    return value


def add_results(doc, p, results, sources=None, attribute_sources=None):
    results = list(results or [])
    if not results or len(results) > 2000:
        raise ValueError("Operation returned no geometry or exceeded 2000 output objects")
    if any(g is None or not g.IsValid for g in results):
        raise ValueError("Operation produced invalid geometry; sources were preserved")
    sources = sources or []
    if p.get("delete_inputs"):
        assert_editable(doc, sources)
    attributes = attrs(doc, p, sources[0] if sources else None)
    created, deleted = [], []
    try:
        for index, geometry in enumerate(results):
            item_attributes = attrs(doc, p, attribute_sources[index]) if attribute_sources else attributes
            object_id = doc.Objects.Add(geometry, item_attributes)
            if object_id == System.Guid.Empty:
                raise RuntimeError("Rhino failed to add geometry")
            created.append(object_id)
        if p.get("delete_inputs"):
            for obj in sources:
                if not doc.Objects.Delete(obj.Id, True):
                    raise RuntimeError("Could not delete source %s" % obj.Id)
                deleted.append(obj)
    except Exception:
        for obj in deleted:
            doc.Objects.Undelete(obj)
        for object_id in created:
            doc.Objects.Delete(object_id, True)
        raise
    return {"created_guids": [str(x) for x in created], "deleted_guids": [str(x.Id) for x in deleted], "source_objects_preserved": not bool(deleted)}


def assert_editable(doc, items):
    for obj in items:
        if obj.IsLocked or obj.IsReference or doc.Layers[obj.Attributes.LayerIndex].IsLocked:
            raise ValueError("Locked/reference source cannot be modified: %s" % obj.Id)


def create_curve(p):
    op = p["operation"]
    if op == "arc":
        return G.Arc(pt(p["start"]), pt(p["through"]), pt(p["end"])).ToNurbsCurve()
    if op in ("interpolate", "nurbs"):
        points = [pt(v) for v in p["points"]]
        if p.get("closed") and points[0].DistanceTo(points[-1]) > 1e-10:
            points.append(points[0])
        if op == "interpolate":
            style = G.CurveKnotStyle.UniformPeriodic if p.get("closed") else G.CurveKnotStyle.Uniform
            return G.Curve.CreateInterpolatedCurve(points, 3, style)
        return G.Curve.CreateControlPointCurve(points, p.get("degree", 3))
    pl = plane(p)
    if op == "circle":
        return G.Circle(pl, p["radius"]).ToNurbsCurve()
    if op == "ellipse":
        return G.Ellipse(pl, p["radius_x"], p["radius_y"]).ToNurbsCurve()
    if op == "rectangle":
        return G.Rectangle3d(pl, p["width"], p["height"]).ToNurbsCurve()
    if op == "polygon":
        points = [pl.PointAt(p["radius"] * math.cos(i * 2 * math.pi / p["sides"]), p["radius"] * math.sin(i * 2 * math.pi / p["sides"])) for i in range(p["sides"])]
        return G.PolylineCurve(points + [points[0]])
    raise ValueError("Unsupported create_curve operation")


def curve_edit(doc, p, curves):
    op, tol = p["operation"], doc.ModelAbsoluteTolerance
    if op == "join":
        return G.Curve.JoinCurves(curves, tol)
    if op == "fillet":
        return G.Curve.CreateFilletCurves(curves[0], pt(p["pick_points"][0]), curves[1], pt(p["pick_points"][1]), p["radius"], False, p.get("trim", True), True, tol, doc.ModelAngleToleranceRadians)
    result = []
    for curve in curves:
        value = None
        if op == "explode":
            value = curve.DuplicateSegments()
        elif op == "offset":
            corners = {"sharp": G.CurveOffsetCornerStyle.Sharp, "round": G.CurveOffsetCornerStyle.Round, "smooth": G.CurveOffsetCornerStyle.Smooth, "chamfer": G.CurveOffsetCornerStyle.Chamfer}
            value = curve.Offset(plane(p), p["distance"], tol, corners[p.get("corner", "sharp")])
        elif op == "rebuild":
            value = [curve.Rebuild(p["point_count"], p.get("degree", 3), True)]
        elif op == "reverse":
            duplicate = curve.DuplicateCurve()
            if not duplicate.Reverse():
                raise ValueError("Curve could not be reversed")
            value = [duplicate]
        elif op == "simplify":
            value = [curve.Simplify(G.CurveSimplifyOptions.All, tol, doc.ModelAngleToleranceRadians) or curve.DuplicateCurve()]
        elif op == "split":
            if any(t <= curve.Domain.Min or t >= curve.Domain.Max for t in p["parameters"]):
                raise ValueError("split parameters must be inside the curve's native domain; inspect topology first")
            value = curve.Split(System.Array[System.Double](sorted(set(p["parameters"]))))
        elif op == "trim":
            a, b = p["interval"]
            if a < curve.Domain.Min or b > curve.Domain.Max:
                raise ValueError("trim interval is outside the curve domain")
            value = [curve.Trim(a, b)]
        else:
            raise ValueError("Unsupported curve_edit operation")
        if value is None or len(value) == 0:
            raise ValueError("Curve operation found no result")
        result.extend(value)
    return result


def surface(doc, p, curves):
    op, tol = p["operation"], doc.ModelAbsoluteTolerance
    if op == "planar":
        return G.Brep.CreatePlanarBreps(curves, tol)
    if op == "edge":
        return [G.Brep.CreateEdgeSurface(curves)]
    if op.startswith("sweep"):
        rails = geometries(objects(doc, p, "rail_guids"), G.Curve)
        if op == "sweep1":
            return G.Brep.CreateFromSweep(rails[0], curves, p.get("closed", False), tol)
        return G.Brep.CreateFromSweep(rails[0], rails[1], curves, p.get("closed", False), tol)
    result = []
    for curve in curves:
        if op == "revolve":
            rev = G.RevSurface.Create(curve, G.Line(pt(p["axis_start"]), pt(p["axis_end"])), 0.0, math.radians(p.get("angle_degrees", 360)))
            if rev is None:
                raise ValueError("Revolve failed")
            result.append(G.Brep.CreateFromRevSurface(rev, p.get("cap", False), p.get("cap", False)))
        elif op == "pipe":
            cap = {"none": getattr(G.PipeCapMode, "None"), "flat": G.PipeCapMode.Flat, "round": G.PipeCapMode.Round}[p.get("cap", "flat")]
            result.extend(G.Brep.CreatePipe(curve, p["radius"], False, cap, True, tol, doc.ModelAngleToleranceRadians) or [])
        else:
            raise ValueError("Unsupported surface operation")
    return result


def solid_edit(doc, p, breps):
    op, tol = p["operation"], doc.ModelAbsoluteTolerance
    if op == "join":
        return G.Brep.JoinBreps(breps, tol)
    result = []
    cutters = geometries(objects(doc, p, "cutter_guids"), G.Brep) if op == "split" else []
    for brep in breps:
        if op == "cap":
            value = [brep.DuplicateBrep() if brep.IsSolid else brep.CapPlanarHoles(tol)]
            if value[0] is None or not value[0].IsSolid:
                raise ValueError("Openings are not planar or cannot form a solid")
        elif op == "explode":
            value = [face.DuplicateFace(False) for face in brep.Faces]
        elif op == "offset":
            value, blends, walls = G.Brep.CreateOffsetBrep(brep, p["distance"], p.get("solid", False), False, tol)
            value = list(value or []) + list(blends or []) + list(walls or [])
        elif op in ("fillet_edges", "chamfer_edges"):
            indices = p["edge_indices"]
            if any(i >= brep.Edges.Count for i in indices):
                raise ValueError("Invalid edge index; use RhinoInspect topology")
            blend = G.BlendType.Fillet if op == "fillet_edges" else G.BlendType.Chamfer
            radii = System.Array[System.Double]([p["radius"]] * len(indices))
            value = G.Brep.CreateFilletEdges(brep, System.Array[System.Int32](indices), radii, radii, blend, G.RailType.RollingBall, tol)
        elif op == "shell":
            if any(i >= brep.Faces.Count for i in p["face_indices"]):
                raise ValueError("Invalid shell face index")
            value = G.Brep.CreateShell(brep, System.Array[System.Int32](p["face_indices"]), p["thickness"], tol)
        elif op == "split":
            value = brep.Split(System.Array[G.Brep](cutters), tol)
        elif op == "trim_plane":
            value = brep.Trim(plane(p), tol)
        else:
            raise ValueError("Unsupported solid_edit operation")
        if value is None or len(value) == 0:
            raise ValueError("Solid operation found no result; check geometry and tolerance")
        result.extend(value)
    return result


def mesh_edit(doc, p, items):
    op = p["operation"]
    if op == "from_brep":
        settings = G.MeshingParameters.Smooth if p.get("quality") == "smooth" else G.MeshingParameters.FastRenderMesh
        result = []
        for brep in geometries(items, G.Brep):
            combined = G.Mesh()
            for m in G.Mesh.CreateFromBrep(brep, settings) or []:
                combined.Append(m)
            result.append(combined)
        return result
    source = geometries(items, G.Mesh)
    if sum(m.Faces.Count for m in source) > 2000000:
        raise ValueError("Mesh operation exceeds 2 million input faces")
    if op == "join":
        combined = G.Mesh()
        for m in source:
            combined.Append(m)
        return [combined]
    result = []
    for mesh in source:
        m = mesh.DuplicateMesh()
        if op == "explode":
            result.extend(m.SplitDisjointPieces() or [m])
            continue
        if op == "reduce":
            if p["face_count"] < m.Faces.Count and not m.Reduce(p["face_count"], True, 5, False):
                raise ValueError("Mesh reduction failed")
        elif op == "triangulate":
            m.Faces.ConvertQuadsToTriangles()
        elif op == "quadrangulate":
            m.Faces.ConvertTrianglesToQuads(doc.ModelAngleToleranceRadians, 0.875)
        elif op == "weld":
            m.Weld(math.radians(p.get("angle_degrees", 180)))
        elif op == "unify_normals":
            m.UnifyNormals()
        else:
            raise ValueError("Unsupported mesh operation")
        m.Normals.ComputeNormals()
        m.Compact()
        result.append(m)
    return result


def manage(doc, action, p, items):
    op = p["operation"]
    if action == "object_state":
        if op in ("delete", "rename"):
            assert_editable(doc, items)
        changed = []
        for obj in items:
            if op == "rename":
                a = obj.Attributes.Duplicate()
                a.Name = p["name"]
                ok = doc.Objects.ModifyAttributes(obj.Id, a, True)
            elif op in ("select", "deselect"):
                doc.Objects.Select(obj.Id, op == "select")
                ok = (doc.Objects.FindId(obj.Id).IsSelected(False) > 0) == (op == "select")
            else:
                method = {"hide": doc.Objects.Hide, "show": doc.Objects.Show, "lock": doc.Objects.Lock, "unlock": doc.Objects.Unlock, "delete": doc.Objects.Delete}.get(op)
                if method is None:
                    raise ValueError("Unsupported object state")
                if (op == "hide" and obj.IsHidden) or (op == "show" and not obj.IsHidden) or (op == "lock" and obj.IsLocked) or (op == "unlock" and not obj.IsLocked):
                    ok = True
                else:
                    ok = method(obj.Id, True)
            if not ok:
                raise ValueError("%s failed on %s; earlier updates, if any: %s. Undo this action before retrying" % (op, obj.Id, changed))
            changed.append(str(obj.Id))
        return {"deleted_guids" if op == "delete" else "updated_guids": changed}
    if action == "layer_manage":
        index = doc.Layers.FindByFullPath(p["layer"], -1)
        if op == "create":
            if index >= 0:
                raise ValueError("Layer already exists")
            layer = Rhino.DocObjects.Layer()
            layer.Name = p["layer"]
            if p.get("color") is not None:
                layer.Color = System.Drawing.Color.FromArgb(*p["color"])
            index = doc.Layers.Add(layer)
            if index < 0:
                raise ValueError("Layer creation failed")
        else:
            if index < 0:
                raise ValueError("Layer does not exist")
            layer = doc.Layers[index]
            if op in ("delete_empty", "visibility", "lock") and index == doc.Layers.CurrentLayerIndex:
                raise ValueError("Cannot delete, hide or lock the current layer")
            if op == "delete_empty":
                if len(doc.Objects.FindByLayer(layer) or []) or any(x.ParentLayerId == layer.Id for x in doc.Layers if x and not x.IsDeleted):
                    raise ValueError("Only empty childless layers can be deleted")
                if not doc.Layers.Delete(index, True):
                    raise ValueError("Layer deletion failed")
            elif op == "set_current":
                if not doc.Layers.SetCurrentLayerIndex(index, True):
                    raise ValueError("Could not set current layer")
            else:
                if op == "rename": layer.Name = p["new_name"]
                elif op == "visibility": layer.IsVisible = p["visible"]
                elif op == "lock": layer.IsLocked = p["locked"]
                elif op == "color": layer.Color = System.Drawing.Color.FromArgb(*p["color"])
                else: raise ValueError("Unsupported layer operation")
                # Rhino 8 layer setters commit immediately. The obsolete
                # CommitChanges can return false after a successful setter.
                actual = doc.Layers[index]
                correct = (op == "rename" and actual.Name == p["new_name"]
                           or op == "visibility" and actual.IsVisible == p["visible"]
                           or op == "lock" and actual.IsLocked == p["locked"]
                           or op == "color" and actual.Color == System.Drawing.Color.FromArgb(*p["color"]))
                if not correct:
                    raise ValueError("Could not update layer")
        return {"layer_index": index, "operation": op}
    index = doc.Groups.Find(p["group"], True)
    if op == "create":
        if index >= 0: raise ValueError("Group already exists")
        index = doc.Groups.Add(p["group"], System.Array[System.Guid]([o.Id for o in items]))
        if index < 0: raise ValueError("Group creation failed")
    else:
        if index < 0: raise ValueError("Group not found")
        if op == "ungroup":
            if not doc.Groups.Delete(index): raise ValueError("Ungroup failed")
        elif op == "add":
            missing = [o.Id for o in items if index not in list(o.Attributes.GetGroupList() or [])]
            if missing and not doc.Groups.AddToGroup(index, System.Array[System.Guid](missing)): raise ValueError("Group add failed")
        elif op == "remove":
            for obj in items:
                a = obj.Attributes.Duplicate()
                a.RemoveFromGroup(index)
                if not doc.Objects.ModifyAttributes(obj.Id, a, True): raise ValueError("Group removal failed")
        else: raise ValueError("Unsupported group operation")
    return {"group_index": index, "operation": op}


def execute_toolkit(doc, action, p):
    if action not in ACTIONS:
        raise ValueError("Unknown toolkit action")
    items = objects(doc, p)
    if p.get("delete_inputs"):
        assert_editable(doc, items)
    if action in ("object_state", "layer_manage", "group_manage"):
        return manage(doc, action, p, items)
    if action == "create_curve": result = [create_curve(p)]
    elif action == "create_solid":
        result = [G.Cone(plane(p), p["height"], p["radius"]).ToBrep(True)] if p["operation"] == "cone" else [G.Torus(plane(p), p["major_radius"], p["minor_radius"]).ToBrep()]
    elif action == "curve_edit": result = curve_edit(doc, p, geometries(items, G.Curve))
    elif action == "surface": result = surface(doc, p, geometries(items, G.Curve))
    elif action == "solid_edit": result = solid_edit(doc, p, geometries(items, G.Brep))
    elif action == "mesh": result = mesh_edit(doc, p, items)
    elif action == "subd":
        result = []
        for obj in items:
            if p["operation"] == "from_mesh": value = G.SubD.CreateFromMesh(geometries([obj], G.Mesh)[0])
            elif p["operation"] == "to_brep": value = geometries([obj], G.SubD)[0].ToBrep()
            else:
                value = geometries([obj], G.SubD)[0].Duplicate()
                if value.Faces.Count * 4 ** p.get("levels", 1) > 200000: raise ValueError("SubD exceeds 200000 output faces")
                if not value.Subdivide(p.get("levels", 1)): raise ValueError("SubD subdivision failed")
            result.append(value)
    elif action == "copy_objects":
        result = []
        attribute_sources = []
        count = p.get("count", 2)
        if len(items) * (count - 1) > 2000: raise ValueError("Array exceeds 2000 new objects")
        for i in range(1, count):
            op = p["operation"]
            if op in ("copy", "linear_array"):
                transform = G.Transform.Translation(G.Vector3d(*p.get("vector", [0,0,0])) * i)
            elif op == "mirror": transform = G.Transform.Mirror(plane(p))
            elif op == "polar_array":
                angle = p.get("angle_degrees", 360)
                divisor = count if abs(angle - 360) < 1e-8 else count - 1
                transform = G.Transform.Rotation(math.radians(angle * i / divisor), vec(p.get("axis", [0,0,1])), pt(p["center"]))
            else: raise ValueError("Unsupported copy operation")
            for obj in items:
                value = obj.Geometry.Duplicate()
                if not value.Transform(transform): raise ValueError("Transform failed")
                result.append(value)
                attribute_sources.append(obj)
        return add_results(doc, p, result, items, attribute_sources)
    else: raise ValueError("Unsupported toolkit action")
    return add_results(doc, p, result, items)


def xyz(p):
    return [p.X, p.Y, p.Z]


def geometry_info(g):
    box = g.GetBoundingBox(True)
    return {"type": g.GetType().Name, "valid": bool(g.IsValid), "bounding_box": {"min": xyz(box.Min), "max": xyz(box.Max)}}


def inspect_geometry(doc, p):
    items = objects(doc, p)
    op, limit = p["operation"], p.get("max_items", 100)
    detail_limit = max(1, limit // max(1, min(len(items), limit)))
    result = []
    if op == "intersection":
        if len(items) != 2: raise ValueError("intersection requires two targets")
        a, b = [o.Geometry for o in items]
        if isinstance(a, G.Curve) and isinstance(b, G.Curve):
            events = G.Intersect.Intersection.CurveCurve(a, b, doc.ModelAbsoluteTolerance, doc.ModelAbsoluteTolerance)
            return {"ok": True, "events": [{"point_a": xyz(e.PointA), "point_b": xyz(e.PointB), "overlap": bool(e.IsOverlap)} for e in list(events or [])[:limit]], "truncated": bool(events and events.Count > limit)}
        breps = geometries(items, G.Brep)
        ok, curves, points = G.Intersect.Intersection.BrepBrep(breps[0], breps[1], doc.ModelAbsoluteTolerance)
        return {"ok": True, "intersects": bool(ok and (len(curves or []) or len(points or []))), "curves": [geometry_info(c) for c in list(curves or [])[:limit]], "points": [xyz(v) for v in list(points or [])[:limit]]}
    for obj in items[:limit]:
        g = obj.Geometry
        row = dict(geometry_info(g), guid=str(obj.Id))
        if op == "measure":
            if isinstance(g, G.Curve): row["length"] = g.GetLength()
            if isinstance(g, (G.Curve, G.Brep, G.Mesh, G.Surface)):
                mass = G.AreaMassProperties.Compute(g)
                if mass:
                    row.update(area=mass.Area, area_centroid=xyz(mass.Centroid))
                    mass.Dispose()
            solid = isinstance(g, G.Brep) and g.IsSolid or isinstance(g, G.Mesh) and g.IsClosed
            if solid:
                mass = G.VolumeMassProperties.Compute(g)
                if mass:
                    row.update(volume=mass.Volume, volume_centroid=xyz(mass.Centroid))
                    mass.Dispose()
        elif op == "topology":
            if isinstance(g, G.Curve): row.update(domain=[g.Domain.Min, g.Domain.Max], closed=bool(g.IsClosed), degree=g.Degree, start=xyz(g.PointAtStart), end=xyz(g.PointAtEnd))
            if isinstance(g, G.Brep):
                row.update(solid=bool(g.IsSolid), edge_count=g.Edges.Count, face_count=g.Faces.Count,
                           edges=[dict(geometry_info(e), index=e.EdgeIndex, length=e.GetLength()) for e in list(g.Edges)[:detail_limit]],
                           faces=[dict(geometry_info(f), index=f.FaceIndex) for f in list(g.Faces)[:detail_limit]],
                           topology_truncated=g.Edges.Count > detail_limit or g.Faces.Count > detail_limit)
            if isinstance(g, G.Mesh): row.update(vertices=g.Vertices.Count, faces=g.Faces.Count, closed=bool(g.IsClosed))
        elif op == "divide_curve":
            curve = geometries([obj], G.Curve)[0]
            parameters = list(curve.DivideByCount(p.get("count", 20), True) or [])
            row.update(points=[xyz(curve.PointAt(t)) for t in parameters[:detail_limit]], parameters=parameters[:detail_limit], truncated=len(parameters)>detail_limit)
        elif op == "closest_point":
            q = pt(p["point"])
            if isinstance(g, G.Curve):
                ok, t = g.ClosestPoint(q)
                if not ok: raise ValueError("Closest point failed")
                closest = g.PointAt(t)
                row["parameter"] = t
            elif isinstance(g, G.Brep): closest = g.ClosestPoint(q)
            elif isinstance(g, G.Mesh): closest = g.ClosestPoint(q)
            else: raise ValueError("closest_point supports curves, Breps and meshes")
            row.update(point=xyz(closest), distance=closest.DistanceTo(q))
        elif op == "section":
            if not isinstance(g, G.Brep): raise ValueError("section currently requires Breps")
            ok, curves, points = G.Intersect.Intersection.BrepPlane(g, plane(p), doc.ModelAbsoluteTolerance)
            row.update(curves=[geometry_info(c) for c in list(curves or [])[:detail_limit]], points=[xyz(v) for v in list(points or [])[:detail_limit]],truncated=len(curves or [])>detail_limit or len(points or [])>detail_limit)
        else: raise ValueError("Unsupported inspection")
        result.append(row)
    return {"ok": True, "operation": op, "units": str(doc.ModelUnitSystem), "results": result, "truncated": len(items) > limit}
