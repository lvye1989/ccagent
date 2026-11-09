'use client';
import { useState } from 'react';

export function kieImageRequestExample(routeId: string, upstreamModel: string) {
  const editing = upstreamModel.endsWith('-image-to-image');
  return `POST /v1/images/tasks\nContent-Type: application/json\n\n${JSON.stringify({ model: routeId || '<已保存的路由编号>', prompt: editing ? '按照参考图绘制建筑与城市设计分析图，保留原有空间关系' : '绘制一张建筑与城市设计分析图', ...(editing ? { input_images: ['ccagent-file:<当前账户上传文件的 UUID>'] } : {}), aspect_ratio: '16:9', resolution: '2K' }, null, 2)}\n\nGET /v1/images/tasks/<创建响应中的 id>`;
}

export function KieImageGuide({ routeId, upstreamModel }: { routeId: string; upstreamModel: string }) {
  const [copyState, setCopyState] = useState('');
  const example = kieImageRequestExample(routeId, upstreamModel);
  async function copy() {
    try { await navigator.clipboard.writeText(example); setCopyState('调用示例已复制。'); }
    catch { setCopyState('复制未完成，请选中下方示例复制。'); }
  }
  return <details className="notice neutral"><summary>GPT Image 2.5 全部参数与平台调用方法</summary>
    <p>支持 Flare、Sunburst 的文生图和参考图编辑。四个路由分别保存凭据，请在需要使用的每个路由中填写同一个 KIE API Key。</p>
    <ul>
      <li>提示词 prompt：1 至 20,000 字符；图生图使用 input_images 引用当前账户已上传文件，1 至 16 张，每张最多 30MB，支持 JPEG、PNG、WEBP。文生图不传参考图。</li>
      <li>分辨率 resolution：1K、2K、4K；比例 aspect_ratio：auto、1:1、3:2、2:3、4:3、3:4、16:9、9:16、21:9、27:16、16:27、9:8、8:9。最后四种比例仅支持 1K。</li>
      <li>背景 background：transparent、opaque、auto，仅在 1K 时传入。输出格式由上游返回；此模型没有独立的 quality、output_format、mask、seed 或批量张数参数。</li>
    </ul>
    <p>先通过平台文件接口上传参考图，再创建图像任务，并用返回的 id 查询原任务。任务完成后，images 中的 file_id 对应当前账户的结果文件。平台服务端负责 KIE 上传、任务创建和查询，调用方不接触供应商私钥。</p>
    <p>请求需账户登录状态与平台 API Key，并沿用 idempotency-key、x-ccagent-task-id、x-ccagent-price-version、x-ccagent-price-fingerprint。价格版本与指纹从最新服务目录取得；超时或停止等待后查询原任务，避免重复创建和付费。</p>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{example}</pre>
    <button type="button" className="button secondary small" onClick={() => void copy()}>复制平台调用示例</button>{copyState && <p role="status">{copyState}</p>}
    <p>停止本地等待不会取消已提交的上游生成任务。<a href="https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-text-to-image" target="_blank" rel="noopener noreferrer">官方 API 参数 ↗</a></p>
  </details>;
}
