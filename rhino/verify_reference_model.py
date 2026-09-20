"""Read-only acceptance check for the reference tower export (requires rhino3dm).

Run: python rhino/verify_reference_model.py <project-folder>/archive/previous-output/zun-reference-300m.3dm
Does not connect to or modify a running Rhino document.
"""
import argparse
import json
from pathlib import Path

import rhino3dm


def verify(file_path):
    model = rhino3dm.File3dm.Read(str(file_path))
    assert model is not None, "Export cannot be reopened"
    assert model.Settings.ModelUnitSystem == rhino3dm.UnitSystem.Meters, "Unexpected units"
    rows = []
    for obj in model.Objects:
        attrs = obj.Attributes
        component = attrs.GetUserString("ccagent_component")
        assert obj.Geometry.IsValid, "Invalid geometry: " + str(attrs.Id)
        assert attrs.Name.startswith(("ZunRef", "Zun_Reference")), "Unrelated object exported"
        assert 0 <= attrs.LayerIndex < len(model.Layers), "Missing layer"
        assert 0 <= attrs.MaterialIndex < len(model.Materials), "Missing material"
        rows.append({"guid": str(attrs.Id), "component": component,
                     "count": int(attrs.GetUserString("ccagent_panel_count") or 0),
                     "geometry": type(obj.Geometry).__name__, "valid": True})
    assert len(rows) == 10, "Expected one loft and nine grouped meshes"
    assert sum(row["geometry"] == "Brep" for row in rows) == 1
    assert sum(row["geometry"] == "Mesh" for row in rows) == 9
    panels = sum(row["count"] for row in rows if row["component"].startswith("glass"))
    assert panels == 8400, "Expected 75 floors times 112 perimeter bays"
    expected = {"mullions": 8400, "transoms": 8400, "spandrels": 8400,
                "mechanical_bands": 560, "crown": 112}
    for component, count in expected.items():
        assert [row["count"] for row in rows if row["component"] == component] == [count]
    return {"ok": True, "path": str(file_path.resolve()), "bytes": file_path.stat().st_size,
            "units": "Meters", "object_count": len(rows), "glass_panels": panels,
            "objects": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.file), ensure_ascii=False, indent=2))
