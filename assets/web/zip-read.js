// ZIP 读取（零依赖，浏览器与 Node 共用）
//
// xlsx 本质就是一个 zip。小程序里靠 wx.getFileSystemManager().unzip 解开，
// 浏览器没有这个 API，所以这里自己读 zip 的目录结构：
//   EOCD（文件末尾的中央目录索引）→ 中央目录条目 → 局部文件头 → 压缩数据
// 不引 JSZip 之类的库，项目保持零依赖。
//
// 注意：局部文件头里的 size 字段在「流式写入」的 zip 里会是 0（flag bit 3），
// 千帆导出的文件正是这种，所以尺寸一律以中央目录为准，不看局部头。

// deflate-raw 解压：浏览器用 DecompressionStream，Node 18+ 同样内置这个全局类
function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    return Promise.reject(new Error('当前环境不支持解压（缺 DecompressionStream）'))
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).arrayBuffer().then(function (ab) {
    return new Uint8Array(ab)
  })
}

function findEocd(dv, len) {
  // EOCD 在文件末尾，前面可能带注释（最多 65535 字节），从尾部往前找签名
  const min = Math.max(0, len - 22 - 65535)
  for (let i = len - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i
  }
  return -1
}

// 列出全部条目：{ name, method, compSize, localOff }
function listEntries(buffer) {
  const dv = new DataView(buffer)
  const eocd = findEocd(dv, buffer.byteLength)
  if (eocd < 0) throw new Error('这不是一个 zip/xlsx 文件（没找到目录结构）')

  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const out = []
  const dec = new TextDecoder('utf-8')

  for (let i = 0; i < count; i++) {
    if (off + 46 > buffer.byteLength || dv.getUint32(off, true) !== 0x02014b50) break
    const method = dv.getUint16(off + 10, true)
    const compSize = dv.getUint32(off + 20, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const cmtLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    const name = dec.decode(new Uint8Array(buffer, off + 46, nameLen))
    out.push({ name: name, method: method, compSize: compSize, localOff: localOff })
    off += 46 + nameLen + extraLen + cmtLen
  }
  return out
}

// 取某个条目的原始（仍压缩）字节
function rawBytes(buffer, entry) {
  const dv = new DataView(buffer)
  if (dv.getUint32(entry.localOff, true) !== 0x04034b50) {
    throw new Error('zip 局部头损坏：' + entry.name)
  }
  const nameLen = dv.getUint16(entry.localOff + 26, true)
  const extraLen = dv.getUint16(entry.localOff + 28, true)
  const start = entry.localOff + 30 + nameLen + extraLen
  return new Uint8Array(buffer, start, entry.compSize)
}

// 读一个条目的文本内容
async function readText(buffer, entry) {
  const raw = rawBytes(buffer, entry)
  let bytes
  if (entry.method === 0) bytes = raw
  else if (entry.method === 8) bytes = await inflateRaw(raw)
  else throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name)
  return new TextDecoder('utf-8').decode(bytes)
}

// 读一个条目的二进制内容
async function readBytes(buffer, entry) {
  const raw = rawBytes(buffer, entry)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRaw(raw)
  throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name)
}

function byName(entries, name) {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].name === name) return entries[i]
  }
  return null
}

module.exports = { listEntries, rawBytes, readText, readBytes, byName, inflateRaw }
