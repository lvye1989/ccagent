import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { configurePlatform, getPlatformAccountClient } from "../platform/account.js";
import { AccountError } from "../platform/accountClient.js";

const help = `CCAGENT 账户\n\n  ccagent account setup --server https://<官方服务地址>\n  ccagent account login [--email 邮箱]\n  ccagent account register [--email 邮箱]\n  ccagent account forgot [--email 邮箱]\n  ccagent account status\n  ccagent account logout\n\n登录及注册密码在交互终端中隐藏输入，不接受命令行密码参数。\n`;

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
  if (!["setup", "login", "register", "forgot", "status", "logout"].includes(command)) { output.write(help); return 1; }
  const flags: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !["--email", "--server"].includes(name) || !value || value.startsWith("--") || flags[name]) {
      output.write("账户参数无效。密码只能在交互提示中输入。\n");
      return 1;
    }
    flags[name] = value;
  }
  if ((flags["--server"] && command !== "setup") || (flags["--email"] && !["login", "register", "forgot"].includes(command))) {
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
