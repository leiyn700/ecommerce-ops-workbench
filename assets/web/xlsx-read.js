// xlsx 读取（浏览器 / Node 共用）
//
// 只做「拆包 + 取文件」，XML 解析一律复用小程序里的 utils/xlsx.js，
// 保证网页版和小程序版对同一个文件的解读完全一致。
//
// 用法：
//   const { readXlsx } = require('./xlsx-read')
//   const { parseSharedStrings, parseSheet, parseSheets } = require('.../utils/xlsx')
//   const { sheets } = await readXlsx(arrayBuffer, { parseSharedStrings, parseSheet, parseSheets })

const zip = require('./zip-read')

const WORKSHEET_MAX = 12

function targetOf(target) {
  return String(target || '')
    .replace(/^\/xl\//, '')
    .replace(/^xl\//, '')
    .replace(/^\.\.\//, '')
    .replace(/^\//, '')
}

async function readXlsx(buffer, xp) {
  const entries = zip.listEntries(buffer)

  const workbookEntry = zip.byName(entries, 'xl/workbook.xml')
  if (!workbookEntry) throw new Error('文件里没有 xl/workbook.xml，不是一个可读的 .xlsx')

  const relsEntry = zip.byName(entries, 'xl/_rels/workbook.xml.rels')
  const sharedEntry = zip.byName(entries, 'xl/sharedStrings.xml')

  const workbookXml = await zip.readText(buffer, workbookEntry)
  const relsXml = relsEntry ? await zip.readText(buffer, relsEntry) : ''
  const shared = sharedEntry ? xp.parseSharedStrings(await zip.readText(buffer, sharedEntry)) : []

  let list = xp.parseSheets(workbookXml, relsXml)
  if (!list.length) {
    list = []
    for (let i = 1; i <= WORKSHEET_MAX; i++) {
      list.push({ name: 'Sheet' + i, target: 'worksheets/sheet' + i + '.xml' })
    }
  }

  const sheets = []
  for (let i = 0; i < list.length; i++) {
    const full = 'xl/' + targetOf(list[i].target)
    const e = zip.byName(entries, full)
    if (!e) continue
    const xml = await zip.readText(buffer, e)
    const rows = xp.parseSheet(xml, shared)
    if (rows.length) sheets.push({ name: list[i].name, rows: rows })
  }

  if (!sheets.length) throw new Error('没能在文件里读到任何数据行')
  return { sheets: sheets, sheetCount: sheets.length }
}

module.exports = { readXlsx }
