// .csv 解析（零依赖）
// 小程序只能按 utf8 读文件，所以这里顺便做一次编码体检：一旦读到替换字符
// （\uFFFD），说明这份 csv 多半是 GBK，直接告诉使用者去导 xlsx，而不是
// 把乱码当成数据算进利润里。

function parseCsvText(text) {
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let cell = ''
  let inQuote = false

  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (inQuote) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') {
          cell += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        cell += c
      }
      continue
    }
    if (c === '"') inQuote = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (c !== '\r') {
      cell += c
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }

  // 去掉全空行
  return rows.filter(function (r) {
    for (let i = 0; i < r.length; i++) {
      if (String(r[i]).trim() !== '') return true
    }
    return false
  })
}

function looksBroken(text) {
  return String(text || '').indexOf('\uFFFD') >= 0
}

function parseLocalCsv(filePath) {
  return new Promise(function (resolve, reject) {
    let text = ''
    try {
      text = wx.getFileSystemManager().readFileSync(filePath, 'utf8')
    } catch (e) {
      reject(new Error('csv 文件读不出来：' + ((e && e.errMsg) || (e && e.message) || '未知错误')))
      return
    }
    if (typeof text !== 'string') {
      reject(new Error('csv 文件读出来不是文本，请在千帆里改导 .xlsx'))
      return
    }
    if (looksBroken(text)) {
      reject(new Error('这份 csv 是 GBK 编码，手机上解出来会乱码。请在千帆里改导 .xlsx 再传。'))
      return
    }
    const rows = parseCsvText(text)
    if (!rows.length) {
      reject(new Error('csv 里没读到数据行'))
      return
    }
    resolve({ sheets: [{ name: 'CSV', rows: rows }], sheetCount: 1 })
  })
}

module.exports = { parseLocalCsv, parseCsvText, looksBroken }
