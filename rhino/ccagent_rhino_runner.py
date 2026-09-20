# -*- coding: utf-8 -*-
"""Fixed CCAGENT -> RhinoCommon bridge.

This file runs inside Rhino via RunPythonScript. It accepts only a JSON job
created by CCAGENT and dispatches to the explicit action functions below. No
Rhino command string or Python source is accepted from the model.
"""

from __future__ import print_function

import io
import json
import math
import os
import sys
import imp
import traceback

import Rhino
import System
import scriptcontext as sc

# Only fixed, packaged modules from the trusted runner directory are imported.
_module_root = os.path.dirname(globals().get("CCAGENT_RUNNER_PATH") or globals().get("__file__", ""))
if _module_root not in sys.path:
    sys.path.insert(0, _module_root)
# Bind exact packaged paths, not cached modules from another checkout/install.
# Rhino keeps IronPython modules between calls, including across npm upgrades.
toolkit = imp.load_source("ccagent_rhino_toolkit", os.path.join(_module_root, "ccagent_rhino_toolkit.py"))
ghbridge = imp.load_source("ccagent_grasshopper", os.path.join(_module_root, "ccagent_grasshopper.py"))


ALLOWED_ACTIONS = set([
    "create_geometry",
    "transform",
    "extrude",
    "loft",
    "curtain_wall",
    "floor_plates",
    "set_view",
    "boolean",
    "set_layer",
    "set_material",
    "run_grasshopper",
    "import_export",
    "undo",
])
ALLOWED_ACTIONS.update(toolkit.ACTIONS)


def _read_json(file_path):
    with io.open(file_path, "r", encoding="utf-8-sig") as stream:
        return json.load(stream)


