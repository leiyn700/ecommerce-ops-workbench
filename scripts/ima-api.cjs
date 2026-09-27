#!/usr/bin/env node
/**
 * ima 知识库 API 助手（新媒体内容生成 skill 专用）
 *
 * 命令:
 *   node ima-api.cjs search  --query "关键词" [--kb <id>] [--limit 10]   检索知识库内容
 *   node ima-api.cjs list    [--kb <id>]                                 浏览知识库根目录
 *   node ima-api.cjs upload  --file <路径> [--file <路径2>] [--kb <id>]   上传文档入库
 *   node ima-api.cjs check                                               凭证可用性检查
 *
 * 凭证来源（按优先级）: 环境变量 IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY
 *                     -> ~/.config/ima/client_id 与 ~/.config/ima/api_key
 * 默认知识库: YzHqD5Iay0C0j8tQLkXhDsiLiiVFd_ngF_1CJaaE9yU=（新媒体运营方法论库，可用 --kb 覆盖或环境变量 IMA_KB_ID）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_KB = process.env.IMA_KB_ID || 'YzHqD5Iay0C0j8tQLkXhDsiLiiVFd_ngF_1CJaaE9yU=';
const BASE = 'https://ima.qq.com';

function parseArgs(argv) {
  const args = { _: [], file: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kb') args.kb = argv[++i];
    else if (a === '--query') args.query = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--file') args.file.push(argv[++i]);
    else args._.push(a);
  }
  return args;
}

function loadCreds() {
  let clientId = process.env.IMA_OPENAPI_CLIENTID || '';
  let apiKey = process.env.IMA_OPENAPI_APIKEY || '';
  if (!clientId || !apiKey) {
    const cfgDir = path.join(os.homedir(), '.config', 'ima');
    try { clientId = clientId || fs.readFileSync(path.join(cfgDir, 'client_id'), 'utf8').trim(); } catch {}
    try { apiKey = apiKey || fs.readFileSync(path.join(cfgDir, 'api_key'), 'utf8').trim(); } catch {}
  }
  return { clientId, apiKey };
}

async function api(creds, apiPath, body) {
  const res = await fetch(`${BASE}/${apiPath}`, {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': creds.clientId,
      'ima-openapi-apikey': creds.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  // 兼容两种响应格式: {retcode, errmsg, data} 与 {code, msg, data}
  const code = json.code ?? json.retcode;
  const msg = json.msg || json.errmsg;
  if (code !== 0) {
    const err = new Error(msg || `API 错误 code=${code}`);
    err.code = code;
    throw err;
  }
  return json.data || {};
}

const TYPE_MAP = {
  '.pdf':  { mediaType: 1,  contentType: 'application/pdf' },
  '.docx': { mediaType: 3,  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.md':   { mediaType: 7,  contentType: 'text/markdown' },
  '.txt':  { mediaType: 13, contentType: 'text/plain' },
};

// ---------- COS PUT 直传（移植自官方 cos-upload.cjs，进程内执行） ----------
const crypto = require('node:crypto');
const https = require('node:https');

function hmacSha1(key, data) { return crypto.createHmac('sha1', key).update(data).digest('hex'); }
function sha1Hex(data) { return crypto.createHash('sha1').update(data).digest('hex'); }

function cosPut(filePath, cred, contentType) {
  return new Promise((resolve, reject) => {
    const fileContent = fs.readFileSync(filePath);
    const bucket = cred.bucket_name, region = cred.region, cosKey = cred.cos_key;
    const hostname = `${bucket}.cos.${region}.myqcloud.com`;
    const pathname = `/${cosKey}`;
    const startTime = String(cred.start_time || Math.floor(Date.now() / 1000));
    const expiredTime = String(cred.expired_time || Math.floor(Date.now() / 1000) + 3600);
    const keyTime = `${startTime};${expiredTime}`;

    const signHeaders = { 'content-length': String(fileContent.length), host: hostname };
    const headerKeys = Object.keys(signHeaders).sort();
    const httpHeaders = headerKeys.map((k) => `${k}=${encodeURIComponent(signHeaders[k])}`).join('&');
    const httpString = `put\n${pathname}\n\n${httpHeaders}\n`;
    const signKey = hmacSha1(cred.secret_key, keyTime);
    const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
    const signature = hmacSha1(signKey, stringToSign);
    const authorization = [
      'q-sign-algorithm=sha1', `q-ak=${cred.secret_id}`, `q-sign-time=${keyTime}`,
      `q-key-time=${keyTime}`, `q-header-list=${headerKeys.join(';')}`, 'q-url-param-list=',
      `q-signature=${signature}`,
    ].join('&');

    const req = https.request({
      hostname, port: 443, path: pathname, method: 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': fileContent.length,
        Authorization: authorization,
        'x-cos-security-token': cred.token,
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
        else reject(new Error(`COS HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(fileContent);
    req.end();
  });
}

async function doUpload(creds, kb, files) {
  for (const file of files) {
    const abs = path.resolve(file);
    const fileName = path.basename(abs);
    const stat = fs.statSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const t = TYPE_MAP[ext];
    if (!t) { console.log(JSON.stringify({ ok: false, file: fileName, error: `不支持的类型 ${ext}` })); continue; }
    try {
      const media = await api(creds, 'openapi/wiki/v1/create_media', {
        file_name: fileName, file_size: stat.size, content_type: t.contentType, knowledge_base_id: kb, file_ext: ext.slice(1),
      });
      // 错误已由 api() 统一抛出
      const cred = media.cos_credential;
      const mediaId = media.media_id;
      // 3. COS 上传（内联执行，不开子进程——Windows 下 spawn node.exe 偶发 EBUSY）
      await cosPut(abs, cred, t.contentType);
      // 4. add_knowledge（title 必须等于 file_name）
      const added = await api(creds, 'openapi/wiki/v1/add_knowledge', {
        media_type: t.mediaType, media_id: mediaId, title: fileName, knowledge_base_id: kb,
        file_info: { cos_key: cred.cos_key, file_size: stat.size, file_name: fileName },
      });
      console.log(JSON.stringify({ ok: true, file: fileName, media_id: added.media_id }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, file: fileName, error: e.message }));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0] || 'check';
  const kb = args.kb || DEFAULT_KB;

  if (cmd === 'check') {
    const creds = loadCreds();
    if (!creds.clientId || !creds.apiKey) {
      console.log(JSON.stringify({ ok: false, reason: '缺少凭证：https://ima.qq.com/agent-interface 获取 ClientID/APIKey，写入 ~/.config/ima/ 或设置环境变量' }));
      process.exit(1);
    }
    const r = await api(creds, 'openapi/wiki/v1/get_knowledge_base', { ids: [kb] });
    const info = (r.infos || {})[kb];
    console.log(JSON.stringify({ ok: true, kb, name: info ? info.name : '(未知)' }));
    return;
  }

  const creds = loadCreds();
  if (!creds.clientId || !creds.apiKey) {
    console.log(JSON.stringify({ ok: false, reason: '缺少 IMA 凭证', fallback: '使用 references/方法论索引.md 本地兜底' }));
    process.exit(1);
  }

  if (cmd === 'search') {
    if (!args.query) { console.error('缺少 --query'); process.exit(1); }
    const r = await api(creds, 'openapi/wiki/v1/search_knowledge', { query: args.query, knowledge_base_id: kb, cursor: '' });
    const items = (r.info_list || []).slice(0, args.limit || 10).map((i) => ({
      title: i.title, media_id: i.media_id, highlight: i.highlight_content || '',
    }));
    console.log(JSON.stringify({ ok: true, query: args.query, count: items.length, items }, null, 2));
  } else if (cmd === 'list') {
    const r = await api(creds, 'openapi/wiki/v1/get_knowledge_list', { knowledge_base_id: kb, cursor: '', limit: args.limit || 50 });
    console.log(JSON.stringify({ ok: true, items: r.knowledge_list || [] }, null, 2));
  } else if (cmd === 'upload') {
    if (!args.file.length) { console.error('缺少 --file'); process.exit(1); }
    await doUpload(creds, kb, args.file);
  } else {
    console.error('未知命令，支持: search / list / upload / check');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
