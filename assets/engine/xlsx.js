// 表格解析：不引第三方库。
// 小程序里用 wx.getFileSystemManager().unzip 解开 xlsx（本质是 zip），再按 XML 解析。
// 纯解析函数（parseSharedStrings / parseSheet / cellText）不依赖 wx，可在 Node 里拿真文件回归。

const WORKSHEET_MAX = 12

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)) })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)) })
    .replace(/&amp;/g, '&')
}

// 收集片段里的全部 <t>，兼容富文本 <is><r><t>a</t></r><r><t>b</t></r></is>
function textsOf(fragment) {
  const out = []
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g
  let m
  while ((m = re.exec(fragment))) out.push(decodeEntities(m[1]))
  return out.join('')
}

// xl/sharedStrings.xml → 字符串数组（下标即单元格 <v> 的值）
function parseSharedStrings(xml) {
  const out = []
  if (!xml) return out
  const re = /<si>([\s\S]*?)<\/si>/g
  let m
  while ((m = re.exec(xml))) out.push(textsOf(m[1]))
  return out
}

// 列号字母 → 0 基下标（A→0, Z→25, AA→26）
function colIndex(ref) {
  let n = 0
  const m = /^([A-Z]+)/.exec(String(ref).toUpperCase())
  if (!m) return 0
  for (let i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64)
  return n - 1
}

// 把 <v> 或 <is> 取成字符串
function cellText(attr, body, shared) {
  const t = /t="([^"]+)"/.exec(attr)
  const type = t ? t[1] : ''
  if (type === 'inlineStr') return textsOf(body)
  const v = /<v>([\s\S]*?)<\/v>/.exec(body)
  if (!v) return ''
  if (type === 's') {
    const idx = Number(v[1])
    return shared && shared[idx] != null ? shared[idx] : ''
  }
  return decodeEntities(v[1])
}

// 单个工作表 XML → 二维数组（按实际出现的最宽行补齐）
function parseSheet(xml, shared) {
  const rows = []
  if (!xml) return rows
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
  let rm
  while ((rm = rowRe.exec(xml))) {
    const body = rm[1]
    if (!body) continue
    const cells = {}
    const cRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g
    let cm
    while ((cm = cRe.exec(body))) {
      const attr = cm[1] || ''
      const inner = cm[3] || ''
      const refM = /r="([A-Z]+)\d+"/.exec(attr)
      if (!refM) continue
      const idx = colIndex(refM[1])
      const val = cellText(attr, inner, shared)
      if (val !== '') cells[idx] = val
    }
    const keys = Object.keys(cells)
    if (!keys.length) continue
    let w = 0
    keys.forEach(function (k) { const n = Number(k) + 1; if (n > w) w = n })
    const arr = new Array(w)
    for (let i = 0; i < w; i++) arr[i] = cells[i] == null ? '' : cells[i]
    rows.push(arr)
  }
  return rows
}

// xl/workbook.xml + xl/_rels/workbook.xml.rels → 工作表名与目标文件
function parseSheets(workbookXml, relsXml) {
  const out = []
  if (!workbookXml) return out
  const rel = {}
  if (relsXml) {
    const rRe = /<Relationship\b([^>]*)\/>/g
    let rm
    while ((rm = rRe.exec(relsXml))) {
      const attr = rm[1]
      const id = /Id="([^"]+)"/.exec(attr)
      const target = /Target="([^"]+)"/.exec(attr)
      if (id && target) rel[id[1]] = target[1]
    }
  }
  const sRe = /<sheet\b([^>]*)\/>/g
  let sm
  while ((sm = sRe.exec(workbookXml))) {
    const attr = sm[1]
    const name = /name="([^"]*)"/.exec(attr)
    const rid = /r:id="([^"]+)"/.exec(attr)
    const target = rid && rel[rid[1]] ? rel[rid[1]] : ''
    out.push({ name: name ? decodeEntities(name[1]) : 'Sheet', target: target })
  }
  return out
}

// ---- 以下依赖 wx 运行时 ----

function readText(fs, filePath) {
  return new Promise(function (resolve) {
    fs.readFile({
      filePath: filePath,
      encoding: 'utf8',
      success: function (r) { resolve(typeof r.data === 'string' ? r.data : '') },
      fail: function () { resolve('') }
    })
  })
}

function exists(fs, filePath) {
  try {
    fs.accessSync(filePath)
    return true
  } catch (e) {
    return false
  }
}

function mkdir(fs, dirPath) {
  return new Promise(function (resolve, reject) {
    fs.mkdir({
      dirPath: dirPath,
      recursive: true,
      success: function () { resolve() },
      fail: function (err) {
        if (err && /exist/i.test(err.errMsg || '')) resolve()
        else reject(err)
      }
    })
  })
}

function unzipTo(fs, zipFilePath, targetPath) {
  return new Promise(function (resolve, reject) {
    fs.unzip({
      zipFilePath: zipFilePath,
      targetPath: targetPath,
      success: function () { resolve() },
      fail: function (err) { reject(err) }
    })
  })
}

// 解析本地 xlsx：返回 { sheets:[{name, rows}], sheetCount }
// filePath 来自 wx.chooseMessageFile 的 tempFilePath
function parseLocalXlsx(filePath) {
  const fs = wx.getFileSystemManager()
  const dir = wx.env.USER_DATA_PATH + '/xl_' + Date.now() + '_' + Math.floor(Math.random() * 1000)
  return mkdir(fs, dir)
    .then(function () { return unzipTo(fs, filePath, dir) })
    .catch(function (err) {
      const msg = (err && err.errMsg) || (err && err.message) || ''
      if (/unzip|zip|not a/i.test(msg)) {
        throw new Error('这个文件不是 .xlsx 格式，请在小红书千帆里导出 .xlsx（不是 .xls 或 .csv）')
      }
      throw new Error('文件解压失败：' + (msg || '未知错误'))
    })
    .then(function () {
      return Promise.all([
        readText(fs, dir + '/xl/workbook.xml'),
        readText(fs, dir + '/xl/_rels/workbook.xml.rels'),
        readText(fs, dir + '/xl/sharedStrings.xml')
      ])
    })
    .then(function (parts) {
      const workbookXml = parts[0]
      const relsXml = parts[1]
      const shared = parseSharedStrings(parts[2])
      let list = parseSheets(workbookXml, relsXml)
      if (!list.length) {
        list = []
        for (let i = 1; i <= WORKSHEET_MAX; i++) {
          list.push({ name: 'Sheet' + i, target: 'worksheets/sheet' + i + '.xml' })
        }
      }
      const readTasks = list.map(function (s) {
        const rel = (s.target || '').replace(/^\/xl\//, '').replace(/^\.\.\//, '')
        const full = dir + '/xl/' + rel
        if (!exists(fs, full)) return Promise.resolve(null)
        return readText(fs, full).then(function (xml) {
          return { name: s.name, rows: parseSheet(xml, shared) }
        })
      })
      return Promise.all(readTasks)
    })
    .then(function (sheets) {
      var out = []
      for (var i = 0; i < sheets.length; i++) {
        if (sheets[i] && sheets[i].rows.length) out.push(sheets[i])
      }
      if (!out.length) throw new Error('没能在文件里读到任何数据行')
      return { sheets: out, sheetCount: out.length }
    })
}

module.exports = {
  parseLocalXlsx: parseLocalXlsx,
  // 纯函数导出，供 Node 回归测试
  parseSharedStrings: parseSharedStrings,
  parseSheet: parseSheet,
  parseSheets: parseSheets,
  colIndex: colIndex,
  decodeEntities: decodeEntities
}
