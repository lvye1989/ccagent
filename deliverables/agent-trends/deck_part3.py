# -*- coding: utf-8 -*-
"""第 8-10 页：多智能体与生产化、场景矩阵、挑战与行动建议。"""
from pptx.enum.text import PP_ALIGN


def build(prs, L):
    # ============ 08 多智能体与生产化 ============
    s = L.page(prs)
    L.header(s, 'TREND 03', '从单体到编排：多智能体与生产化可靠性', 8)
    L.card(s, 0.75, 1.88, 6.25, 4.52, fill=L.CARD, line=L.LINE)
    L.rect(s, 0.75, 1.88, 6.25, 0.055, fill=L.ACCENT2)
    L.tbox(s, 1.05, 2.06, 5.7, 0.3,
           [{'text': '编排模式：一个调度者 + 若干专职执行者', 'size': 13.5, 'bold': True, 'color': L.TEXT}])
    orch = (2.32, 2.52, 3.10, 0.66)
    L.card(s, *orch, fill=L.CARD_2, line=L.ACCENT)
    L.tbox(s, orch[0], orch[1] + 0.17, orch[2], 0.36,
           [{'text': '编排者 / 规划者', 'size': 12.5, 'bold': True, 'color': L.TEXT,
             'align': PP_ALIGN.CENTER}])
    workers = [
        ('研究 / 检索', 0.98, L.ACCENT),
        ('执行 / 编码', 2.85, L.ACCENT4),
        ('审核 / 校验', 4.72, L.ACCENT3),
    ]
    for name, x, col in workers:
        wr = (x, 3.62, 1.66, 0.86)
        L.card(s, *wr, fill=L.CARD, line=col)
        L.tbox(s, x, 3.62 + 0.13, 1.66, 0.6,
               [{'text': name, 'size': 11.5, 'bold': True, 'color': L.TEXT,
                 'align': PP_ALIGN.CENTER, 'line_spacing': 1.2}])
        L.connect(s, orch, wr, color=col, width=1.25, head=True, gap=0.05)
    agg = (2.32, 4.86, 3.10, 0.66)
    L.card(s, *agg, fill=L.CARD, line=L.LINE)
    L.tbox(s, agg[0], agg[1] + 0.17, agg[2], 0.36,
           [{'text': '汇总 · 交叉验证 · 交付', 'size': 12, 'bold': True, 'color': L.TEXT,
             'align': PP_ALIGN.CENTER}])
    for name, x, col in workers:
        L.connect(s, (x, 3.62, 1.66, 0.86), agg, color=L.GRID, width=1.1, head=True, gap=0.05)
    L.arrow(s, 5.72, 4.48, 5.72, 3.28, color=L.ACCENT3, width=1.25, head=True)
    L.tbox(s, 5.86, 3.55, 1.10, 0.7,
           [{'text': '失败\n重规划', 'size': 9.5, 'bold': True, 'color': L.ACCENT3,
             'align': PP_ALIGN.CENTER, 'line_spacing': 1.15}])
    L.tbox(s, 1.05, 5.62, 5.7, 0.66, [
        {'runs': [
            {'text': '收益与代价：', 'size': 11, 'bold': True, 'color': L.ACCENT2},
            {'text': '并行带来速度与隔离，但也引入上下文同步、冲突合并与成本放大——'
                     '编排本身成为一门工程。', 'size': 11, 'color': L.MUTED}],
         'line_spacing': 1.3}])

    L.card(s, 7.15, 1.88, 5.43, 4.52, fill=L.CARD, line=L.LINE)
    L.rect(s, 7.15, 1.88, 5.43, 0.055, fill=L.ACCENT4)
    L.tbox(s, 7.45, 2.10, 4.8, 0.34,
           [{'text': '生产化四问：决定能否规模化', 'size': 15, 'bold': True, 'color': L.TEXT}])
    checks = [
        ('可靠性', '失败能否被检测、回滚与重试？断点续跑是否可用？', L.ACCENT),
        ('可观测', '每一步的工具调用、上下文与花费是否可追溯？', L.ACCENT2),
        ('可治理', '权限边界、高危操作确认、审计日志是否完备？', L.ACCENT3),
        ('可评测', '是否有任务级基准，而不是只看单轮问答的分数？', L.ACCENT4),
    ]
    y = 2.62
    for i, (t, d, col) in enumerate(checks):
        L.card(s, 7.45, y, 4.83, 0.82, fill=L.BG_DARK, line=L.LINE)
        L.rect(s, 7.45, y, 0.055, 0.82, fill=col)
        L.tbox(s, 7.72, y + 0.12, 1.35, 0.3, [{'text': t, 'size': 12.5, 'bold': True, 'color': col}])
        L.tbox(s, 9.05, y + 0.15, 3.05, 0.55,
               [{'text': d, 'size': 10.5, 'color': L.MUTED, 'line_spacing': 1.25}])
        y += 0.94
    L.tbox(s, 7.45, 5.72, 4.9, 0.62, [
        {'runs': [
            {'text': '衡量口径：', 'size': 11, 'bold': True, 'color': L.ACCENT4},
            {'text': '用"任务闭环率 × 单任务成本 × 人工介入次数"替代"回答得像不像人"。',
             'size': 11, 'color': L.TEXT}], 'line_spacing': 1.3}])
    L.notes(s, '多智能体的价值来自并行与专精，代价是同步与成本。真正拉开差距的是右侧四问：'
               '可靠性、可观测、可治理、可评测。')

    # ============ 09 场景矩阵与形态 ============
    s = L.page(prs)
    L.header(s, 'TREND 04', '落地选择：把 Agent 放在哪里最有价值', 9)
    mx, my, mw, mh = 1.28, 2.02, 6.10, 3.90
    quads = [
        (mx, my, mw / 2, mh / 2, '优先落地', '高价值 · 低难度', L.ACCENT,
         '代码工程与重构 · 数据分析与报表\n企业知识检索问答 · 文档与合同处理'),
        (mx + mw / 2, my, mw / 2, mh / 2, '重点攻坚', '高价值 · 高难度', L.ACCENT3,
         '端到端流程自动化 · 跨系统业务闭环\nGUI / 计算机操作 · 长程多步任务'),
        (mx, my + mh / 2, mw / 2, mh / 2, '标准化即可', '低价值 · 低难度', L.RGBColor.from_string('4D9AC4'),
         '格式转换 · 摘要与翻译\n会议纪要 · 结构化字段抽取'),
        (mx + mw / 2, my + mh / 2, mw / 2, mh / 2, '暂缓', '低价值 · 高难度', L.DIM,
         '开放域全自动决策\n无人值守的高风险操作'),
    ]
    for x, y, w, h, name, tag, col, ex in quads:
        L.card(s, x, y, w, h, fill=L.BG_DARK, line=L.LINE)
        L.rect(s, x, y, w, 0.05, fill=col)
        L.tbox(s, x + 0.20, y + 0.20, w - 0.40, 0.3,
               [{'text': name, 'size': 13, 'bold': True, 'color': col}])
        L.tbox(s, x + 0.20, y + 0.52, w - 0.40, 0.26,
               [{'text': tag, 'size': 9.5, 'color': L.DIM}])
        L.tbox(s, x + 0.20, y + 0.86, w - 0.40, 0.8,
               [{'text': ex, 'size': 10.5, 'color': L.MUTED, 'line_spacing': 1.32}])
    L.vline(s, mx + mw / 2, my - 0.14, mh + 0.28, L.GRID, 1.0)
    L.hline(s, mx - 0.14, my + mh / 2, mw + 0.28, L.GRID, 1.0)
    L.tbox(s, mx, my + mh + 0.18, mw, 0.3,
           [{'text': '实现难度  →', 'size': 10, 'bold': True, 'color': L.DIM,
             'align': PP_ALIGN.RIGHT}])
    L.tbox(s, 0.30, my, 0.85, 0.3,
           [{'text': '↑ 业务价值', 'size': 10, 'bold': True, 'color': L.DIM}])

    L.card(s, 7.85, 1.88, 4.73, 4.52, fill=L.CARD, line=L.LINE)
    L.rect(s, 7.85, 1.88, 4.73, 0.055, fill=L.ACCENT)
    L.tbox(s, 8.13, 2.10, 4.2, 0.34,
           [{'text': '形态之争：入口在分散，能力在收敛', 'size': 14, 'bold': True, 'color': L.TEXT}])
    forms = [
        ('终端原生 CLI', '最贴近工程动作与脚本化，适合自动化流水线', L.ACCENT4),
        ('IDE 内嵌', '上下文天然充分，编码场景落地最快', L.ACCENT),
        ('GUI / 计算机操作代理', '覆盖无 API 的存量系统，风险与成本最高', L.ACCENT3),
        ('端侧小模型', '低延迟、数据不出域，适合高频轻任务', L.ACCENT2),
    ]
    y = 2.58
    for t, d, col in forms:
        L.ellipse(s, 8.15, y + 0.10, 0.10, fill=col)
        L.tbox(s, 8.40, y, 4.0, 0.3, [{'text': t, 'size': 12, 'bold': True, 'color': L.TEXT}])
        L.tbox(s, 8.40, y + 0.30, 4.0, 0.55,
               [{'text': d, 'size': 10.5, 'color': L.MUTED, 'line_spacing': 1.25}])
        y += 0.82
    L.tbox(s, 8.13, 5.66, 4.2, 0.7, [
        {'runs': [
            {'text': '选型建议：', 'size': 11, 'bold': True, 'color': L.ACCENT},
            {'text': '先选"高价值 · 低难度"象限里可验收的场景跑通闭环，再向攻坚象限扩张。',
             'size': 11, 'color': L.TEXT}], 'line_spacing': 1.3}])
    L.notes(s, '矩阵的用法：先做右上角的四个场景之一，用闭环率证明价值；'
               '左下角的低价值场景直接采购成品即可，不必自研。')

    # ============ 10 挑战与行动 ============
    s = L.page(prs)
    L.header(s, 'RISKS & ACTIONS', '挑战与行动建议', 10)
    risks = [
        ('安全与权限', '越权操作、提示注入、数据外泄与"过度自主"的连带影响。', L.PINK),
        ('成本与延迟', '长程任务的 token 放大、失败重试与多智能体冗余带来的账单失控。', L.ACCENT3),
        ('可靠性', '幻觉与错误在多步链路上累积，结果不可复现、难以归因。', L.ACCENT2),
    ]
    for i, (t, d, col) in enumerate(risks):
        x = 0.75 + i * 4.03
        L.card(s, x, 1.90, 3.80, 1.44, fill=L.CARD, line=L.LINE)
        L.rect(s, x, 1.90, 3.80, 0.055, fill=col)
        L.tbox(s, x + 0.26, 2.12, 3.3, 0.3, [{'text': t, 'size': 14, 'bold': True, 'color': col}])
        L.tbox(s, x + 0.26, 2.52, 3.3, 0.7,
               [{'text': d, 'size': 11, 'color': L.MUTED, 'line_spacing': 1.3}])
    L.tbox(s, 0.75, 3.50, 8.0, 0.3,
           [{'text': '三步行动', 'size': 11, 'bold': True, 'color': L.ACCENT, 'spacing': 1.2}])
    steps = [
        ('选场景', '挑高频、可验收、低风险的流程先做闭环，用"人时节省"而不是"演示效果"验证价值。'),
        ('建基建', '补齐任务级评测与可观测链路，把"演示可用"变成"生产可信"。'),
        ('解耦依赖', '用协议化方式（MCP 等）接入工具与模型，保留可替换性，避免被单一供应商锁定。'),
    ]
    for i, (t, d) in enumerate(steps):
        x = 0.75 + i * 4.03
        L.card(s, x, 3.82, 3.80, 1.42, fill=L.CARD, line=L.LINE)
        L.shape(s, L.MSO_SHAPE.OVAL, x + 0.24, 4.02, 0.40, 0.40, fill=L.ACCENT)
        L.tbox(s, x + 0.24, 4.09, 0.40, 0.3,
               [{'text': str(i + 1), 'size': 13, 'bold': True, 'color': L.BG,
                 'align': PP_ALIGN.CENTER}])
        L.tbox(s, x + 0.76, 4.03, 2.8, 0.3, [{'text': t, 'size': 14, 'bold': True, 'color': L.TEXT}])
        L.tbox(s, x + 0.26, 4.54, 3.3, 0.66,
               [{'text': d, 'size': 10.5, 'color': L.MUTED, 'line_spacing': 1.3}])
    L.card(s, 0.75, 5.46, 11.83, 1.20, fill=L.CARD_2, line=L.RGBColor.from_string('2C4260'))
    L.rect(s, 0.75, 5.46, 11.83, 0.055, fill=L.ACCENT)
    L.tbox(s, 1.15, 5.72, 11.1, 0.8, [
        {'runs': [
            {'text': '结论：', 'size': 14, 'bold': True, 'color': L.ACCENT},
            {'text': '能力已经不是瓶颈，信任与成本才是。谁先把「可信赖的自主」做成可交付的工程，'
                     '谁就拿到 Agent 规模化的入场券。', 'size': 14, 'bold': True, 'color': L.TEXT}],
         'line_spacing': 1.3}])
    L.notes(s, '收尾：三大挑战（安全、成本、可靠性）与三步行动（选场景、建基建、解耦依赖）。'
               '一句话结束——能力已不是瓶颈，信任与成本才是。')
