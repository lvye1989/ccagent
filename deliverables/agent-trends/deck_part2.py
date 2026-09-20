# -*- coding: utf-8 -*-
"""第 5-7 页：技术栈五层、上下文工程、生态协议。"""
from pptx.enum.text import PP_ALIGN


def build(prs, L):
    # ============ 05 技术栈五层 ============
    s = L.page(prs)
    L.header(s, 'ARCHITECTURE', '技术栈解剖：五层结构决定能力上限', 5)
    layers = [
        ('交互与编排层', '会话与任务编排 · 多智能体路由 · 人机确认点', L.ACCENT3,
         '体感由顶层定', '确认粒度决定"敢不敢放手"'),
        ('规划与推理层', '任务分解 · 反思与重规划 · 并行调度与依赖管理', L.ACCENT2,
         '上限由中间定', '上下文与规划决定"能走多远"'),
        ('上下文与记忆层', '上下文工程 · 长短期记忆 · 检索 / 压缩 / 分层加载', L.ACCENT,
         None, None),
        ('工具与执行层', '文件 · 终端 · 浏览器 · 企业 API，经 MCP 统一接入', L.ACCENT4,
         None, None),
        ('治理与评测层', '权限沙箱 · 审计日志 · 成本预算 · 任务级评测', L.PINK,
         '下限由底层定', '治理与工具决定"能否交付"'),
    ]
    for i, (name, desc, col, _a, _b) in enumerate(layers):
        y = 1.88 + i * 0.94
        L.card(s, 0.75, y, 8.55, 0.82, fill=L.CARD, line=L.LINE)
        L.rect(s, 0.75, y, 0.07, 0.82, fill=col)
        L.tbox(s, 1.02, y + 0.14, 2.5, 0.32,
               [{'text': name, 'size': 14.5, 'bold': True, 'color': L.TEXT}])
        L.tbox(s, 3.52, y + 0.17, 5.55, 0.5,
               [{'text': desc, 'size': 11, 'color': L.MUTED, 'line_spacing': 1.25}])
    L.card(s, 9.62, 1.88, 2.96, 4.52, fill=L.BG_DARK, line=L.LINE)
    L.tbox(s, 9.92, 2.14, 2.4, 0.62, [
        {'text': '读法', 'size': 10, 'bold': True, 'color': L.ACCENT, 'space_after': 4},
        {'text': '自下而上看', 'size': 13, 'bold': True, 'color': L.TEXT}])
    L.hline(s, 9.92, 2.80, 2.36, L.LINE, 0.75)
    for i, (t, d, col) in enumerate([
            ('下限由底层定', '治理与工具决定"能否交付"', L.ACCENT4),
            ('上限由中间定', '上下文与规划决定"能走多远"', L.ACCENT),
            ('体感由顶层定', '确认粒度决定"敢不敢放手"', L.ACCENT3)]):
        y = 3.00 + i * 1.12
        L.tbox(s, 9.92, y, 2.4, 1.0, [
            {'text': t, 'size': 12, 'bold': True, 'color': col, 'space_after': 4},
            {'text': d, 'size': 10.5, 'color': L.MUTED, 'line_spacing': 1.25}])
    L.tbox(s, 0.75, 6.06, 8.55, 0.7, [
        {'runs': [
            {'text': '关键洞察：', 'size': 12, 'bold': True, 'color': L.ACCENT},
            {'text': '投入产出比最高、却最常被低估的是「上下文与记忆层」和「治理与评测层」。',
             'size': 12, 'color': L.TEXT}]}])
    L.notes(s, '五层栈自上而下依次是体验层、决策层、上限层、触手层、底线层。'
               '选型时优先补齐上下文与治理两层，它们决定了能走多远和敢不敢上生产。')

    # ============ 06 趋势一：上下文工程 ============
    s = L.page(prs)
    L.header(s, 'TREND 01', '上下文工程：真正的能力天花板', 6)
    L.card(s, 0.75, 1.88, 5.86, 4.52, fill=L.CARD, line=L.LINE)
    L.rect(s, 0.75, 1.88, 5.86, 0.055, fill=L.ACCENT)
    L.tbox(s, 1.05, 2.10, 5.3, 0.4,
           [{'text': '为什么提示词工程不够用了', 'size': 15, 'bold': True, 'color': L.TEXT}])
    bullets = [
        ('胜负手转移', '模型每一步"能看到什么"，比你怎么措辞更重要——同一模型换上下文策略，'
                  '任务成功率可以差出量级。'),
        ('长上下文 ≠ 有效上下文', '窗口再大也要管预算：噪声会稀释注意力，关键信息的位置与密度'
                          '比总量更关键。'),
        ('四大构件', '系统指令 · 工具定义 · 检索证据 · 记忆与历史压缩，四者共同构成"工作现场"。'),
        ('可观测是前提', '上下文快照、加载来源与命中率必须可追溯，否则问题无法定位、'
                    '效果无法归因。'),
    ]
    y = 2.66
    for t, d in bullets:
        L.ellipse(s, 1.06, y + 0.09, 0.11, fill=L.ACCENT)
        L.tbox(s, 1.32, y, 5.05, 0.28, [{'text': t, 'size': 12.5, 'bold': True, 'color': L.ACCENT}])
        L.tbox(s, 1.32, y + 0.31, 5.05, 0.68,
               [{'text': d, 'size': 11, 'color': L.MUTED, 'line_spacing': 1.3}])
        y += 0.92

    L.card(s, 6.98, 1.88, 5.60, 4.52, fill=L.CARD, line=L.LINE)
    L.rect(s, 6.98, 1.88, 5.60, 0.055, fill=L.ACCENT2)
    L.tbox(s, 7.28, 2.10, 5.0, 0.4,
           [{'text': '一次模型调用的上下文构成（示意）', 'size': 15, 'bold': True, 'color': L.TEXT}])
    segs = [
        ('系统指令与工具定义', 34, L.ACCENT2),
        ('检索证据', 26, L.ACCENT),
        ('记忆与历史压缩', 24, L.ACCENT4),
        ('对话与中间结果', 16, L.ACCENT3),
    ]
    bx, by, bw, bh = 7.28, 2.74, 5.00, 0.88
    cur = bx
    for _n, pct, col in segs:
        w = bw * pct / 100.0
        L.rect(s, cur, by, w, bh, fill=col)
        cur += w
    L.tbox(s, bx, by + bh + 0.08, 5.0, 0.3,
           [{'text': '"预算分配"比"塞满窗口"更重要：每一段都应回答"此刻真的需要它吗"。',
             'size': 10, 'color': L.DIM}])
    for i, (name, pct, col) in enumerate(segs):
        y = 4.16 + i * 0.50
        L.rect(s, 7.28, y + 0.05, 0.16, 0.16, fill=col)
        L.tbox(s, 7.56, y, 3.0, 0.28, [{'text': name, 'size': 11.5, 'color': L.TEXT}])
        L.tbox(s, 10.56, y, 1.72, 0.28,
               [{'text': str(pct) + '%', 'size': 11.5, 'bold': True, 'color': col,
                 'align': PP_ALIGN.RIGHT}])
    L.tbox(s, 7.28, 5.62, 5.0, 0.7, [
        {'text': '关键动作：把上下文当作产品来做——分层、按需加载、可度量。',
         'size': 11.5, 'bold': True, 'color': L.ACCENT2, 'line_spacing': 1.3}])
    L.notes(s, '本节要点：把上下文当作产品，而不是字符串拼接。占比为示意，用于说明'
               '"注意力预算"应当被显式分配，而不是让窗口自然填满。')

    # ============ 07 趋势二：生态与协议 ============
    s = L.page(prs)
    L.header(s, 'TREND 02', '生态收敛：把「接工具」变成标准插拔', 7)
    hub = (2.62, 2.96, 2.60, 1.16)
    L.card(s, *hub, fill=L.CARD_2, line=L.ACCENT)
    L.tbox(s, hub[0], hub[1] + 0.24, hub[2], 0.72, [
        {'text': 'Agent 运行时', 'size': 15, 'bold': True, 'color': L.TEXT,
         'align': PP_ALIGN.CENTER, 'space_after': 3},
        {'text': '规划 · 记忆 · 调度', 'size': 10, 'color': L.MUTED, 'align': PP_ALIGN.CENTER}])
    spokes = [
        ('文件与终端', 2.86, 1.98, 2.12, 0.54, L.ACCENT4),
        ('MCP 工具服务器', 0.85, 2.62, 2.12, 0.54, L.ACCENT),
        ('浏览器 / GUI 操作', 4.87, 2.62, 2.12, 0.54, L.ACCENT2),
        ('企业系统 API', 0.85, 4.72, 2.12, 0.54, L.ACCENT3),
        ('其他 Agent（A2A）', 4.87, 4.72, 2.12, 0.54, L.ACCENT),
        ('数据与向量库', 2.86, 5.34, 2.12, 0.54, L.ACCENT4),
    ]
    for name, x, y, w, h, col in spokes:
        L.card(s, x, y, w, h, fill=L.CARD, line=L.LINE)
        L.tbox(s, x + 0.10, y + 0.13, w - 0.20, 0.3,
               [{'text': name, 'size': 11, 'bold': True, 'color': L.TEXT,
                 'align': PP_ALIGN.CENTER}])
        L.connect(s, hub, (x, y, w, h), color=col, width=1.25, head=True, gap=0.05)

    L.card(s, 7.10, 1.88, 5.48, 4.52, fill=L.CARD, line=L.LINE)
    L.rect(s, 7.10, 1.88, 5.48, 0.055, fill=L.ACCENT)
    rows = [
        ('MCP：工具接入的标准插座', '把"每家模型各自的插件格式"统一为可复用的工具服务器；'
                            '接入成本从定制开发降为配置，工具生态得以商品化。', L.ACCENT),
        ('A2A 类协议：智能体之间互操作', '解决任务委托、能力发现与身份认证，'
                              '让不同厂商的 Agent 能在同一流程里协作。', L.ACCENT2),
        ('生态后果：差异化重新定位', '当"接工具"不再是壁垒，竞争力回到领域知识、'
                           '流程理解与可靠性工程。', L.ACCENT3),
    ]
    y = 2.12
    for t, d, col in rows:
        L.rect(s, 7.40, y + 0.06, 0.055, 0.94, fill=col)
        L.tbox(s, 7.66, y, 4.7, 0.32, [{'text': t, 'size': 13.5, 'bold': True, 'color': L.TEXT}])
        L.tbox(s, 7.66, y + 0.38, 4.7, 0.78,
               [{'text': d, 'size': 11, 'color': L.MUTED, 'line_spacing': 1.32}])
        y += 1.40
    L.tbox(s, 7.40, 5.72, 4.9, 0.62, [
        {'runs': [
            {'text': '判断：', 'size': 11.5, 'bold': True, 'color': L.ACCENT},
            {'text': '2026 年选型的第一原则是"协议优先"——凡是只能用私有插件方式接入的能力，'
                     '都会成为锁定风险。', 'size': 11.5, 'color': L.TEXT}],
         'line_spacing': 1.3}])
    L.notes(s, '生态收敛的两条主线：MCP 统一工具接入，A2A 类协议统一智能体互操作。'
               '对企业的直接含义是——用协议化接入解耦模型与工具，避免供应商锁定。')
