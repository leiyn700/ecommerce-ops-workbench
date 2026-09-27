// 网页版工作台回归测试
//
// 测三件事：
//   1. zip 读取 + XML 解析能不能吃下真实结构的 .xlsx（自己造一个真 zip 来测，不依赖外部文件）
//   2. 产出的 HTML 里的脚本能不能真的跑起来并渲染出内容（用极简 DOM 桩，不用 jsdom）
//   3. 「拖文件进来」这条交互路径能不能端到端走通
//
// 跑法：node tests/workbench.test.js
// 会先把工作台构建到临时目录再测，所以不依赖任何已存在的产物文件。

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const WEB = path.join(ROOT, 'assets/web')
const ENGINE = path.join(ROOT, 'assets/engine')
const HTML = path.join(os.tmpdir(), 'profit-workbench-test.html')

// 先构建产物，再测它
require(path.join(ROOT, 'scripts/build-workbench.js')).build({ out: HTML, quiet: true })

const { readXlsx } = require(path.join(WEB, 'xlsx-read.js'))
const xp = require(path.join(ENGINE, 'xlsx.js'))

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra)) }
}
function eq(name, a, b) { ok(name + ' = ' + JSON.stringify(b), a === b, JSON.stringify(a)) }

/* ---------- 造一个真的 .xlsx（zip 容器 + inlineStr 工作表） ---------- */

function colName(i) {
  let s = ''
  i = i + 1
  while (i > 0) {
    const r = (i - 1) % 26
    s = String.fromCharCode(65 + r) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sheetXml(rows) {
  const body = rows.map(function (row, r) {
    const cells = row.map(function (v, c) {
      if (v === '' || v === null || v === undefined) return ''
      return '<c r="' + colName(c) + (r + 1) + '" t="inlineStr"><is><t>' + xmlEsc(v) + '</t></is></c>'
    }).join('')
    return '<row r="' + (r + 1) + '">' + cells + '</row>'
  }).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + body + '</sheetData></worksheet>'
}

// 极简 zip 打包：只写 stored（不压缩）条目，够验证读取逻辑
function makeZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  entries.forEach(function (e) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)         // version needed
    local.writeUInt16LE(0, 6)          // flags
    local.writeUInt16LE(0, 8)          // method = stored
    local.writeUInt32LE(0, 14)         // crc（读取端不校验）
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)            // method
    cd.writeUInt32LE(0, 16)            // crc
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + data.length
  })

  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  const all = Buffer.concat(chunks.concat([cdBuf, eocd]))
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)
}

// 另外造一个 deflate 压缩过的版本，验证压缩分支（真实 xlsx 大多是压缩的）
function makeZipDeflated(entries) {
  const chunks = []
  const central = []
  let offset = 0

  entries.forEach(function (e) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = Buffer.from(e.data, 'utf8')
    const comp = zlib.deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)          // method = deflate
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, comp)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(0, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + comp.length
  })

  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  const all = Buffer.concat(chunks.concat([cdBuf, eocd]))
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)
}

function makeXlsx(rows, sheetName, deflate) {
  const entries = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>'
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + xmlEsc(sheetName || 'Sheet1') + '" sheetId="1" r:id="rId1"/></sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet1.xml"/></Relationships>'
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows) }
  ]
  return deflate ? makeZipDeflated(entries) : makeZip(entries)
}

/* ---------- 极简 DOM 桩 ---------- */

function makeDom() {
  const els = {}
  function makeEl(id) {
    const cl = {
      _s: {},
      add: function (c) { this._s[c] = 1 },
      remove: function (c) { delete this._s[c] },
      contains: function (c) { return !!this._s[c] },
      toggle: function (c, force) {
        const want = force === undefined ? !this._s[c] : !!force
        if (want) this._s[c] = 1; else delete this._s[c]
        return want
      }
    }
    return {
      id: id, _text: '', _html: '', value: '', files: null,
      classList: cl, listeners: {},
      addEventListener: function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
      click: function () { (this.listeners.click || []).forEach(function (f) { f({}) }) },
      get textContent() { return this._text },
      set textContent(v) { this._text = String(v) },
      get innerHTML() { return this._html },
      set innerHTML(v) { this._html = String(v) }
    }
  }
  const winListeners = {}
  const storage = {}
  const win = {
    __WB_MODULES__: undefined,
    addEventListener: function (t, fn) { (winListeners[t] = winListeners[t] || []).push(fn) },
    listeners: winListeners,
    location: { reload: function () { win.reloaded = true } },
    reloaded: false
  }
  const doc = {
    getElementById: function (id) { return (els[id] = els[id] || makeEl(id)) },
    querySelectorAll: function () { return [] },
    els: els
  }
  const localStorage = {
    getItem: function (k) { return k in storage ? storage[k] : null },
    setItem: function (k, v) { storage[k] = String(v) },
    removeItem: function (k) { delete storage[k] }
  }
  return { win: win, doc: doc, localStorage: localStorage, storage: storage }
}

