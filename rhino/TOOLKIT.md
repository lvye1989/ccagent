# Rhino / Grasshopper 常用工具手册

适用范围：Windows + 正在运行的 Rhino 8；使用应用内置 `rhino_agent`。无需额外安装 MCP；这是 CCAGENT 自带的结构化 RhinoCommon / Grasshopper 工具层。

## 调用原则

1. `RhinoInspect({operation:"capabilities",action:"surface"})` 获取准确参数 JSON Schema；省略 `action` 查看扩展工具目录。此操作不连接或启动 Rhino。
2. `RhinoObserve` 获取文档单位、真实对象 GUID 与 `observation_id`。
3. 如需面/边编号、曲线原生参数域，先 `RhinoInspect(operation:"topology",...)`，不能猜编号。
4. `RhinoAction({action,parameters,intent,observation_id})` 执行一组操作；随后重新观察验证。

尺寸均使用文档单位。新增几何类操作可提供 `expected_units`，单位不匹配时在修改前拒绝。所有新动作拒绝未知参数，不接受命令字符串、宏或可执行源码。

## 新增 11 类 / 67 种常用子操作

| action | operation | 说明 |
| --- | --- | --- |
| `create_curve` | circle, ellipse, arc, rectangle, polygon, interpolate, nurbs | 圆、椭圆、三点弧、矩形、多边形、插值曲线、控制点曲线 |
| `create_solid` | cone, torus | 圆锥、圆环；点、线、折线、盒体、球和圆柱继续用原有 create_geometry |
| `curve_edit` | join, explode, reverse, simplify, offset, rebuild, split, trim, fillet | 连接、炸开、反向、简化、偏移、重建、拆分、裁切、曲线圆角 |
| `surface` | planar, edge, revolve, sweep1, sweep2, pipe | 平面曲面、边界曲面、旋转、单轨/双轨扫掠、圆管；放样继续用 loft |
| `solid_edit` | cap, join, explode, offset, fillet_edges, chamfer_edges, shell, split, trim_plane | 封口、连接、拆面、偏移、实体圆角/倒角、抽壳、分割、平面裁切 |
| `mesh` | from_brep, join, explode, reduce, triangulate, quadrangulate, weld, unify_normals | 曲面转网格、合并、拆分不连通部分、减面、三角/四边面转换、焊接、统一法线 |
| `subd` | from_mesh, to_brep, subdivide | 网格转 SubD、SubD 转 Brep、细分 |
| `copy_objects` | copy, mirror, linear_array, polar_array | 复制、镜像、线性/环形阵列，保留原对象及复制对象属性 |
| `object_state` | select, deselect, hide, show, lock, unlock, delete, rename | 精确 GUID 对象管理 |
| `layer_manage` | create, rename, visibility, lock, color, delete_empty, set_current | 图层管理；只允许删除无对象、无子图层的空层 |
| `group_manage` | create, add, remove, ungroup | 组管理；解组不删除几何 |

原有 transform、extrude、loft、boolean、curtain_wall、floor_plates、set_layer、set_material、set_view、import_export、undo 保留。布尔/圆角/扫掠仍取决于输入几何质量及容差；工具可调用不代表任意复杂模型都必然成功。

`RhinoInspect` 的几何查询：

- `measure`：包围盒、曲线长度、可用的面积/体积及质心。
- `topology`：Brep 面/边编号及数量、曲线原生参数域、闭合状态、网格面/点数。
- `divide_curve`：等长分点及原生参数；不是直接创建点对象。
- `closest_point`：曲线、Brep 或网格上的最近点。
- `intersection`：两条曲线或两个 Brep 的交点/交线摘要。
- `section`：Brep 的平面截线摘要，不添加截线到文档。

这些几何查询需要新鲜 `observation_id` 和 `target_guids`。`count` 控制分段数，`max_items` 控制输出预算；必须检查 `truncated` / `topology_truncated`，必要时单独查询目标并增加预算。

