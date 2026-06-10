#!/usr/bin/env node
/**
 * ima-upload.cjs — 上传文件到 IMA 知识库
 *
 * 用法: node ima-upload.cjs <filePath> <imaFilename>
 *
 * COS 上传通过 cos-upload.cjs 工具完成
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

// Argument parsing
const filePath = process.argv[2];
const imaFileName = process.argv[3];

if (!filePath || !imaFileName) {
  console.error('用法: node ima-upload.cjs <filePath> <imaFilename>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`❌ 文件不存在: ${filePath}`);
  process.exit(1);
}

// ── IMA API helper ──
const CID = fs.readFileSync(path.join(cfg.ima.credential_dir, 'client_id'), 'utf-8').trim();
const KEY = fs.readFileSync(path.join(cfg.ima.credential_dir, 'api_key'), 'utf-8').trim();
const KB_ID = cfg.ima.knowledge_base_id;

async function imaApi(endpoint, body) {
  const url = `https://ima.qq.com/${endpoint.replace(/^\//, '')}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': CID,
      'ima-openapi-apikey': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (json.code !== 0) {
    throw new Error(`IMA ${endpoint} failed: code=${json.code} msg=${json.msg || json.errmsg || 'N/A'}`);
  }
  return json;
}

// ── COS upload via external script ──
const COS_CJS = path.resolve(ROOT, '..', '..', 'skills', 'ima', 'knowledge-base', 'scripts', 'cos-upload.cjs');

function cosUpload(credential, filePath_) {
  // Build command with temp JSON to avoid shell quoting issues
  const params = {
    file: filePath_,
    'secret-id': credential.secret_id,
    'secret-key': credential.secret_key,
    token: credential.token,
    bucket: credential.bucket_name,
    region: credential.region,
    'cos-key': credential.cos_key,
    'content-type': 'text/markdown',
    'start-time': String(credential.start_time),
    'expired-time': String(credential.expired_time),
  };

  const args = Object.entries(params).flatMap(([k, v]) => [`--${k}`, v]);
  const cmd = `COS_CHUNK_SIZE=5242880 node "${COS_CJS}" ${args.map(a => `"${a}"`).join(' ')}`;
  execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
}

// ── Main ──
(async () => {
  const fileSize = fs.statSync(filePath).size;
  console.log(`📤  IMA 上传: ${imaFileName}`);

  // 1. Check duplicates
  try {
    await imaApi('openapi/wiki/v1/check_repeated_names', {
      params: [{ name: imaFileName, media_type: 7 }],
      knowledge_base_id: KB_ID,
    });
  } catch (e) {
    if (e.message.includes('222001')) {
      console.log('  ⚠️  文件已存在，跳过');
      return { existed: true, name: imaFileName };
    }
    throw e;
  }

  // 2. Create media
  const media = await imaApi('openapi/wiki/v1/create_media', {
    file_name: imaFileName,
    file_size: fileSize,
    content_type: 'text/markdown',
    knowledge_base_id: KB_ID,
    file_ext: 'md',
  });
  const { media_id, cos_credential } = media.data;

  // 3. COS upload
  console.log('  ☁️  COS 上传中...');
  try {
    cosUpload(cos_credential, filePath);
  } catch (e) {
    console.error(`  ❌ COS 上传失败: ${e.stderr?.substring(0, 300) || e.message}`);
    throw e;
  }

  // 4. Add to knowledge base
  await imaApi('openapi/wiki/v1/add_knowledge', {
    media_type: 7,
    media_id,
    title: imaFileName,
    knowledge_base_id: KB_ID,
    file_info: {
      cos_key: cos_credential.cos_key,
      file_size: fileSize,
      file_name: imaFileName,
    },
  });

  console.log('  ✅ 上传成功');
  return { media_id, name: imaFileName };
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});