function runHtml(dom) {
  const html = fs.readFileSync(HTML, 'utf8')
  const scripts = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(html))) scripts.push(m[1])
  if (!scripts.length) throw new Error('产物里没找到内联脚本')
  const src = scripts.join('\n;\n')
  const fn = new Function('window', 'document', 'localStorage', 'location', 'setTimeout', 'clearTimeout', src)
  fn(dom.win, dom.doc, dom.localStorage, dom.win.location, setTimeout, clearTimeout)
  return { scriptCount: scripts.length }
}

function count(str, needle) {
  let n = 0, i = 0
  while ((i = String(str).indexOf(needle, i)) >= 0) { n++; i += needle.length }
  return n
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms) })
}

/* ---------- 开始 ---------- */

async function main() {
  console.log('=== 1. xlsx 读取（自造真 zip） ===')

  const ordersRows = [
    ['订单号', '订单状态', '售后状态', '规格ID', 'SKU名称', 'SKU规格', 'SKU件数', '商家应收金额(元)（支付金额）', '店铺优惠(元)', '包裹总运费(元)', '支付时间'],
    ['SO001', '已完成', '无', 'SP-X', 'A款', 'A款', 1, 100, 0, 10, '2026-09-10 10:00'],
    ['SO002', '已完成', '无', 'SP-X', 'A款', 'A款', 1, 100, 0, 10, '2026-09-11 11:00'],
    ['SO003', '已完成', '退款成功', 'SP-X', 'A款', 'A款', 0, 100, 0, 10, '2026-09-12 12:00'],
    ['SO004', '已完成', '无', 'SP-Y', 'B款', 'B款', 2, 160, 5, 12, '2026-10-02 09:30']
  ]

  const stored = await readXlsx(makeXlsx(ordersRows, '包裹详情', false), xp)
  eq('stored 表名', stored.sheets[0].name, '包裹详情')
  eq('stored 行数', stored.sheets[0].rows.length, 5)
  eq('表头第 8 列', stored.sheets[0].rows[0][7], '商家应收金额(元)（支付金额）')

  const deflated = await readXlsx(makeXlsx(ordersRows, '包裹详情', true), xp)
  eq('deflate 行数', deflated.sheets[0].rows.length, 5)
  // 单元格一律是字符串，数值转换由 ingest 负责，这里只验压缩分支读得对
  eq('deflate 末行金额', deflated.sheets[0].rows[4][7], '160')

  let bad = ''
  try { await readXlsx(new ArrayBuffer(64), xp) } catch (e) { bad = e.message }
  ok('乱字节被拒绝', /不是.*zip|xlsx/.test(bad), bad)

  console.log('')
  console.log('=== 2. 表格识别 + 指标计算 ===')
  const ingest = require(path.join(ENGINE, 'ingest.js'))
  const compute = require(path.join(ENGINE, 'compute.js'))
  const advice = require(path.join(ENGINE, 'advice.js'))

  const o = ingest.normalize('orders', stored.sheets)
  eq('识别订单记录数', o.records.length, 4)
  eq('识别缺列', o.missing.length, 0)
  eq('日期起', o.summary.dayFrom, '2026-09-10')

  const p = ingest.normalize('params', [
    { name: 'x', rows: [['规格ID', '拿货价（元）'], ['SP-X', 40], ['SP-Y', 30]] }
  ])
  eq('参数行数', p.rows.length, 2)

  const snap = compute.buildSnapshot({ orders: o, params: p, options: { ads: 50, platformFee: 20 } })
  const K = snap.kpi
  eq('净销售额', K.net_sales, 360)          // 100+100+160（退款行剔除）
  eq('有效订单', K.orders, 3)
  eq('退款单', K.refund_orders, 1)
  eq('件数', K.qty, 4)                     // 1+1+2
  eq('成本', K.cost, 140)                  // SP-X 2件×40 + SP-Y 2件×30
  eq('毛利', K.gross_profit, 220)
  eq('运费', K.freight, 32)                // 10+10+12
  eq('履约后利润', K.post_fulfill_profit, 188)
  eq('经营利润', K.operating_profit, 118)  // 188-50-20

  const adv = advice.buildAdvice(snap.skus)
  eq('建议条数', adv.length, 2)
  ok('有定位标签', adv.every(function (s) { return !!s.role && !!s.sug }), JSON.stringify(adv.map(function (s) { return s.role })))

  // 参数表里有、本期一笔没卖的规格，必须也出现在结果里（要清仓的那批）
  const zero = compute.buildSnapshot({
    orders: o,
    params: ingest.normalize('params', [
      { name: 'x', rows: [['规格ID', '拿货价（元）'], ['SP-X', 40], ['SP-Z', 25]] }
    ]),
    options: {}
  })
  const zeroAdv = advice.buildAdvice(zero.skus)
  eq('零成交规格也建卡片', zero.skus.length, 3)
  const zs = zeroAdv.filter(function (s) { return s.spec === 'SP-Z' })[0]
  ok('零成交规格判为滞销款', zs && zs.role === '滞销款', zs && zs.role)
  ok('零成交给清仓建议', zs && /清仓/.test(zs.sug), zs && zs.sug)
  // SP-Y 有成交却缺价，被报出来是对的；SP-Z 零成交，不该被卷进「利润虚高」那条
  ok('零成交规格不被误报缺价虚高',
    zero.meta.warnings.every(function (w) {
      return !(/没有拿货价/.test(w) && w.indexOf('SP-Z') >= 0)
    }),
    JSON.stringify(zero.meta.warnings))

  console.log('')
  console.log('=== 3. 产物 HTML 能跑起来并渲染 ===')
  const dom = makeDom()
  const run = runHtml(dom)
  eq('内联脚本块数', run.scriptCount, 3)

  const kpis = dom.doc.getElementById('kpis').innerHTML
  const advList = dom.doc.getElementById('advList').innerHTML
  const tbody = dom.doc.getElementById('tbody').innerHTML
  const meta = dom.doc.getElementById('meta').textContent
  const srcBadge = dom.doc.getElementById('srcBadge').textContent

  eq('KPI 卡数', count(kpis, 'class="kpi"'), 6)
  ok('KPI 含净销售额', kpis.indexOf('净销售额') >= 0)
  ok('示例净销售额 ¥4,886', kpis.indexOf('¥4,886') >= 0, kpis.slice(0, 400))
  eq('建议卡数', count(advList, 'class="adv '), 9)
  eq('明细行数', count(tbody, '<tr>'), 9)
  eq('默认是示例数据', srcBadge, '示例数据')
  ok('期次已写入', /2026-09-22/.test(meta), meta)

  // 规则分支都要在示例里出现
  ;['待核数据', '滞销款', '先治退款', '过度款', '利润款', '基础款', '常规款'].forEach(function (role) {
    ok('示例覆盖「' + role + '」', advList.indexOf('>' + role + '<') >= 0)
  })
  ok('零成交的款也有卡片', advList.indexOf('SP-G001') >= 0)
  ok('过度款排在利润款前面',
    advList.indexOf('过度款') < advList.indexOf('利润款'))

  console.log('')
  console.log('=== 4. 拖文件进来（端到端） ===')
  const dropListeners = dom.win.listeners.drop || []
  eq('已注册 drop 事件', dropListeners.length, 1)

  const ordersFile = {
    name: '订单导出.xlsx',
    arrayBuffer: function () { return Promise.resolve(makeXlsx(ordersRows, '包裹详情', true)) }
  }
  const paramsFile = {
    name: '拿货价.xlsx',
    arrayBuffer: function () {
      return Promise.resolve(makeXlsx([['规格ID', '拿货价（元）'], ['SP-X', 40], ['SP-Y', 30]], '拿货价', false))
    }
  }

  dropListeners[0]({ preventDefault: function () {}, dataTransfer: { files: [ordersFile, paramsFile] } })

  let waited = 0
  while (waited < 2000 && dom.doc.getElementById('srcBadge').textContent !== '你的数据') {
    await sleep(25)
    waited += 25
  }
  eq('已切到「你的数据」', dom.doc.getElementById('srcBadge').textContent, '你的数据')

  const kpis2 = dom.doc.getElementById('kpis').innerHTML
  const tbody2 = dom.doc.getElementById('tbody').innerHTML
  ok('重算为 ¥360', kpis2.indexOf('¥360') >= 0, kpis2.slice(0, 400))
  eq('明细变成 2 行', count(tbody2, '<tr>'), 2)
  ok('明细里出现 SP-X', tbody2.indexOf('SP-X') >= 0)
  ok('提示条给了成功反馈',
    dom.doc.getElementById('tipOkText').textContent.indexOf('重算完毕') >= 0,
    dom.doc.getElementById('tipOkText').textContent)

  console.log('')
  console.log('=== 5. 费用参数改动即时重算 ===')
  const adsInput = dom.doc.getElementById('inAds')
  const feeInput = dom.doc.getElementById('inPlatformFee')
  eq('费用输入框被初始化', adsInput.value, 670)

  adsInput.value = '0'
  feeInput.value = '0'
  ;(adsInput.listeners.input || []).forEach(function (f) { f({}) })
  const kpis3 = dom.doc.getElementById('kpis').innerHTML
  // 换数据后费用仍是那次填的，清掉费用 → 经营利润应回到履约后利润 188
  ok('费用清零后经营利润同步',
    kpis3.indexOf('<div class="t">经营利润</div><div class="v">¥188.00</div>') >= 0,
    kpis3.slice(0, 500))

  console.log('')
  console.log('----------------------------------------')
  console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '  失败 ' + fail : ''))
  if (fail) process.exit(1)
  process.exit(0)
}

main().catch(function (e) {
  console.error('测试自身出错：', e && e.stack || e)
  process.exit(1)
})
