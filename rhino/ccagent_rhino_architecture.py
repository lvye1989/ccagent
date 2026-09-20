# -*- coding: utf-8 -*-
"""Fixed RhinoCommon architectural actions. No model-supplied code is executed."""


def _number(value, name, lower=None, upper=None):
    value = float(value)
    if math.isnan(value) or math.isinf(value) or (lower is not None and value < lower) or (upper is not None and value > upper):
        raise ValueError("Invalid %s" % name)
    return value


def _layer(doc, name, color):
    index = doc.Layers.FindByFullPath(name, -1)
    if index < 0:
        layer = Rhino.DocObjects.Layer()
        layer.Name = name
        layer.Color = System.Drawing.Color.FromArgb(*color)
        index = doc.Layers.Add(layer)
    if index < 0:
        raise RuntimeError("Could not create layer %s" % name)
    return index


def _attributes(doc, name, layer_name, color, opacity=1.0, component=None):
    attributes = Rhino.DocObjects.ObjectAttributes()
    attributes.Name = name
    attributes.LayerIndex = _layer(doc, layer_name, color)
    attributes.ObjectColor = System.Drawing.Color.FromArgb(*color)
    attributes.ColorSource = Rhino.DocObjects.ObjectColorSource.ColorFromObject
    material = Rhino.DocObjects.Material()
    material.Name = name
    material.DiffuseColor = attributes.ObjectColor
    material.Transparency = 1.0 - opacity
    material.Shine = 180.0 if component and "glass" in component else 70.0
    material.Reflectivity = 0.35 if component and "glass" in component else 0.15
    attributes.MaterialIndex = doc.Materials.Add(material)
    attributes.MaterialSource = Rhino.DocObjects.ObjectMaterialSource.MaterialFromObject
    if component:
        attributes.SetUserString("ccagent_component", component)
    return attributes


def _ring(section, parameters, fraction):
    width = _number(section["width"], "width", 0.01, 10000)
    depth = _number(section["depth"], "depth", 0.01, 10000)
    z = _number(section["z"], "z")
    center = parameters.get("center", [0, 0, 0])
    ratio = _number(parameters.get("corner_ratio", 0.15), "corner_ratio", 0, 0.4)
    concavity = _number(parameters.get("concavity", 0.02), "concavity", 0, 0.15)
    dip = _number(parameters.get("crown_dip", 0), "crown_dip", 0, 20) * fraction ** 14
    # Four identical parameterized sides. Each starts at a rounded corner's
    # midpoint, traverses a subtly concave facade and ends at the next corner.
    points = []
    radius = min(width, depth) * max(ratio, 0.01)
    for side in range(4):
        half = (width if side % 2 == 0 else depth) * 0.5
        perpendicular = (depth if side % 2 == 0 else width) * 0.5
        local = []
        # Leading half-corner, straight/concave facade, trailing half-corner.
        for i in range(4):
            angle = math.radians(135 - 45 * i / 4.0)
            local.append((-half + radius + radius * math.cos(angle), perpendicular - radius + radius * math.sin(angle)))
        for i in range(17):
            t = i / 16.0
            local.append((-half + radius + (2 * half - 2 * radius) * t, perpendicular - concavity * min(width, depth) * math.sin(math.pi * t) ** 2))
        for i in range(1, 5):
            angle = math.radians(90 - 45 * i / 5.0)
            local.append((half - radius + radius * math.cos(angle), perpendicular - radius + radius * math.sin(angle)))
        for x, y in local:
            # side center lower than corner; crown remains an open wavy rim.
            sag = dip * max(0.0, 1.0 - (abs(x) / (half - radius)) ** 2)
            if side == 0:
                px, py = x, y
            elif side == 1:
                px, py = y, -x
            elif side == 2:
                px, py = -x, -y
            else:
                px, py = -y, x
            points.append(Rhino.Geometry.Point3d(px + center[0], py + center[1], z + center[2] - sag))
    # Explicit closure is needed by Rhino 8's IronPython interpolation binding;
    # the periodic enum alone can return a valid but open curve.
    points.append(points[0])
    curve = Rhino.Geometry.Curve.CreateInterpolatedCurve(points, 3, Rhino.Geometry.CurveKnotStyle.UniformPeriodic)
    if curve is None or not curve.IsValid or not curve.IsClosed:
        raise RuntimeError("Failed to construct closed tower profile: points=%s, null=%s, valid=%s, closed=%s" % (len(points), curve is None, curve.IsValid if curve is not None else False, curve.IsClosed if curve is not None else False))
    return curve