def _write_json(file_path, value):
    parent = os.path.dirname(file_path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    temporary = file_path + ".tmp"
    with io.open(temporary, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write(u"\n")
    if os.path.exists(file_path):
        os.remove(file_path)
    os.rename(temporary, file_path)


def _text(value):
    if value is None:
        return None
    try:
        return unicode(value)  # noqa: F821 - IronPython 2
    except NameError:
        return str(value)


def _float(value, name):
    try:
        parsed = float(value)
    except Exception:
        raise ValueError("%s must be a number" % name)
    if math.isnan(parsed) or math.isinf(parsed):
        raise ValueError("%s must be finite" % name)
    return parsed


def _point(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError("%s must be [x, y, z]" % name)
    return Rhino.Geometry.Point3d(
        _float(value[0], name + "[0]"),
        _float(value[1], name + "[1]"),
        _float(value[2], name + "[2]"),
    )


def _vector(value, name):
    point = _point(value, name)
    vector = Rhino.Geometry.Vector3d(point.X, point.Y, point.Z)
    if vector.IsTiny():
        raise ValueError("%s must be non-zero" % name)
    return vector


def _color(value, name):
    if not isinstance(value, (list, tuple)) or len(value) not in (3, 4):
        raise ValueError("%s must be [r, g, b] or [r, g, b, a]" % name)
    channels = []
    for index, item in enumerate(value):
        channel = int(item)
        if channel < 0 or channel > 255:
            raise ValueError("%s[%s] must be from 0 to 255" % (name, index))
        channels.append(channel)
    if len(channels) == 3:
        return System.Drawing.Color.FromArgb(channels[0], channels[1], channels[2])
    return System.Drawing.Color.FromArgb(channels[3], channels[0], channels[1], channels[2])


def _guid(value, name):
    try:
        return System.Guid(str(value))
    except Exception:
        raise ValueError("%s contains an invalid Rhino object GUID" % name)


def _guid_list(parameters, key, required=True):
    values = parameters.get(key)
    if values is None and not required:
        return []
    if not isinstance(values, list) or (required and len(values) == 0):
        raise ValueError("%s must be a non-empty GUID array" % key)
    return [_guid(value, key) for value in values]


def _bbox_json(box):
    if box is None or not box.IsValid:
        return None
    return {
        "min": [box.Min.X, box.Min.Y, box.Min.Z],
        "max": [box.Max.X, box.Max.Y, box.Max.Z],
    }


def _layer_name(doc, layer_index):
    try:
        layer = doc.Layers[layer_index]
        return _text(layer.FullPath or layer.Name)
    except Exception:
        return None


def _object_json(doc, rhino_object):
    geometry = rhino_object.Geometry
    attributes = rhino_object.Attributes
    box = geometry.GetBoundingBox(True) if geometry is not None else None
    result = {
        "guid": _text(rhino_object.Id),
        "type": _text(rhino_object.ObjectType),
        "name": _text(attributes.Name) if attributes is not None else None,
        "layer": _layer_name(doc, attributes.LayerIndex) if attributes is not None else None,
        "selected": bool(rhino_object.IsSelected(False) > 0),
        "locked": bool(rhino_object.IsLocked),
        "hidden": bool(rhino_object.IsHidden),
        "bounding_box": _bbox_json(box),
    }
    geometry = rhino_object.Geometry
    result["is_valid"] = bool(geometry.IsValid)
    if isinstance(geometry, Rhino.Geometry.Brep):
        result["is_solid"] = bool(geometry.IsSolid)
        result["face_count"] = int(geometry.Faces.Count)
    if isinstance(geometry, Rhino.Geometry.Mesh):
        result["mesh_faces"] = int(geometry.Faces.Count)
        result["mesh_vertices"] = int(geometry.Vertices.Count)
    for key in ("ccagent_component", "ccagent_panel_count", "ccagent_loft"):
        value = rhino_object.Attributes.GetUserString(key)
        if value:
            result[key] = value if key != "ccagent_loft" else "parametric tower sections"
    return result


def _find_object(doc, object_id, name="target_guids"):
    rhino_object = doc.Objects.FindId(object_id)
    if rhino_object is None:
        raise ValueError("%s references a missing object: %s" % (name, _text(object_id)))
    return rhino_object


def _active_objects(doc):
    settings = Rhino.DocObjects.ObjectEnumeratorSettings()
    settings.NormalObjects = True
    settings.LockedObjects = True
    settings.HiddenObjects = True
    settings.DeletedObjects = False
    settings.ReferenceObjects = True
    return list(doc.Objects.GetObjectList(settings))


def _document_json(doc):
    active_object_count = 0
    for rhino_object in _active_objects(doc):
        if rhino_object is not None and not rhino_object.IsDeleted:
            active_object_count += 1
    return {
        "name": _text(doc.Name) or "Untitled",
        "path": _text(doc.Path) or "",
        "runtime_serial": int(doc.RuntimeSerialNumber),
        "modified": bool(doc.Modified),
        "units": _text(doc.ModelUnitSystem),
        "absolute_tolerance": float(doc.ModelAbsoluteTolerance),
        "angle_tolerance_degrees": float(doc.ModelAngleToleranceDegrees),
        # ObjectTable.Count can include undo-deleted records. Report only
        # active document objects so post-Undo verification is truthful.
        "object_count": active_object_count,
        "current_layer": _text(doc.Layers.CurrentLayer.FullPath or doc.Layers.CurrentLayer.Name),
    }


def _command_json(doc):
    try:
        non_script_count = int(doc.InCommand(True))
    except Exception:
        non_script_count = 0
    command_names = []
    try:
        stack = Rhino.Commands.Command.GetCommandStack()
        if stack is not None:
            for command_id in stack:
                name = _text(Rhino.Commands.Command.LookupCommandName(command_id, True)) or "unknown"
                if name.lower() not in ("runpythonscript", "scripteditor"):
                    command_names.append(name)
    except Exception:
        pass
    try:
        prompt = _text(Rhino.RhinoApp.CommandPrompt)
    except Exception:
        prompt = ""
    return {
        "in_command": bool(non_script_count > 0),
        "active_count": non_script_count,
        "active_commands": command_names,
        "prompt": prompt or "",
        "bridge_command_ignored": True,
    }


def _undo_json(doc):
    recording_active = bool(doc.UndoRecordingIsActive)
    return {
        "recording_enabled": bool(doc.UndoRecordingEnabled),
        "recording_active": recording_active,
        "current_record_serial": int(doc.CurrentUndoRecordSerialNumber),
        "next_record_serial": int(doc.NextUndoRecordSerialNumber),
        "undo_active": bool(doc.UndoActive),
        "redo_active": bool(doc.RedoActive),
        "bridge_command_record_active": recording_active,
    }


def _observe(doc, object_limit):
    layers = []
    for layer in doc.Layers:
        if layer is None or layer.IsDeleted:
            continue
        try:
            layer_objects = doc.Objects.FindByLayer(layer)
            object_count = len(layer_objects) if layer_objects is not None else 0
        except Exception:
            object_count = None
        layers.append({
            "guid": _text(layer.Id),
            "index": int(layer.Index),
            "name": _text(layer.Name),
            "full_path": _text(layer.FullPath or layer.Name),
            "current": bool(layer.Index == doc.Layers.CurrentLayerIndex),
            "visible": bool(layer.IsVisible),
            "locked": bool(layer.IsLocked),
            "object_count": object_count,
        })

    selection = []
    selected_objects = doc.Objects.GetSelectedObjects(False, False)
    for rhino_object in selected_objects:
        selection.append(_object_json(doc, rhino_object))

    objects = []
    truncated = False
    for rhino_object in _active_objects(doc):
        if rhino_object is None or rhino_object.IsDeleted:
            continue
        if len(objects) >= object_limit:
            truncated = True
            break
        objects.append(_object_json(doc, rhino_object))

    return {
        "ok": True,
        "rhino_version": _text(Rhino.RhinoApp.Version),
        "document": _document_json(doc),
        "layers": layers,
        "selection": selection,
        "objects": objects,
        "objects_truncated": truncated,
        "command": _command_json(doc),
        "undo": _undo_json(doc),
    }


def _target_ids(parameters):
    result = []
    for key in ("target_guids", "cutter_guids", "rail_guids", "object_guids"):
        values = parameters.get(key)
        if isinstance(values, list):
            result.extend(values)
    if parameters.get("target_guid"):
        result.append(parameters.get("target_guid"))
    for entry in parameters.get("inputs", []):
        if entry.get("type") == "geometry":
            for branch in entry.get("branches", []):
                result.extend(branch.get("values", []))
    unique = []
    seen = set()
    for value in result:
        text = str(value).lower()
        if text not in seen:
            seen.add(text)
            unique.append(_guid(value, "target"))
    return unique


def _assert_observation_matches(doc, job):
    expected_document = job.get("expected_document")
    if isinstance(expected_document, dict):
        actual_document = _document_json(doc)
        for key in ("name", "path", "units"):
            if key in expected_document and expected_document.get(key) != actual_document.get(key):
                raise RuntimeError(
                    "The active Rhino document %s changed after RhinoObserve; observe again before acting" % key
                )

    expected_targets = job.get("expected_targets")
    if not isinstance(expected_targets, list):
        expected_targets = []
    for expected in expected_targets:
        if not isinstance(expected, dict) or not expected.get("guid"):
            raise RuntimeError("RhinoObserve supplied an invalid target snapshot")
        object_id = _guid(expected.get("guid"), "expected_targets")
        actual_object = _find_object(doc, object_id, "expected_targets")
        actual = _object_json(doc, actual_object)
        for key in ("type", "name", "layer", "locked", "hidden", "bounding_box"):
            if expected.get(key) != actual.get(key):
                raise RuntimeError(
                    "Rhino target %s changed (%s) after RhinoObserve; observe again before acting"
                    % (_text(object_id), key)
                )

    expected_selection = job.get("expected_selection_guids")
    if isinstance(expected_selection, list):
        selected = doc.Objects.GetSelectedObjects(False, False)
        actual_selection = sorted([_text(item.Id).lower() for item in selected])
        normalized_expected = sorted([str(item).lower() for item in expected_selection])
        if actual_selection != normalized_expected:
            raise RuntimeError("Rhino selection changed after RhinoObserve; observe again before exporting")


def _snapshot_before_action(doc, job, action, parameters):
    target_snapshots = []
    for object_id in _target_ids(parameters):
        rhino_object = doc.Objects.FindId(object_id)
        if rhino_object is not None:
            target_snapshots.append(_object_json(doc, rhino_object))
        else:
            target_snapshots.append({"guid": _text(object_id), "missing": True})
    file_path = parameters.get("file_path") or parameters.get("definition_path")
    snapshot = {
        "created_at_utc": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "observation_id": job.get("observation_id"),
        "action": action,
        "parameters": parameters,
        "document": _document_json(doc),
        "command": _command_json(doc),
        "undo": _undo_json(doc),
        "targets": target_snapshots,
        "external_file": {
            "path": file_path,
            "existed_before": bool(file_path and os.path.exists(file_path)),
        },
    }
    snapshot_path = job.get("snapshot_path")
    if action in ("set_view", "object_state", "layer_manage", "group_manage"):
        snapshot["visibility_before"] = [{"guid": _text(obj.Id), "hidden": bool(obj.IsHidden), "locked": bool(obj.IsLocked)} for obj in _active_objects(doc)]
        snapshot["layer_visibility_before"] = [{"index": layer.Index, "name": layer.Name, "visible": layer.IsVisible} for layer in doc.Layers if layer is not None and not layer.IsDeleted]
    if not snapshot_path:
        raise ValueError("snapshot_path is required before a Rhino modification")
    _write_json(snapshot_path, snapshot)
    return snapshot_path


def _create_geometry(doc, parameters):
    primitive = str(parameters.get("primitive") or "").lower()
    created = []
    if primitive == "point":
        created.append(doc.Objects.AddPoint(_point(parameters.get("point"), "point")))
    elif primitive == "line":
        created.append(doc.Objects.AddLine(
            _point(parameters.get("start"), "start"),
            _point(parameters.get("end"), "end"),
        ))
    elif primitive == "polyline":
        values = parameters.get("points")
        if not isinstance(values, list) or len(values) < 2:
            raise ValueError("points must contain at least two XYZ points")
        points = [_point(value, "points") for value in values]
        created.append(doc.Objects.AddPolyline(points))
    elif primitive == "box":
        minimum = _point(parameters.get("min"), "min")
        maximum = _point(parameters.get("max"), "max")
        box = Rhino.Geometry.BoundingBox(minimum, maximum)
        if not box.IsValid or box.Volume <= 0:
            raise ValueError("box min/max must define a positive volume")
        created.append(doc.Objects.AddBrep(box.ToBrep()))
    elif primitive == "sphere":
        center = _point(parameters.get("center"), "center")
        radius = _float(parameters.get("radius"), "radius")
        if radius <= 0:
            raise ValueError("radius must be positive")
        created.append(doc.Objects.AddSphere(Rhino.Geometry.Sphere(center, radius)))
    elif primitive == "cylinder":
        base = _point(parameters.get("base"), "base")
        axis = _vector(parameters.get("axis", [0, 0, 1]), "axis")
        height = _float(parameters.get("height"), "height")
        radius = _float(parameters.get("radius"), "radius")
        if height <= 0 or radius <= 0:
            raise ValueError("height and radius must be positive")
        axis.Unitize()
        plane = Rhino.Geometry.Plane(base, axis)
        cylinder = Rhino.Geometry.Cylinder(Rhino.Geometry.Circle(plane, radius), height)
        created.append(doc.Objects.AddBrep(cylinder.ToBrep(True, True)))
    else:
        raise ValueError("primitive must be point, line, polyline, box, sphere, or cylinder")
    if any(value == System.Guid.Empty for value in created):
        raise RuntimeError("Rhino failed to add the requested geometry")
    return {"created_guids": [_text(value) for value in created]}


def _transform(doc, parameters):
    target_ids = _guid_list(parameters, "target_guids")
    operation = str(parameters.get("operation") or "").lower()
    if operation == "translate":
        vector = _vector(parameters.get("vector"), "vector")
        transform = Rhino.Geometry.Transform.Translation(vector)
    elif operation == "rotate":
        center = _point(parameters.get("center"), "center")
        axis = _vector(parameters.get("axis", [0, 0, 1]), "axis")
        angle = math.radians(_float(parameters.get("angle_degrees"), "angle_degrees"))
        transform = Rhino.Geometry.Transform.Rotation(angle, axis, center)
    elif operation == "scale":
        center = _point(parameters.get("center"), "center")
        factors = parameters.get("factors")
        if not isinstance(factors, (list, tuple)) or len(factors) != 3:
            raise ValueError("factors must be [x, y, z]")
        transform = Rhino.Geometry.Transform.Scale(
            Rhino.Geometry.Plane(center, Rhino.Geometry.Vector3d.ZAxis),
            _float(factors[0], "factors[0]"),
            _float(factors[1], "factors[1]"),
            _float(factors[2], "factors[2]"),
        )
    else:
        raise ValueError("operation must be translate, rotate, or scale")
    copy_objects = bool(parameters.get("copy", False))
    updated = []
    deleted = []
    for object_id in target_ids:
        _find_object(doc, object_id)
        new_id = doc.Objects.Transform(object_id, transform, not copy_objects)
        if new_id == System.Guid.Empty:
            raise RuntimeError("Rhino failed to transform object %s" % _text(object_id))
        updated.append(_text(new_id))
        if not copy_objects:
            deleted.append(_text(object_id))
    return {"updated_guids": updated, "deleted_guids": deleted, "copied": copy_objects}


def _extrude(doc, parameters):
    target_ids = _guid_list(parameters, "target_guids")
    direction = _vector(parameters.get("direction"), "direction")
    cap = bool(parameters.get("cap", True))
    delete_inputs = bool(parameters.get("delete_inputs", False))
    created = []
    deleted = []
    for object_id in target_ids:
        rhino_object = _find_object(doc, object_id)
        curve = rhino_object.Geometry if isinstance(rhino_object.Geometry, Rhino.Geometry.Curve) else None
        if curve is None:
            raise ValueError("extrude target must be a curve: %s" % _text(object_id))
        surface = Rhino.Geometry.Surface.CreateExtrusion(curve, direction)
        if surface is None:
            raise RuntimeError("Rhino could not extrude curve %s" % _text(object_id))
        brep = surface.ToBrep()
        if cap:
            capped = brep.CapPlanarHoles(doc.ModelAbsoluteTolerance)
            if capped is not None:
                brep = capped
        new_id = doc.Objects.AddBrep(brep, rhino_object.Attributes.Duplicate())
        if new_id == System.Guid.Empty:
            raise RuntimeError("Rhino failed to add extruded geometry")
        created.append(_text(new_id))
        if delete_inputs and doc.Objects.Delete(object_id, True):
            deleted.append(_text(object_id))
    return {"created_guids": created, "deleted_guids": deleted}


def _as_brep(rhino_object):
    geometry = rhino_object.Geometry
    if isinstance(geometry, Rhino.Geometry.Brep):
        return geometry.DuplicateBrep()
    if isinstance(geometry, Rhino.Geometry.Extrusion):
        return geometry.ToBrep()
    converted = Rhino.Geometry.Brep.TryConvertBrep(geometry)
    return converted.DuplicateBrep() if converted is not None else None


def _boolean(doc, parameters):
    operation = str(parameters.get("operation") or "").lower()
    target_ids = _guid_list(parameters, "target_guids")
    cutter_ids = _guid_list(parameters, "cutter_guids", required=False)
    targets = []
    cutters = []
    for object_id in target_ids:
        brep = _as_brep(_find_object(doc, object_id))
        if brep is None:
            raise ValueError("boolean target is not Brep-compatible: %s" % _text(object_id))
        targets.append(brep)
    for object_id in cutter_ids:
        brep = _as_brep(_find_object(doc, object_id, "cutter_guids"))
        if brep is None:
            raise ValueError("boolean cutter is not Brep-compatible: %s" % _text(object_id))
        cutters.append(brep)
    tolerance = doc.ModelAbsoluteTolerance
    if operation == "union":
        if len(targets) < 2:
            raise ValueError("boolean union needs at least two target_guids")
        results = Rhino.Geometry.Brep.CreateBooleanUnion(targets, tolerance)
    elif operation == "difference":
        if not cutters:
            raise ValueError("boolean difference needs cutter_guids")
        results = Rhino.Geometry.Brep.CreateBooleanDifference(targets, cutters, tolerance)
    elif operation == "intersection":
        if not cutters:
            raise ValueError("boolean intersection needs cutter_guids")
        results = Rhino.Geometry.Brep.CreateBooleanIntersection(targets, cutters, tolerance)
    else:
        raise ValueError("operation must be union, difference, or intersection")
    if results is None or len(results) == 0:
        raise RuntimeError("Rhino boolean produced no result; inspect intersections and tolerances")
    created = []
    for brep in results:
        object_id = doc.Objects.AddBrep(brep)
        if object_id == System.Guid.Empty:
            raise RuntimeError("Rhino failed to add a boolean result")
        created.append(_text(object_id))
    deleted = []
    if bool(parameters.get("delete_inputs", True)):
        for object_id in target_ids + cutter_ids:
            if doc.Objects.Delete(object_id, True):
                deleted.append(_text(object_id))
    return {"created_guids": created, "deleted_guids": deleted}


def _set_layer(doc, parameters):
    target_ids = _guid_list(parameters, "target_guids")
    layer_name = str(parameters.get("layer") or "").strip()
    if not layer_name:
        raise ValueError("layer is required")
    layer_index = doc.Layers.FindByFullPath(layer_name, -1)
    if layer_index < 0:
        existing_layer = doc.Layers.FindName(layer_name)
        layer_index = existing_layer.Index if existing_layer is not None else -1
    if layer_index < 0:
        if not bool(parameters.get("create_if_missing", True)):
            raise ValueError("Rhino layer does not exist: %s" % layer_name)
        layer = Rhino.DocObjects.Layer()
        layer.Name = layer_name
        layer_index = doc.Layers.Add(layer)
    if layer_index < 0:
        raise RuntimeError("Rhino failed to create or find layer: %s" % layer_name)
    updated = []
    for object_id in target_ids:
        rhino_object = _find_object(doc, object_id)
        attributes = rhino_object.Attributes.Duplicate()
        attributes.LayerIndex = layer_index
        if not doc.Objects.ModifyAttributes(object_id, attributes, True):
            raise RuntimeError("Rhino failed to set layer for %s" % _text(object_id))
        updated.append(_text(object_id))
    return {"updated_guids": updated, "layer": layer_name}


def _set_material(doc, parameters):
    target_ids = _guid_list(parameters, "target_guids")
    material = Rhino.DocObjects.Material()
    material.Name = str(parameters.get("name") or "CCAGENT Material")[:128]
    material.DiffuseColor = _color(parameters.get("diffuse_color"), "diffuse_color")
    opacity = _float(parameters.get("opacity", 1.0), "opacity")
    if opacity < 0 or opacity > 1:
        raise ValueError("opacity must be from 0 to 1")
    material.Transparency = 1.0 - opacity
    material_index = doc.Materials.Add(material)
    if material_index < 0:
        raise RuntimeError("Rhino failed to create material")
    updated = []
    for object_id in target_ids:
        rhino_object = _find_object(doc, object_id)
        attributes = rhino_object.Attributes.Duplicate()
        attributes.MaterialIndex = material_index
        attributes.MaterialSource = Rhino.DocObjects.ObjectMaterialSource.MaterialFromObject
        if not doc.Objects.ModifyAttributes(object_id, attributes, True):
            raise RuntimeError("Rhino failed to assign material to %s" % _text(object_id))
        updated.append(_text(object_id))
    return {"updated_guids": updated, "material_index": int(material_index), "material": material.Name}


def _import_export(doc, parameters):
    operation = str(parameters.get("operation") or "").lower()
    file_path = os.path.abspath(str(parameters.get("file_path") or ""))
    if not file_path:
        raise ValueError("file_path is required")
    if operation == "import":
        if not os.path.isfile(file_path):
            raise ValueError("import file does not exist: %s" % file_path)
        before = set([_text(obj.Id) for obj in doc.Objects if obj is not None and not obj.IsDeleted])
        ok = bool(doc.Import(file_path))
        if not ok:
            raise RuntimeError("Rhino failed to import %s" % file_path)
        after = set([_text(obj.Id) for obj in doc.Objects if obj is not None and not obj.IsDeleted])
        return {"operation": operation, "file_path": file_path, "created_guids": sorted(list(after - before))}
    if operation == "export":
        overwrite = bool(parameters.get("overwrite", False))
        if os.path.exists(file_path) and not overwrite:
            raise ValueError("export destination exists and overwrite is false")
        parent = os.path.dirname(file_path)
        if parent and not os.path.isdir(parent):
            raise ValueError("export destination directory does not exist: %s" % parent)
        selected_only = bool(parameters.get("selected_only", False))
        if os.path.splitext(file_path)[1].lower() == ".3dm":
            all_objects = [obj for obj in doc.Objects if obj is not None and not obj.IsDeleted]
            requested = parameters.get("target_guids")
            full_document = not selected_only and (not requested or set(str(value).lower() for value in requested) == set(_text(obj.Id).lower() for obj in all_objects))
            if full_document:
                # A complete project is not just geometry: retain document
                # settings, group tables, layer states, materials and user data.
                # Unlike WriteFile, Write3dmFile does not change the open path.
                options = Rhino.FileIO.FileWriteOptions()
                options.UpdateDocumentPath = False
                options.WriteSelectedObjectsOnly = False
                options.SuppressDialogBoxes = True
                options.SuppressAllInput = True
                options.WriteGeometryOnly = False
                options.WriteUserData = True
                options.IncludeBitmapTable = True
                options.IncludeHistory = True
                options.IncludePreviewImage = True
                options.FileVersion = 8
                if not doc.Write3dmFile(file_path, options):
                    raise RuntimeError("Failed to write complete 3dm project")
                return {"operation": operation, "file_path": file_path, "exported_object_count": len(all_objects), "full_document": True, "overwrote": overwrite}
            # File3dm writes directly; document Export can open format dialogs
            # and block the COM call even with a fully specified destination.
            model = Rhino.FileIO.File3dm()
            model.Settings.ModelUnitSystem = doc.ModelUnitSystem
            model.Settings.ModelAbsoluteTolerance = doc.ModelAbsoluteTolerance
            model.Settings.ModelAngleToleranceRadians = doc.ModelAngleToleranceRadians
            layer_map = {}
            material_map = {}
            for layer in doc.Layers:
                if layer is not None and not layer.IsDeleted:
                    copied = Rhino.DocObjects.Layer()
                    copied.Name = layer.Name
                    copied.Color = layer.Color
                    copied.IsVisible = layer.IsVisible
                    copied.IsLocked = layer.IsLocked
                    copied.ParentLayerId = layer.ParentLayerId
                    copied.Id = layer.Id
                    layer_map[layer.Index] = model.Layers.Count
                    model.Layers.Add(copied)
            for material in doc.Materials:
                if material is not None and not material.IsDeleted:
                    copied = Rhino.DocObjects.Material(material)
                    material_map[material.Index] = model.Materials.Count
                    model.Materials.Add(copied)
            requested = parameters.get("target_guids")
            if requested:
                objects = [_find_object(doc, _guid(value, "target_guids")) for value in requested]
            elif selected_only:
                objects = list(doc.Objects.GetSelectedObjects(False, False))
            else:
                objects = [obj for obj in doc.Objects if obj is not None and not obj.IsDeleted]
            if not objects:
                raise ValueError("No objects to export")
            for obj in objects:
                attributes = obj.Attributes.Duplicate()
                attributes.LayerIndex = layer_map.get(attributes.LayerIndex, 0)
                if attributes.MaterialIndex in material_map:
                    attributes.MaterialIndex = material_map[attributes.MaterialIndex]
                if model.Objects.Add(obj.Geometry, attributes) == System.Guid.Empty:
                    raise RuntimeError("Could not add object to 3dm export")
            if not model.Write(file_path, 8):
                raise RuntimeError("Failed to write 3dm file")
            return {"operation": operation, "file_path": file_path, "exported_object_count": len(objects), "overwrote": overwrite}
        raise ValueError("Dialog-free API export requires .3dm; use separately confirmed Computer Use for other formats. No modal export was started.")
    raise ValueError("operation must be import or export")


def _execute_action(doc, job):
    action = str(job.get("action") or "")
    if action not in ALLOWED_ACTIONS:
        raise ValueError("Rhino action is not allowlisted: %s" % action)
    parameters = job.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("parameters must be an object")
    expected_serial = job.get("expected_document_runtime_serial")
    if expected_serial is not None and int(expected_serial) != int(doc.RuntimeSerialNumber):
        raise RuntimeError("The active Rhino document changed after RhinoObserve; observe again before acting")

    _assert_observation_matches(doc, job)
    if parameters.get("expected_units") and str(parameters["expected_units"]) != _text(doc.ModelUnitSystem):
        raise ValueError("Document units do not match expected_units; convert parameters before retrying")

    snapshot_path = _snapshot_before_action(doc, job, action, parameters)
    if action == "undo":
        raise RuntimeError("undo is handled by CCAGENT's fixed host-side _Undo command")

    undo_serial = 0
    owns_undo_record = False
    # Export writes an external file and is not undoable in Rhino. It is still
    # snapshotted and separately confirmed by CCAGENT, but no misleading empty
    # undo record is created.
    is_export = action == "import_export" and str(parameters.get("operation") or "").lower() == "export"
    if not is_export:
        # RunPythonScript is itself a Rhino command, so Rhino normally opens
        # one undo record before this file runs. Reuse that record instead of
        # attempting an invalid nested BeginUndoRecord. The explicit fallback
        # covers hosts that invoke the runner outside a command context.
        if bool(doc.UndoRecordingIsActive):
            undo_serial = int(doc.CurrentUndoRecordSerialNumber)
        else:
            undo_serial = int(doc.BeginUndoRecord("CCAGENT: %s" % action))
            owns_undo_record = undo_serial > 0
        if undo_serial <= 0:
            raise RuntimeError("Rhino could not start an undo record for %s" % action)
    try:
        if action in toolkit.ACTIONS:
            result = toolkit.execute_toolkit(doc, action, parameters)
        elif action == "create_geometry":
            result = _create_geometry(doc, parameters)
        elif action == "transform":
            result = _transform(doc, parameters)
        elif action == "extrude":
            result = _extrude(doc, parameters)
        elif action in ("loft", "curtain_wall", "floor_plates", "set_view"):
            architecture_path = os.path.join(os.path.dirname(globals()["CCAGENT_RUNNER_PATH"]), "ccagent_rhino_architecture.py")
            scope = {"Rhino": Rhino, "System": System, "math": math, "json": json}
            with open(architecture_path, "rb") as architecture_source:
                exec(compile(architecture_source.read(), architecture_path, "exec"), scope, scope)
            result = scope["execute_architecture"](doc, action, parameters)
        elif action == "boolean":
            result = _boolean(doc, parameters)
        elif action == "set_layer":
            result = _set_layer(doc, parameters)
        elif action == "set_material":
            result = _set_material(doc, parameters)
        elif action == "run_grasshopper":
            result = ghbridge.run_grasshopper(doc, parameters)
        elif action == "import_export":
            result = _import_export(doc, parameters)
        else:
            raise ValueError("Unsupported allowlisted action: %s" % action)
    finally:
        if owns_undo_record and undo_serial > 0:
            doc.EndUndoRecord(undo_serial)
    doc.Views.Redraw()
    output = {
        "ok": True,
        "action": action,
        "message": "RhinoCommon action completed.",
        "snapshot_path": snapshot_path,
        "undo_record_serial": undo_serial,
        "document": _document_json(doc),
    }
    output.update(result)
    return output


def _main():
    job_path = globals().get("CCAGENT_JOB_PATH")
    if not job_path:
        raise RuntimeError("CCAGENT_JOB_PATH was not supplied by the trusted wrapper")
    job = _read_json(job_path)
    result_path = job.get("result_path")
    if not result_path:
        raise ValueError("result_path is required")
    try:
        doc = sc.doc or Rhino.RhinoDoc.ActiveDoc
        if doc is None:
            raise RuntimeError("No active Rhino document is available")
        kind = str(job.get("kind") or "")
        if kind == "observe":
            limit = int(job.get("object_limit") or 200)
            result = _observe(doc, max(1, min(500, limit)))
            if job.get("capture_path"):
                view = doc.Views.ActiveView
                if view is None:
                    raise RuntimeError("No active viewport to capture")
                capture = Rhino.Display.ViewCapture()
                capture.Width = 1200
                capture.Height = 1500
                capture.ScaleScreenItems = True
                capture.DrawAxes = False
                capture.DrawGrid = False
                capture.DrawGridAxes = False
                bitmap = capture.CaptureToBitmap(view)
                if bitmap is None:
                    raise RuntimeError("Rhino native viewport capture failed")
                try:
                    bitmap.Save(job["capture_path"], System.Drawing.Imaging.ImageFormat.Png)
                finally:
                    bitmap.Dispose()
                result["capture_path"] = job["capture_path"]
        elif kind == "inspect":
            if int(job.get("expected_document_runtime_serial", -1)) != int(doc.RuntimeSerialNumber):
                raise RuntimeError("Active document changed; observe again")
            _assert_observation_matches(doc, job)
            result = toolkit.inspect_geometry(doc, job["parameters"])
        elif kind == "action":
            result = _execute_action(doc, job)
        else:
            raise ValueError("job kind must be observe or action")
        _write_json(result_path, result)
    except Exception as error:
        _write_json(result_path, {
            "ok": False,
            "error": _text(error),
            "error_type": error.__class__.__name__,
            "trace": traceback.format_exc()[-4000:],
        })


_main()
