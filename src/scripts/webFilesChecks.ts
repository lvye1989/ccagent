import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

// Small ZIP fixture builder, including CRCs, so Office extraction uses real ZIP records.
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), compressed = deflateRawSync(bytes);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 10); header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed); central.push(header, filename); offset += local.length + filename.length + compressed.length;
  }
  const table = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, table, end]);
}

export async function checkWebFiles(base: string, workspace: string, headers: Record<string, string>) {
  const directory = path.join(workspace, "中文 文件");
  await fs.mkdir(directory);
  await Promise.all([
    fs.writeFile(path.join(directory, "source.ts"), 'export const value = "代码内容";'),
    fs.writeFile(path.join(directory, "page.html"), '<script>globalThis.COMPROMISED=true</script>'),
    fs.writeFile(path.join(directory, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEMsAAAAASUVORK5CYII=", "base64")),
    fs.writeFile(path.join(directory, "paper.pdf"), "%PDF-1.4\n1 0 obj<</Type /Catalog>>endobj\n%%EOF"),
    fs.writeFile(path.join(directory, "sound.mp3"), Buffer.from([73, 68, 51, 0, 1, 2, 3, 4])),
    fs.writeFile(path.join(directory, "binary.dat"), Buffer.from([0, 255, 3, 8])),
    fs.writeFile(path.join(directory, "无扩展名"), "plain extensionless file"),
    fs.writeFile(path.join(directory, ".hidden.txt"), "hidden file"),
    fs.writeFile(path.join(directory, ".env.local"), "FIXTURE_PRIVATE_ONLY=yes"),
    fs.writeFile(path.join(directory, "report.docx"), zip({ "word/document.xml": '<w:document><w:p><w:r><w:t>Word 正文 &amp; literal &lt;img&gt;</w:t></w:r></w:p></w:document>' })),
    fs.writeFile(path.join(directory, "book.xlsx"), zip({ "xl/sharedStrings.xml": '<sst><si><t>中文单元格</t></si></sst>', "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c><c r="D1" t="inlineStr"><is><t>&lt;script&gt;</t></is></c></row></sheetData></worksheet>' })),
    fs.writeFile(path.join(directory, "slides.pptx"), zip({ "ppt/slides/slide1.xml": '<p:sld><a:p><a:r><a:t>Slide 正文</a:t></a:r></a:p></p:sld>' })),
    fs.writeFile(path.join(directory, "broken.docx"), "invalid ZIP"),
    fs.writeFile(path.join(directory, "large.txt"), "x".repeat(1024 * 1024 + 50)),
  ]);
  const fileUrl = (action: string, relative = "") => `${base}/api/files${action}?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(relative)}`;
  const get = async (action: string, relative: string) => {
    const response = await fetch(fileUrl(action, relative)); assert.equal(response.status, 200, await response.clone().text()); return await response.json();
  };
  const listing = await get("", "中文 文件");
  assert(listing.entries.some((item: { name: string }) => item.name === "source.ts"));
  assert(listing.entries.some((item: { name: string }) => item.name === "binary.dat"), "Unknown formats are browsable");
  assert(!listing.entries.some((item: { name: string }) => item.name.startsWith(".")));
  const hidden = await (await fetch(fileUrl("", "中文 文件") + "&hidden=1")).json();
  assert(hidden.entries.some((item: { name: string }) => item.name === ".hidden.txt"));
  assert(!hidden.entries.some((item: { name: string }) => item.name === ".env.local"));
  const source = await get("/preview", "中文 文件/source.ts"); assert.equal(source.format, "text"); assert.match(source.content, /代码内容/);
  const html = await get("/preview", "中文 文件/page.html"); assert.equal(html.format, "text"); assert.match(html.content, /<script>/);
  assert.equal((await fetch(fileUrl("/content", "中文 文件/page.html"))).headers.get("content-type"), "application/octet-stream", "Active HTML is served as a download");
  for (const [name, format, mime] of [["image.png", "image", "image/png"], ["paper.pdf", "pdf", "application/pdf"], ["sound.mp3", "audio", "audio/mpeg"]]) {
    assert.equal((await get("/preview", `中文 文件/${name}`)).format, format);
    const response = await fetch(fileUrl("/content", `中文 文件/${name}`)); assert.equal(response.headers.get("content-type"), mime); assert.match(response.headers.get("content-disposition")!, /^inline;/); await response.arrayBuffer();
  }
  const range = await fetch(fileUrl("/content", "中文 文件/sound.mp3"), { headers: { range: "bytes=1-3" } }); assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 1-3/8"); assert.deepEqual([...new Uint8Array(await range.arrayBuffer())], [68, 51, 0]);
  const suffix = await fetch(fileUrl("/content", "中文 文件/sound.mp3"), { headers: { range: "bytes=-2" } }); assert.equal(suffix.status, 206); assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())], [3, 4]);
  assert.equal((await fetch(fileUrl("/content", "中文 文件/sound.mp3"), { headers: { range: "bytes=100-" } })).status, 416);
  assert.equal((await get("/preview", "中文 文件/binary.dat")).format, "binary");
  assert.match((await get("/preview", "中文 文件/无扩展名")).content, /extensionless/);
  assert.match((await get("/preview", "中文 文件/report.docx")).content, /Word 正文 & literal <img>/);
  const book = await get("/preview", "中文 文件/book.xlsx"); assert.deepEqual(book.sheets[0].rows[0], ["中文单元格", "", "42", "<script>"]);
  assert.match((await get("/preview", "中文 文件/slides.pptx")).content, /幻灯片 1\nSlide 正文/);
  assert.equal((await fetch(fileUrl("/preview", "中文 文件/broken.docx"))).status, 400);
  const large = await get("/preview", "中文 文件/large.txt"); assert(large.truncated); assert.equal(large.content.length, 1024 * 1024);
  for (const bad of ["../outside.txt", path.join(workspace, "draft file.txt"), "中文 文件/.env.local", ".git/config"]) assert.equal((await fetch(fileUrl("/preview", bad))).status, 400, bad);
  assert.equal((await fetch(`${base}/api/files?workspace=old-workspace`)).status, 409);
  const outside = path.join(path.dirname(workspace), "outside-files"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "file.txt"), "outside");
  await fs.symlink(outside, path.join(directory, "external"), process.platform === "win32" ? "junction" : "dir");
  assert(!(await get("", "中文 文件")).entries.some((item: { name: string }) => item.name === "external"));
  assert.equal((await fetch(fileUrl("/preview", "中文 文件/external/file.txt"))).status, 400);
  const pages = path.join(workspace, "many-files"); await fs.mkdir(pages); await Promise.all(Array.from({ length: 252 }, (_, index) => fs.writeFile(path.join(pages, `item-${index}.txt`), "")));
  const first = await get("", "many-files"), second = await (await fetch(fileUrl("", "many-files") + `&offset=${first.nextOffset}`)).json();
  assert.equal(first.entries.length, 250); assert.equal(second.entries.length, 2); assert.equal(second.nextOffset, null);
  const filtered = await (await fetch(fileUrl("", "many-files") + "&query=item-251")).json(); assert.equal(filtered.entries.length, 1);
  const payload = { workspace, name: "中文 附件.dat", base64: Buffer.from([0, 1, 255, 48]).toString("base64") };
  assert.equal((await fetch(`${base}/api/files/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).status, 403);
  const uploaded = await fetch(`${base}/api/files/upload`, { method: "POST", headers, body: JSON.stringify(payload) }); assert.equal(uploaded.status, 201);
  const attachment = await uploaded.json(); assert.match(attachment.path, /^\.ccagent\/attachments\/[0-9a-f-]+\/中文 附件.dat$/);
  const officeUpload = await fetch(`${base}/api/files/upload`, { method: "POST", headers, body: JSON.stringify({ workspace, name: "Office 附件.docx", base64: (await fs.readFile(path.join(directory, "report.docx"))).toString("base64") }) });
  assert.equal(officeUpload.status, 201); assert.match((await officeUpload.json()).content, /Word 正文/);
  const downloaded = await fetch(fileUrl("/download", attachment.path)); assert.match(downloaded.headers.get("content-disposition")!, /^attachment;/); assert.deepEqual([...new Uint8Array(await downloaded.arrayBuffer())], [0, 1, 255, 48]);
  for (const invalid of [{ ...payload, base64: "invalid!" }, { ...payload, name: ".env" }, { ...payload, workspace: "stale" }]) {
    const response = await fetch(`${base}/api/files/upload`, { method: "POST", headers, body: JSON.stringify(invalid) }); assert([400, 409].includes(response.status));
  }
  const commands = await (await fetch(`${base}/api/composer-tools`)).json(); assert(commands.commands.some((item: { name: string }) => item.name === "init"));
  console.log("Workspace files HTTP: all file types, Office text/tables, media ranges, pagination, filtering, safe HTML, path/junction boundaries, upload/download and stale-workspace guards passed.");
}