def _loft(doc, parameters):
    curves = []
    sections = parameters.get("sections")
    if sections is not None:
        if not isinstance(sections, list) or len(sections) < 2 or len(sections) > 64:
            raise ValueError("loft requires 2-64 sections")
        low, high = float(sections[0]["z"]), float(sections[-1]["z"])
        if high <= low:
            raise ValueError("section heights must increase")
        previous = None
        for section in sections:
            z = float(section["z"])
            if previous is not None and z <= previous:
                raise ValueError("section heights must strictly increase")
            previous = z
            curves.append(_ring(section, parameters, (z - low) / (high - low)))
    else:
        ids = parameters.get("target_guids", [])
        if len(ids) < 2 or len(ids) > 64:
            raise ValueError("loft needs 2-64 ordered curves")
        for object_id in ids:
            obj = doc.Objects.FindId(System.Guid(str(object_id)))
            if obj is None or not isinstance(obj.Geometry, Rhino.Geometry.Curve):
                raise ValueError("loft targets must be curves")
            curves.append(obj.Geometry.DuplicateCurve())
    breps = Rhino.Geometry.Brep.CreateFromLoft(curves, Rhino.Geometry.Point3d.Unset, Rhino.Geometry.Point3d.Unset, Rhino.Geometry.LoftType.Normal, False)
    if breps is None or len(breps) == 0 or any(not brep.IsValid for brep in breps):
        raise RuntimeError("RhinoCommon loft did not create valid surfaces")
    if parameters.get("cap", False):
        capped = [brep.CapPlanarHoles(doc.ModelAbsoluteTolerance) for brep in breps]
        if any(brep is None or not brep.IsSolid for brep in capped):
            raise ValueError("This loft cannot be capped; use cap:false for a non-planar crown")
        breps = capped
    name = str(parameters.get("name", "Loft tower"))
    attributes = _attributes(doc, name, str(parameters.get("layer", "Loft")), (80, 114, 138), 1.0, "loft_skin")
    if sections is not None:
        attributes.SetUserString("ccagent_loft", json.dumps(parameters))
    created = []
    try:
        for brep in breps:
            object_id = doc.Objects.AddBrep(brep, attributes)
            if object_id == System.Guid.Empty:
                raise RuntimeError("Could not add loft")
            created.append(object_id)
    except Exception:
        for object_id in created:
            doc.Objects.Delete(object_id, True)
        raise
    return {"created_guids": [str(x) for x in created], "profile_count": len(curves), "source_curves_preserved": True, "loft_type": "Normal NURBS", "is_solid": all(b.IsSolid for b in breps)}


def _quad(mesh, points):
    start = mesh.Vertices.Count
    for point in points:
        mesh.Vertices.Add(point)
    mesh.Faces.AddFace(start, start + 1, start + 2, start + 3)


def _mix(a, b, t):
    return a + (b - a) * t


def _bar(mesh, a, b, width, depth, center):
    tangent = b - a
    if not tangent.Unitize():
        return
    normal = Rhino.Geometry.Vector3d((a.X + b.X) / 2.0 - center[0], (a.Y + b.Y) / 2.0 - center[1], 0)
    normal.Unitize()
    lateral = Rhino.Geometry.Vector3d.CrossProduct(tangent, normal)
    lateral.Unitize()
    side = lateral * (width / 2.0)
    front = normal * depth
    vertices = [a - side, a + side, b + side, b - side, a - side + front, a + side + front, b + side + front, b - side + front]
    start = mesh.Vertices.Count
    for point in vertices:
        mesh.Vertices.Add(point)
    for face in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]:
        mesh.Faces.AddFace(*[start + i for i in face])


