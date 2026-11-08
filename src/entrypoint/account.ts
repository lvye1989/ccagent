import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { configurePlatform, enterPlatformAccount, getPlatformAccountClient } from "../platform/account.js";
import { AccountError } from "../platform/accountClient.js";
import { officialServicesView, saveOfficialServices } from "../platform/gatewayClient.js";
import { importLegacyData, previewLegacyData, legacyCategories } from "../platform/legacyData.js";
import { pricingRateLines } from "../platform/pricingDefinition.js";

const help = `CCAGENT 账户\n\n  ccagent account setup --server https://<官方服务地址>\n  ccagent account login [--email 邮箱]\n  ccagent account register [--email 邮箱]\n  ccagent account forgot [--email 邮箱]\n  ccagent account status\n  ccagent account logout\n  ccagent account key\n  ccagent account services\n  ccagent account fallback [--enabled true|false]\n  ccagent account import-preview [--source original-data-folder]\n  ccagent account import [--source original-data-folder]\n\n登录及注册密码在交互终端中隐藏输入，不接受命令行密码参数。\n`;

interface AccountPrompter { ask(label: string): Promise<string>; secret(label: string): Promise<string>; close(): void }

function terminalPrompter(): AccountPrompter {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (muted) callback(); else process.stdout.write(chunk, encoding as BufferEncoding, callback);
  } });
  const readline = createInterface({ input: process.stdin, output, terminal });
  return {
    async ask(label) { return (await readline.question(label + ": ")).trim(); },
    async secret(label) {
      if (!terminal) throw new AccountError("请在交互终端中输入密码；密码不能通过命令行参数或日志传递。", "terminal_required");
      process.stdout.write(label + ": ");
      muted = true;
      try { return await readline.question(""); }
      finally { muted = false; process.stdout.write("\n"); }
    },
    close() { readline.close(); output.end(); },
  };
}