### 扫掠示例

```json
{
  "action": "surface",
  "observation_id": "RhinoObserve 返回的编号",
  "intent": "沿已观察轨道创建扫掠曲面，保留轮廓与轨道",
  "parameters": {
    "operation": "sweep1",
    "target_guids": ["实际轮廓曲线 GUID"],
    "rail_guids": ["实际轨道 GUID"],
    "closed": false,
    "layer": "Sweep Result",
    "expected_units": "Meters"
  }
}
```

示例 GUID 为说明性占位符，必须替换为真实观察结果。曲线 split/trim 使用原生参数域，不是自动归一化的 0～1。阵列 `count` 包含原对象；完整 360° 环形阵列不会重叠生成最后一份。新几何操作默认保留源对象；`delete_inputs:true` 始终再次确认。实体 split 保留刀具。

## Grasshopper：检查 → 传参 → 求解 → 读取 → 可选烘焙

调用已有 `.gh` / `.ghx`，不会自动创建或改写任意 Grasshopper 脚本，也不会自动安装第三方插件。缺失组件须先安装对应插件后重试。

首先在 fresh observation 后调用：

```json
{
  "action": "run_grasshopper",
  "observation_id": "真实 observation_id",
  "intent": "检查指定定义的参数与组件，不运行求解器",
  "parameters": {"definition_path": "C:/Projects/model.gh", "operation": "inspect"}
}
```

返回组件 `component_id`、组件类型 ID、输入 `parameter_id`、输出编号、名称、连接源数量、插件程序集，以及滑块范围。随后重新观察，再使用 `operation:"solve"`：

```json
{
  "definition_path": "C:/Projects/model.gh",
  "operation": "solve",
  "inputs": [{
    "parameter_id": "检查返回的真实输入参数 GUID",
    "type": "number",
    "branches": [
      {"path": [0], "values": [2, 4]},
      {"path": [1], "values": [10]}
    ]
  }],
  "outputs": [{"component_id": "真实结果组件 GUID", "output_index": 0}],
  "max_items": 200
}
```

- 输入支持 `number`、`integer`、`boolean`、`string`、`point`、`vector`、`geometry`。点/向量值为 `[x,y,z]`；geometry 值为已观察到的 Rhino 对象 GUID，桥接复制几何后传入。
- 用 GUID 消除同名参数歧义；不拆除连接。输入有连线时，修改上游独立参数/滑块；不支持把字符串当作表达式或脚本执行。
- 滑块仅接受路径 `[0]` 上的一个 number/integer，必须在原范围内。
- 输出保留数据树分支路径。数值直接返回，几何返回类型、有效性、包围盒；附带 `errors`、`warnings`、`solution_ok` 与截断标记。
- `operation:"bake"` 重新执行该次完整输入并把指定 `outputs` 烘焙到 Rhino。指定 `layer`；必须明确选择输出，且输出为有效几何。存在运行错误、非几何输出或超出预算时拒绝烘焙，不偷偷烘焙一部分。
- 每次从磁盘载入独立 GH 文档，不覆盖原文件，不把用户当前打开的 GH 画布替换成测试文档。若用户关闭了全局求解器，solve/bake 会拒绝而非擅自开启。

### 安全与限制

第三方定义即使只做 inspect，加载时也可能执行组件代码，因此仍要求逐次确认；此桥接不是第三方代码沙箱。GH 内部组件的文件/网络副作用无法通过 Rhino Undo 恢复。请仅授权可信定义。Jev 不能取消这些确认。

防止意外高负载：每次新增几何最多 2000 个对象；阵列在执行前计算数量；网格编辑最多 200 万输入面，SubD 细分最多 3 级/20 万预估输出面；GH 文件最多 50 MiB / 5000 组件，输入最多 10000 个值，返回/烘焙最多 2000 个值。新动作参数总长最多 100 KB。