def _curtain_wall(doc, parameters):
    ids = parameters.get("target_guids", [])
    if len(ids) != 1:
        raise ValueError("curtain_wall requires one tower loft")
    source = doc.Objects.FindId(System.Guid(str(ids[0])))
    if source is None or not isinstance(source.Geometry, Rhino.Geometry.Brep):
        raise ValueError("curtain_wall target must be a tower loft Brep")
    encoded = source.Attributes.GetUserString("ccagent_loft")
    if not encoded:
        raise ValueError("curtain_wall currently supports numerical-section lofts; create one with loft sections first")
    definition = json.loads(encoded)
    center = definition.get("center", [0, 0, 0])
    floors = int(_number(parameters.get("floors", 75), "floors", 1, 200))
    bays = int(_number(parameters.get("bays_per_side", 28), "bays_per_side", 4, 80)) * 4
    if floors * bays > 30000:
        raise ValueError("curtain_wall exceeds 30000 panels")
    width = _number(parameters.get("mullion_width", 0.10), "mullion_width", 0.01, 1)
    transom = _number(parameters.get("transom_width", 0.12), "transom_width", 0.01, 1)
    depth = _number(parameters.get("depth", 0.16), "depth", 0.01, 2)
    opacity = _number(parameters.get("glass_opacity", 0.72), "glass_opacity", 0.05, 1)
    spandrel = _number(parameters.get("spandrel_height", 0.45), "spandrel_height", 0, 2)
    brep = source.Geometry
    # The uncapped periodic section loft has one side face. Sampling its actual
    # NURBS surface avoids drift between the glass and the loft envelope.
    face = max(list(brep.Faces), key=lambda f: f.GetBoundingBox(True).Max.Z - f.GetBoundingBox(True).Min.Z)
    surface = face.DuplicateSurface()
    udom, vdom = surface.Domain(0), surface.Domain(1)
    origin = surface.PointAt(udom.Min, vdom.Min)
    along_u = abs(surface.PointAt(udom.Max, vdom.Min).Z - origin.Z)
    along_v = abs(surface.PointAt(udom.Min, vdom.Max).Z - origin.Z)
    # Rhino may choose U for loft height. Normalize the copy so V is vertical;
    # never assume UV orientation from the order of the input curves.
    if along_u > along_v:
        surface = surface.Transpose()
        if surface is None:
            raise RuntimeError("Could not transpose loft surface for curtain wall")
        udom, vdom = surface.Domain(0), surface.Domain(1)
    base_curve = surface.IsoCurve(0, vdom.Min)
    u_values = list(base_curve.DivideByCount(bays, True))
    if len(u_values) == bays and base_curve.IsClosed:
        u_values.append(base_curve.Domain.Max)
    if len(u_values) != bays + 1:
        raise RuntimeError("Could not divide loft perimeter: got %s parameters for %s bays, closed=%s" % (len(u_values), bays, base_curve.IsClosed))
    base_z = float(definition["sections"][0]["z"]) + center[2]
    grid = []
    for u in u_values:
        top_z = surface.PointAt(u, vdom.Max).Z
        if top_z - base_z < 0.01:
            raise ValueError("Loft surface height direction is invalid for curtain wall sampling")
        column = []
        for floor in range(floors + 1):
            ratio = floor / float(floors)
            z = base_z + (top_z - base_z) * ratio
            low, high = vdom.Min, vdom.Max
            for iteration in range(20):
                mid = (low + high) / 2.0
                if surface.PointAt(u, mid).Z < z:
                    low = mid
                else:
                    high = mid
            point = surface.PointAt(u, (low + high) / 2.0)
            outward = Rhino.Geometry.Vector3d(point.X - center[0], point.Y - center[1], 0)
            outward.Unitize()
            column.append(point + outward * 0.04)
        grid.append(column)
    meshes = {key: Rhino.Geometry.Mesh() for key in ["glass_silver", "glass_blue", "glass_light", "glass_lit", "mullions", "transoms", "spandrels", "mechanical_bands", "crown"]}
    counts = {key: 0 for key in meshes}
    for bay in range(bays):
        for floor in range(floors):
            a, b, c, d = grid[bay][floor], grid[bay + 1][floor], grid[bay + 1][floor + 1], grid[bay][floor + 1]
            # Tiny gaps and separate solid framing keep glazing legible in
            # both shaded and rendered modes without individual document panels.
            inset = 0.035
            lower_a, lower_b = _mix(a, b, inset), _mix(a, b, 1 - inset)
            upper_a, upper_b = _mix(d, c, inset), _mix(d, c, 1 - inset)
            selector = (bay * 31 + floor * 17 + (bay // 4) * (floor // 3) * 7) % 101
            key = "glass_lit" if selector < 9 and 6 < floor < floors - 4 else ["glass_silver", "glass_blue", "glass_light"][selector % 3]
            _quad(meshes[key], [_mix(lower_a, upper_a, 0.025), _mix(lower_b, upper_b, 0.025), _mix(lower_b, upper_b, 0.975), _mix(lower_a, upper_a, 0.975)])
            counts[key] += 1
            _bar(meshes["mullions"], a, d, width * (1.4 if bay % 7 == 0 else 1.0), depth, center)
            counts["mullions"] += 1
            _bar(meshes["transoms"], a, b, transom, depth * 0.65, center)
            counts["transoms"] += 1
            if spandrel > 0:
                ratio = min(0.4, spandrel / max(0.01, d.Z - a.Z))
                _quad(meshes["spandrels"], [a, b, _mix(b, c, ratio), _mix(a, d, ratio)])
                counts["spandrels"] += 1
            if floor in [int(floors * fraction) for fraction in (0.2, 0.4, 0.6, 0.8, 0.93)]:
                _quad(meshes["mechanical_bands"], [a, b, _mix(b, c, 0.60), _mix(a, d, 0.60)])
                counts["mechanical_bands"] += 1
        _bar(meshes["crown"], grid[bay][-1], grid[bay + 1][-1], transom * 2, depth, center)
        counts["crown"] += 1
    palette = {"glass_silver": (115, 154, 177), "glass_blue": (67, 110, 142), "glass_light": (158, 185, 197), "glass_lit": (232, 221, 184), "mullions": (188, 203, 212), "transoms": (145, 169, 184), "spandrels": (53, 78, 95), "mechanical_bands": (37, 52, 65), "crown": (205, 216, 220)}
    prefix = str(parameters.get("layer_prefix", "CurtainWall"))
    created = []
    components = []
    try:
        for key in sorted(meshes.keys()):
            mesh = meshes[key]
            if mesh.Faces.Count == 0:
                continue
            mesh.Normals.ComputeNormals()
            mesh.Compact()
            if not mesh.IsValid:
                raise RuntimeError("Generated invalid %s mesh" % key)
            attributes = _attributes(doc, prefix + " " + key, prefix + "_" + key, palette[key], opacity if key.startswith("glass") and key != "glass_lit" else 1.0, key)
            attributes.SetUserString("ccagent_panel_count", str(counts[key]))
            attributes.SetUserString("ccagent_source_loft", str(source.Id))
            object_id = doc.Objects.AddMesh(mesh, attributes)
            if object_id == System.Guid.Empty:
                raise RuntimeError("Could not add %s" % key)
            created.append(object_id)
            components.append({"guid": str(object_id), "component": key, "count": counts[key], "mesh_faces": mesh.Faces.Count})
    except Exception:
        for object_id in created:
            doc.Objects.Delete(object_id, True)
        raise
    return {"created_guids": [str(x) for x in created], "source_guid": str(source.Id), "panel_count": floors * bays, "floors": floors, "perimeter_bays": bays, "components": components, "representation": "grouped editable meshes; NURBS source preserved"}


def _set_view(doc, parameters):
    box = Rhino.Geometry.BoundingBox.Empty
    for object_id in parameters.get("target_guids", []):
        obj = doc.Objects.FindId(System.Guid(str(object_id)))
        if obj is None:
            raise ValueError("set_view target is missing")
        box.Union(obj.Geometry.GetBoundingBox(True))
    if not box.IsValid:
        raise ValueError("set_view needs a valid target bounding box")
    view = doc.Views.ActiveView
    if parameters.get("portrait", False):
        portrait = [candidate for candidate in doc.Views.GetViewList(True, False) if candidate.ActiveViewport.Name == "CCAGENT Reference"]
        view = portrait[0] if portrait else doc.Views.Add("CCAGENT Reference", Rhino.Display.DefinedViewportProjection.Perspective, System.Drawing.Rectangle(100, 100, 640, 800), True)
        if view is None:
            raise RuntimeError("Could not create portrait viewport")
        doc.Views.ActiveView = view
    viewport = view.ActiveViewport
    direction = Rhino.Geometry.Vector3d(*parameters["direction"])
    if not direction.Unitize():
        raise ValueError("Invalid camera direction")
    if parameters.get("projection", "parallel") == "perspective":
        viewport.ChangeToPerspectiveProjection(True, 50.0)
    else:
        viewport.ChangeToParallelProjection(True)
    viewport.SetCameraDirection(direction, True)
    viewport.CameraUp = Rhino.Geometry.Vector3d.ZAxis
    viewport.SetCameraTarget(box.Center, True)
    viewport.ZoomBoundingBox(box)
    modes = {"shaded": "Shaded", "rendered": "Rendered", "wireframe": "Wireframe", "arctic": "Arctic"}
    mode = Rhino.Display.DisplayModeDescription.FindByName(modes.get(parameters.get("display_mode", "shaded"), "Shaded"))
    if mode is not None:
        viewport.DisplayMode = mode
    viewport.ConstructionGridVisible = False
    viewport.ConstructionAxesVisible = False
    hidden = []
    hidden_layers = []
    if parameters.get("isolate", False):
        targets = set(str(value).lower() for value in parameters.get("target_guids", []))
        for obj in list(doc.Objects):
            if obj is not None and not obj.IsDeleted and not obj.IsHidden and str(obj.Id).lower() not in targets:
                if doc.Objects.Hide(obj.Id, True):
                    hidden.append(str(obj.Id))
        # Locked objects cannot be hidden with ObjectTable.Hide. Preserve their
        # lock state and hide a layer only if it contains no requested target.
        target_layers = set(doc.Objects.FindId(System.Guid(value)).Attributes.LayerIndex for value in targets)
        for layer in doc.Layers:
            if layer is None or layer.IsDeleted or not layer.IsVisible or layer.Index in target_layers or layer.Index == doc.Layers.CurrentLayerIndex:
                continue
            members = doc.Objects.FindByLayer(layer)
            if members is not None and any(obj.IsLocked for obj in members):
                layer.IsVisible = False
                layer.CommitChanges()
                hidden_layers.append(layer.Name)
    view.Redraw()
    return {"view_name": viewport.Name, "hidden_guids": hidden, "hidden_layers": hidden_layers, "camera_direction": [direction.X, direction.Y, direction.Z], "display_mode": parameters.get("display_mode", "shaded"), "target_bounds": {"min": [box.Min.X, box.Min.Y, box.Min.Z], "max": [box.Max.X, box.Max.Y, box.Max.Z]}}


def _curve_area(curve):
    properties = Rhino.Geometry.AreaMassProperties.Compute(curve)
    return None if properties is None else abs(properties.Area)


def _inward_offset(curve, plane, distance, tolerance):
    """Offset a closed planar curve inward, independent of its orientation.

    Curve.Offset's sign follows the curve direction, so both signs are attempted and
    the result with the smaller enclosed area wins. Returns None when neither sign
    yields a valid closed curve that is genuinely inside the original.
    """
    base_area = _curve_area(curve)
    best = None
    for sign in (-1.0, 1.0):
        result = curve.Offset(plane, sign * distance, tolerance, Rhino.Geometry.CurveOffsetCornerStyle.Sharp)
        for value in (result or []):
            if value is None or not value.IsValid or not value.IsClosed:
                continue
            area = _curve_area(value)
            if area is None:
                continue
            if base_area is not None and area >= base_area:
                continue
            if best is None or area < best[0]:
                best = (area, value)
    return None if best is None else best[1]


def _section_ring(brep, plane, tolerance):
    """Largest closed horizontal section of a tube at the given plane."""
    ok, curves, _points = Rhino.Geometry.Intersect.Intersection.BrepPlane(brep, plane, tolerance)
    if not ok or not curves:
        return None
    closed = [value for value in curves if value is not None and value.IsValid and value.IsClosed]
    if not closed:
        return None
    return max(closed, key=lambda value: (_curve_area(value) or 0.0))


def _floor_plates(doc, parameters):
    ids = parameters.get("target_guids", [])
    if len(ids) != 1:
        raise ValueError("floor_plates requires one tower loft")
    source = doc.Objects.FindId(System.Guid(str(ids[0])))
    if source is None or not isinstance(source.Geometry, Rhino.Geometry.Brep):
        raise ValueError("floor_plates target must be a tower loft Brep")
    encoded = source.Attributes.GetUserString("ccagent_loft")
    if not encoded:
        raise ValueError("floor_plates currently supports numerical-section lofts; create one with loft sections first")
    definition = json.loads(encoded)
    center = definition.get("center", [0, 0, 0])
    sections = definition["sections"]
    tolerance = doc.ModelAbsoluteTolerance

    floors = int(_number(parameters.get("floors", 75), "floors", 1, 200))
    thickness = _number(parameters.get("slab_thickness", 0.15), "slab_thickness", 0.01, 5)
    inset = _number(parameters.get("inset", 0.30), "inset", 0, 20)
    core_width = _number(parameters.get("core_width", 18), "core_width", 0.5, 400)
    core_depth = _number(parameters.get("core_depth", core_width), "core_depth", 0.5, 400)

    brep = source.Geometry
    base_z = float(sections[0]["z"]) + center[2]
    top_z = float(sections[-1]["z"]) + center[2]
    # A crowned loft dips below its nominal top at the bay centres, so a plane at
    # exactly top_z grazes only the four corners and sections into tiny islands that
    # cannot be offset. Keep the topmost plate just below the lowest crown-rim point.
    crown_dip = _number(definition.get("crown_dip", 0), "crown_dip", 0, 20)
    usable_top = top_z - crown_dip - 0.01
    if usable_top - base_z <= thickness:
        raise ValueError("Loft height is too small for floor plates")
    core_base = base_z
    core_height = _number(parameters.get("core_height", top_z - base_z), "core_height", 0.1, 10000)

    # Levels follow the curtain wall's even floor spacing; only levels that would rise
    # into the crown region are pulled down to the roof plate's usable height.
    spacing = (top_z - base_z) / float(floors)
    floor_levels = sorted(set(min(base_z + spacing * index, usable_top) for index in range(1, floors + 1)))
    slab_mesh = Rhino.Geometry.Mesh()
    failed_floors = []
    built = 0
    for level in floor_levels:
        plane = Rhino.Geometry.Plane(Rhino.Geometry.Point3d(center[0], center[1], level), Rhino.Geometry.Vector3d.ZAxis)
        ring = _section_ring(brep, plane, tolerance)
        if ring is None:
            failed_floors.append(round(level, 4))
            continue
        # Shrink the section's control count before offsetting: the loft section carries
        # ~100 interpolated points per turn, which makes offsetting slow and wobbly.
        simplified = ring
        if ring.SpanCount > 40:
            rebuilt = ring.Rebuild(48, 3, True)
            if rebuilt is not None and rebuilt.IsValid and rebuilt.IsClosed:
                simplified = rebuilt
        offsetted = _inward_offset(simplified, plane, inset, tolerance)
        if offsetted is None:
            failed_floors.append(round(level, 4))
            continue
        surface = Rhino.Geometry.Surface.CreateExtrusion(offsetted, Rhino.Geometry.Vector3d(0, 0, -thickness))
        if surface is None:
            failed_floors.append(round(level, 4))
            continue
        slab = surface.ToBrep()
        capped = slab.CapPlanarHoles(tolerance)
        if capped is not None:
            slab = capped
        parts = Rhino.Geometry.Mesh.CreateFromBrep(slab, Rhino.Geometry.MeshingParameters.Default)
        if not parts:
            failed_floors.append(round(level, 4))
            continue
        for part in parts:
            slab_mesh.Append(part)
        built += 1

    if built == 0:
        raise RuntimeError("floor_plates produced no slabs; every section failed")

    core_ratio = float(definition.get("corner_ratio", 0.15))
    core_parameters = {"center": [center[0], center[1], 0.0], "corner_ratio": core_ratio, "concavity": 0.0, "crown_dip": 0.0}
    core_low = _ring({"z": core_base, "width": core_width, "depth": core_depth}, core_parameters, 0.0)
    core_high = _ring({"z": core_base + core_height, "width": core_width, "depth": core_depth}, core_parameters, 1.0)
    lofted = Rhino.Geometry.Brep.CreateFromLoft([core_low, core_high], Rhino.Geometry.Point3d.Unset, Rhino.Geometry.Point3d.Unset, Rhino.Geometry.LoftType.Normal, False)
    if lofted is None or len(lofted) == 0:
        raise RuntimeError("Could not loft the core tube")
    core_brep = lofted[0].CapPlanarHoles(tolerance)
    if core_brep is None or not core_brep.IsSolid:
        raise RuntimeError("Could not cap the core tube")
    core_mesh = Rhino.Geometry.Mesh()
    for part in Rhino.Geometry.Mesh.CreateFromBrep(core_brep, Rhino.Geometry.MeshingParameters.Default):
        core_mesh.Append(part)

    prefix = str(parameters.get("layer_prefix", "Floors"))
    palette = {"floor_plates": (176, 178, 182), "core_tube": (118, 123, 130)}
    created = []
    components = []
    try:
        for key, mesh, count, label in (
            ("floor_plates", slab_mesh, built, prefix + " slabs"),
            ("core_tube", core_mesh, 1, prefix + " core"),
        ):
            if mesh.Faces.Count == 0:
                continue
            mesh.Normals.ComputeNormals()
            mesh.Compact()
            if not mesh.IsValid:
                raise RuntimeError("Generated invalid %s mesh" % key)
            attributes = _attributes(doc, label, prefix + "_" + key, palette[key], 1.0, key)
            attributes.SetUserString("ccagent_panel_count", str(count))
            attributes.SetUserString("ccagent_source_loft", str(source.Id))
            object_id = doc.Objects.AddMesh(mesh, attributes)
            if object_id == System.Guid.Empty:
                raise RuntimeError("Could not add %s" % key)
            created.append(object_id)
            components.append({"guid": str(object_id), "component": key, "count": count, "mesh_faces": mesh.Faces.Count})
    except Exception:
        for object_id in created:
            doc.Objects.Delete(object_id, True)
        raise
    return {
        "created_guids": [str(x) for x in created],
        "source_guid": str(source.Id),
        "floors": floors,
        "plate_count": built,
        "failed_floors": failed_floors,
        "slab_thickness": thickness,
        "inset": inset,
        "core_width": core_width,
        "core_depth": core_depth,
        "core_base_z": core_base,
        "core_top_z": core_base + core_height,
        "floor_z_range": [round(base_z, 4), round(top_z, 4)],
        "usable_top_z": round(usable_top, 4),
        "floor_spacing": round(spacing, 4),
        "components": components,
        "representation": "merged editable meshes; the NURBS loft source is preserved",
    }


def execute_architecture(doc, action, parameters):
    if action == "loft":
        return _loft(doc, parameters)
    if action == "floor_plates":
        return _floor_plates(doc, parameters)
    if action == "curtain_wall":
        return _curtain_wall(doc, parameters)
    if action == "set_view":
        return _set_view(doc, parameters)
    raise ValueError("Unsupported architectural action")