export async function runAccountCommand(args: string[], options: { prompter?: AccountPrompter; output?: NodeJS.WritableStream } = {}): Promise<number> {
  const output = options.output ?? process.stdout;
  const command = args[0] ?? "help";
  if (command === "help" || args.includes("--help") || args.includes("-h")) { output.write(help); return 0; }
  if (!["setup", "login", "register", "forgot", "status", "logout", "key", "services", "fallback", "import-preview", "import"].includes(command)) { output.write(help); return 1; }
  const flags: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !["--email", "--server", "--source", ...(command === 'fallback' ? ['--enabled'] : [])].includes(name) || !value || value.startsWith("--") || flags[name]) {
      output.write("账户参数无效。密码只能在交互提示中输入。\n");
      return 1;
    }
    flags[name] = value;
  }
  if ((flags["--server"] && command !== "setup") || (flags["--email"] && !["login", "register", "forgot"].includes(command)) || (flags["--source"] && !["import", "import-preview"].includes(command))) {
    output.write("此账户命令不支持提供的参数。\n"); return 1;
  }
  let prompt: AccountPrompter | undefined;
  try {
    if (command === "setup") {
      if (!flags["--server"]) throw new AccountError("请提供 --server HTTPS 服务地址。", "configuration");
      output.write(`已配置账户服务：${await configurePlatform(flags["--server"])}\n服务地址改变后，原会话不会发送至新地址，请重新登录。\n`);
      return 0;
    }
    const client = await getPlatformAccountClient();
    if (["import", "import-preview"].includes(command)) {
      await enterPlatformAccount(); const preview = await previewLegacyData(flags["--source"]);
      output.write(`原数据：${preview.source}\n当前账户目录：${preview.destination}\n`);
      for (const category of preview.categories) output.write(`${category.id}: ${category.files} 个文件，${category.bytes} 字节\n`);
      output.write("保留已有同名文件与配置；原文件保留。导入的定时任务暂停，扩展与自动执行设置需复核。\n");
      if (command === "import-preview") return 0;
      prompt = options.prompter ?? terminalPrompter();
      const categories = (await prompt.ask("导入类别（configuration,history,extensions,credentials，逗号分隔）") || "configuration,history,extensions").split(",").map(value => value.trim());
      if (categories.some(category => !legacyCategories.includes(category as typeof legacyCategories[number]))) throw new Error("导入类别无效。");
      const environmentFiles: string[] = [];
      if (categories.includes("credentials")) for (const file of preview.environmentFiles.filter(file => file.external)) if ((await prompt.ask(`同时读取来源引用的环境文件 ${file.path}？输入 yes 确认`)).toLowerCase() === "yes") environmentFiles.push(file.id);
      const enableHistory = preview.historyDisabled && categories.includes("history") && (await prompt.ask("当前关闭会话保存，是否开启 30 天保存以导入？输入 yes 确认")).toLowerCase() === "yes";
      if ((await prompt.ask("确认这些原数据属于当前登录账户？输入 yes 开始复制")).toLowerCase() !== "yes") { output.write("未开始导入，原数据保持原状。\n"); return 0; }
      const report = await importLegacyData({ id: preview.id, categories, environmentFiles, enableHistory, confirmOwned: true });
      output.write(`导入${report.state === "complete" ? "完成" : "中断"}：复制 ${report.copied} 项，新增配置 ${report.settingsAdded} 项，保留同名已有项 ${report.conflicts} 项；待补全凭据 ${report.missingCredentials} 项。\n${report.restartRequired ? "请重新打开应用以完整加载配置与授权。\n" : ""}`);
      return report.state === "complete" ? 0 : 1;
    }
    if (command === 'fallback') {
      await enterPlatformAccount();
      const enabled = flags['--enabled'];
      if (enabled !== undefined && !['true', 'false'].includes(enabled)) throw new Error('--enabled 仅接受 true 或 false。');
      if (enabled === 'false') { await saveOfficialServices({ fallbackEnabled: false }); output.write('已关闭新调用的管理员备用授权。\n'); return 0; }
      if (enabled === 'true') await saveOfficialServices({});
      const view = await officialServicesView();
      output.write(`管理员备用授权：${view.fallbackEnabled ? '已开启' : '关闭'}\n`);
      output.write('按实际成功路由的用量 × 其公开成本 × 1.3 结算，冻结取主、备用较高上限；内部失败成本由平台承担。\n');
      for (const route of view.routes.filter(route => route.limits.fallbackEnabled)) {
        const target = view.routes.find(item => item.id === route.limits.fallbackRouteId && item.service === route.service && item.protocol === route.protocol);
        output.write(`${route.id} → ${target?.id || '备用当前不可用'}\n`);
        for (const selected of target ? [route, target] : [route]) {
          output.write(`${selected.name} · 价格 v${selected.pricing.version} · ${selected.pricing.currency}${selected.pricing.currency === 'USD' ? ` · 汇率 ${selected.pricing.usdCny}` : ''}\n`);
          if (selected.pricing.definition.tariff.kind === 'qwen-input-tiers') output.write(`  按整次请求输入总量选择档位；默认${selected.pricing.definition.tariff.defaultThinking ? '开启' : '关闭'}思考；预算计入最大思考长度 ${selected.pricing.definition.tariff.maxThinkingTokens} Token。\n`);
          for (const line of pricingRateLines(selected.pricing.definition)) output.write(`  ${line}\n`);
          output.write(`  来源：${selected.pricing.sourceUrl}\n`);
        }
      }
      if (enabled === undefined) { output.write('使用 account fallback --enabled true 核对价格并开启，或 --enabled false 关闭。\n'); return 0; }
      prompt = options.prompter ?? terminalPrompter();
      if (!/^(y|yes|是)$/i.test(await prompt.ask('允许按备用服务实际用量 × 其公开成本 × 1.3 结算，并冻结主、备用较高上限？[y/N]'))) { output.write('未开启新的备用授权。\n'); return 0; }
      await saveOfficialServices({ fallbackEnabled: true, catalogRevision: view.catalogRevision }); output.write('已确认目录价格并开启新调用的管理员备用授权。\n'); return 0;
    }
    if (command === "key" || command === "services") {
      await enterPlatformAccount();
      if (command === "key") {
        prompt = options.prompter ?? terminalPrompter();
        await saveOfficialServices({ apiKey: await prompt.secret("个人 CCAGENT API Key") });
        output.write("平台 Key 已验证并安全保存。可在应用设置中选择官方辅助服务，或使用 --model ccagent:<服务编号>。\n");
      } else {
        const view = await officialServicesView();
        output.write(`账户服务：${view.origin}\n平台 Key：${view.configured ? view.keyPrefix + "… 已验证" : "尚未配置"}\n`);
        for (const route of view.routes) output.write(`${route.id} · ${route.name} · ${route.protocol} · 价格 v${route.pricing.version}\n`);
        output.write(`充值与 Key：${view.origin}/account\n调用及费用：${view.origin}/account/usage\n`);
      }
      return 0;
    }
    if (command === "status") {
      const session = await client.requireSession();
      output.write(`已登录：${session.user.email}\n账户服务：${client.origin}\n会话有效期：${session.expiresAt}\n`);
      return 0;
    }
    if (command === "logout") {
      const result = await client.signOut();
      output.write(result.remoteRevoked ? "已退出登录，服务端会话已撤销。\n" : "本机登录凭据已清除；服务端会话撤销尚未确认。\n");
      return 0;
    }
    output.write(`账户服务：${client.origin}\n`);
    prompt = options.prompter ?? terminalPrompter();
    const email = flags["--email"] ?? await prompt.ask("邮箱");
    if (command === "forgot") {
      await client.requestPasswordReset(email);
      output.write("如果该邮箱已注册，系统将发送密码重置邮件，请检查收件箱。\n");
    } else if (command === "register") {
      const name = await prompt.ask("昵称");
      const password = await prompt.secret("密码（至少 8 位）");
      if (password !== await prompt.secret("再次输入密码")) throw new AccountError("两次密码输入不一致。", "invalid_input");
      await client.signUp(email, password, name);
      output.write("注册申请已完成，请验证邮箱后使用邮箱和密码登录。\n");
    } else {
      const session = await client.signIn(email, await prompt.secret("密码"));
      output.write(`已登录：${session.user.email}\n`);
    }
    return 0;
  } catch (error) {
    output.write((error instanceof Error ? error.message : "账户操作未完成，请重试。") + "\n");
    return 1;
  } finally { prompt?.close(); }
}
