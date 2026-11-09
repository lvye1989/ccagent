# CAD（AutoCAD）本地 MCP 连接

插件库预置的是社区项目 [C48H74/autocad-mcp](https://github.com/C48H74/autocad-mcp)，不是 Autodesk 官方插件。连接器采用 MIT 许可；AutoCAD 软件本身仍需要用户自行安装并正常授权。本次目录接入不代表已安装桥接程序、已启动 AutoCAD 或已验收所有绘图工具。

## 选择与范围

固定版本为 [v0.3.1](https://github.com/C48H74/autocad-mcp/releases/tag/v0.3.1)，代码提交为 `2966d7f05523386b1b55582260e958ecb6f288d1`。选用理由是本地 Windows COM、明确的单线程调度与路径限制，以及独立 DXF 工具适合现有图纸的二维处理。当前托管配置启用 `core`，上游对应 37 个工具；实际数量以连接时发现为准。

本机只读检测发现简体中文 AutoCAD 2020、2025 已安装，注册了 `AutoCAD.Application.23.1`、`AutoCAD.Application.25`，没有通用 `AutoCAD.Application` 注册。连接表单默认选择 2025 的 `.25`，使用 2020 时改为 `.23.1`。安装登记不能证明软件运行健康。

[上游验证记录](https://github.com/C48H74/autocad-mcp/blob/v0.3.1/docs/validation.md)仅记录 Plant 3D 2021 的一台机器实测。2020、2025 与中文环境尚需本机验收，不能视为已认证兼容。

## 如何连接

1. 在电脑上新建专用文件夹，例如 `C:\Users\Windows11\Desktop\CAD项目交付`，放入待操作的图纸副本。连接器不会替用户创建该工作目录。
2. 在 CCAGENT 插件库打开 CAD 卡片，填写该文件夹的绝对路径，核对 AutoCAD 版本标识。
3. MCP 程序路径可留空，连接时使用下列固定来源启动；首次需要网络、Git、uv/uvx 和 Python 3.11 运行环境。uv 可以管理所需 Python。仅登记图标不会执行此命令。

```text
uvx --no-config --python 3.11 --from git+https://github.com/C48H74/autocad-mcp.git@2966d7f05523386b1b55582260e958ecb6f288d1 autocad-mcp
```

也可填写已经安装好的该项目本机 `.exe` 的绝对路径。多个项目使用 `autocad-mcp` 这个包名，因此不要将来源替换为不带仓库的同名下载命令。

4. 手动打开 AutoCAD 和工作图纸，保持与 CCAGENT 相同的 Windows 用户及权限级别，然后点击测试。只读测试调用 `status`，参数为 `{}`；只有上游返回连接、应用版本和已打开图纸的信息才代表 CAD 可读。单纯 MCP 握手成功只说明桥接服务已连接。

纯云端浏览器不能直接控制另一台电脑上的 AutoCAD；此连接使用运行 CCAGENT 后端的电脑。CAD 工具进入现有 Agent/MCP 注册表，继续按应用的工具权限执行。

## 输出文件与安全边界

根据[固定版本配置](https://github.com/C48H74/autocad-mcp/blob/v0.3.1/config.example.toml)，应用为每次连接生成账号私有 TOML，位置为当前账号的 `mcp-local/autocad/autocad-<UUID>.toml`。工作目录只允许一个经过规范化的本机现有目录，不允许磁盘、用户、桌面或应用根目录，以及账户配置目录。文件写入操作仍须用户任务授权。

配置固定 `allow_launch=false`、`enable_lisp=false`、`allow_any=false`。不会自动启动 CAD、启用任意 AutoLISP，或放开文件参数的整盘读写。上游受支持的路径环境覆盖项也被限制到同一个工作目录。卸载只移除当前账号的本连接托管 TOML，不删除图纸、CAD 软件或公共运行环境。

这不是操作系统级文件沙箱。根据[原生会话实现](https://github.com/C48H74/autocad-mcp/blob/v0.3.1/src/autocad_mcp/session.py)，COM 图元操作与保存当前 DWG 直接作用于 AutoCAD 活动文档，并不逐次套用导出路径检查。开始操作前必须核对当前图纸身份和用户授权，关闭无关图纸，不应将“导出目录受限”描述成“原生图纸全部受目录隔离”。

DXF、PDF、PNG 等文件应指定该工作目录内的路径。该社区服务的[保存工具](https://github.com/C48H74/autocad-mcp/blob/v0.3.1/src/autocad_mcp/tools/session.py)只保存已命名的当前 DWG，并非任意路径“另存为”。DWG 第一次保存或另存位置，应在 AutoCAD 内完成；不要将 PDF/DXF 导出能力描述成 DWG 任意路径另存。

当前接口以二维图元、图层、块、文字、标注和文件处理为主，不承诺完整建筑 BIM 或三维实体建模。DXF 的离线预览与 AutoCAD 原生出图有区别，应检查字体、单位、比例与图层后交付。

## 开发验证

```text
node --import tsx src/scripts/test-autocad-config.ts
```

该测试覆盖路径拒绝、中文空格目录、固定源、私有配置、环境覆盖、自有配置清理和账号隔离。不会安装或执行第三方包，不会启动、连接或修改 CAD，因此不能替代真实图纸的原生验收。