Rhino 原生复杂计算及第三方 GH 组件通常是同步的。桥接超时会废弃观察，但不能保证已中断 Rhino 内正在计算的第三方组件；不要自动重复调用，先确认 Rhino 恢复响应。当前未覆盖所有块/标注/制图命令、局部 SubD 编辑、渲染器和各第三方插件专有功能；没有开放任意 Rhino 命令逃生口。

## 开发验证

### 任务文件清理

内置 `rhino_agent` 默认在任务结束时执行受限清理：桥接临时文件在确认完成后删除；
成功任务的中间截图删除，最后一张及最终回复引用的截图保留。模型、导出配套文件、
计划、GH 定义、修改前快照和未知/旧会话文件不删除。失败、中断或无法确认 Rhino
已经停止的任务保留诊断资料。清理不涉及几何对象，也不接受模型提供的删除路径。
文件身份、内容和真实目录会在删除前复核；发生编辑、链接或目录替换时保留文件。

`CCAGENT_RHINO_AUTO_CLEANUP=0` 保留全部观察截图（已完成桥接任务的逐次清理仍执行）；
`CCAGENT_RHINO_KEEP_CAPTURES=1` 指定成功任务保留的最新截图数（1–20）。
最终回复附清理数量及项目 `reports/cleanup/` 审计文件；被删除临时文件不可恢复。

每次任务默认使用当前用户桌面 `CCAGENT-Rhino/` 下的独立项目文件夹，统一保存模型、
预览、快照与报告，禁止写入程序仓库。`RhinoObserve.project_directory` 返回实际路径。
可用 `CCAGENT_RHINO_PROJECT_DIR` 指向已有的专用项目文件夹继续工作。
API 导出目前仅允许无弹窗 `.3dm`；完整文档导出保留文档设置、组和图层可见性等信息。
非 `.3dm` 格式在执行前提示另行确认 Computer Use，不进入可能卡住的格式对话框。

```powershell
npm run test:rhino
npm run test:rhino-toolkit
npm run test:rhino-cleanup
# 可选：只读捕获当前 Rhino 视口 3 次，验证删除 2 张中间图且不改动用户模型
npm run test:rhino-cleanup-live
npm run verify:release
# 必须已有一个运行中的 Rhino；测试用独立 headless 文档，执行固定自建 GH 测试定义
npm run test:rhino-live
# 可选：使用真实模型和 Jev，运行上一步固定生成的测试定义（消耗模型额度）
node --import tsx src/scripts/test-grasshopper-agent-live.ts --execute
```

Rhino 8.26 实机检查通过 82 项，包括 Grasshopper 数据树加法求解及指定点几何烘焙；原用户文档保持不变。类型/参数/权限层另有 80 项检查。实时测试报告为桌面的 `CCAGENT-Rhino/native-tests/toolkit-live-results.json`（不进入仓库或 npm 包）。这些是有限测试样例，不是所有输入和第三方插件的可靠性保证。

另外通过真实 DeepSeek + Jev + 内置 rhino_agent 完成 capabilities → observe → inspect → observe → solve → observe，自动识别测试定义的输入/输出 GUID 并验证 2+3=5。仅授权固定自建测试定义的 inspect/solve，未烘焙或修改当前用户文档。该应用级报告保存于桌面的 `CCAGENT-Rhino/native-tests/grasshopper-agent-live.json`。

API 依据：[RhinoCommon](https://developer.rhino3d.com/api/rhinocommon/)、[Grasshopper GH_Document](https://mcneel.github.io/grasshopper-api-docs/api/grasshopper/html/Methods_T_Grasshopper_Kernel_GH_Document.htm)；实现另核对了本机 Rhino 8 SDK XML 文档，避免误用 Rhino 9 才有的方法。

自动清理实机只读验证：3 次视口截图后删除 2 张中间图和 9 个桥接临时文件，保留最终
预览与原有截图；当前 `中国尊.3dm` 的 14 个对象、图层、选择与修改状态保持不变。
