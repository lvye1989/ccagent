"""Independently reopen a project .3dm and compare it with a live observation report."""
import argparse
import json
from pathlib import Path
import rhino3dm


def verify(model_path, report_path):
    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    expected = report.get("before", report)
    model = rhino3dm.File3dm.Read(str(model_path))
    assert model is not None, "Could not reopen exported model"
    objects = list(model.Objects)
    assert len(objects) == expected["document"]["object_count"]
    assert {str(obj.Attributes.Id).lower() for obj in objects} == {obj["guid"].lower() for obj in expected["objects"]}
    assert all(obj.Geometry.IsValid for obj in objects), "Invalid exported geometry"
    assert model.Settings.ModelUnitSystem == rhino3dm.UnitSystem.Meters
    assert abs(model.Settings.ModelAbsoluteTolerance - expected["document"]["absolute_tolerance"]) < 1e-9
    layers = {str(layer.Id).lower(): layer for layer in model.Layers}
    for layer in expected["layers"]:
        saved = layers[layer["guid"].lower()]
        assert saved.Visible == layer["visible"], "Layer visibility was lost: " + layer["name"]
        assert saved.Locked == layer["locked"], "Layer lock state was lost: " + layer["name"]
    missing_textures = []
    textures = []
    for material in model.Materials:
        for getter in ["GetBitmapTexture", "GetBumpTexture", "GetTransparencyTexture", "GetEnvironmentTexture"]:
            texture = getattr(material, getter)()
            if texture and texture.FileName:
                textures.append(texture.FileName)
                candidate = Path(texture.FileName)
                if not candidate.is_absolute(): candidate = model_path.parent / candidate
                if not candidate.is_file(): missing_textures.append(str(candidate))
    return {"ok": True, "model": str(model_path), "bytes": model_path.stat().st_size,
            "objects": len(objects), "layers": len(layers), "materials": len(model.Materials),
            "all_geometry_valid": True, "layer_states_preserved": True,
            "referenced_textures": textures, "unresolved_texture_paths": missing_textures,
            "components": [obj.Attributes.GetUserString("ccagent_component") for obj in objects]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("observation_report", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = verify(args.model, args.observation_report)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.report:
        with args.report.open("x", encoding="utf-8") as stream: stream.write(text + "\n")
    print(text)
