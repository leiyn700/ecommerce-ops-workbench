// 表格 → 结构化数据（只做机械提取，不重算指标）
// 指标口径只有一处权威实现（工作台/云端），这里刻意不算利润、不做分层，
// 避免小程序和云端出现两套口径。

// 逻辑字段 → 可能的列名（按优先级，先精确后包含）
const ORDER_ALIASES = {
  o: ['订单号'],
  st: ['订单状态'],
  as: ['售后状态'],
  sp: ['规格ID'],
  sn: ['SKU名称'],
  ss: ['SKU规格'],
  q: ['SKU件数'],
  rec: ['商家应收金额(元)（支付金额）', '商家应收金额(元)(支付金额)', '商家应收金额'],
  pay: ['用户应付金额(元)', '用户应付金额'],
  pr: ['商品总价(元)', '商品总价'],
  pc: ['平台优惠(元)', '平台优惠'],
  sc: ['店铺优惠(元)', '店铺优惠'],
  cc: ['支付渠道优惠(元)', '支付渠道优惠'],
  mp: ['SKU商家改价(元)', 'SKU商家改价'],
  fr: ['包裹总运费(元)', '包裹总运费'],
  pv: ['省'],
  ct: ['市'],
  t: ['支付时间'],
  iid: ['商品ID'],
  nm: ['商品名称'],
  tl: ['达人名称']
}

const PARAM_ALIASES = {
  sp: ['规格ID', '规格id', '规格编码', 'SKU规格ID', '规格'],
  cost: ['拿货价（元）', '拿货价(元)', '拿货价', '拿货成本', '成本价', '进价', '进货价', '成本']
}

// 订单导出必须具备的字段：缺任何一个都算不出核心指标
const ORDER_REQUIRED = ['rec', 'ss', 'fr', 't']
const ORDER_LABEL = {
  o: '订单号', st: '订单状态', as: '售后状态', sp: '规格ID', sn: 'SKU名称', ss: 'SKU规格',
  q: 'SKU件数', rec: '商家应收金额', pay: '用户应付金额', pr: '商品总价', pc: '平台优惠',
  sc: '店铺优惠', cc: '支付渠道优惠', mp: 'SKU商家改价', fr: '包裹总运费', pv: '省', ct: '市',
  t: '支付时间', iid: '商品ID', nm: '商品名称', tl: '达人名称'
}

// 非售后状态值（视为无售后）
const NO_AFTERSALE = ['无', '无售后', '否', '未申请', '无退款', '-', '/', '正常', '无退货退款']

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').trim()
}

// 取值用：只去首尾空白，保留内部空格（时间戳「2026-09-22 14:33」不能被压掉）
function clean(s) {
  return String(s == null ? '' : s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '')
}

function toNumber(v) {
  if (v == null) return null
  var s = String(v).replace(/[,\s￥¥元]/g, '')
  if (s === '' || s === '-' || s === '--') return null
  var n = Number(s)
  return isNaN(n) ? null : n
}

// 表头行：取前 10 行里命中必需列最多的一行，其次比非空格数
// 注意：空单元格必须跳过 —— '任意串'.indexOf('') 恒为 0，会把空行误判成命中
function findHeaderRow(rows, needCols) {
  var best = 0
  var bestHit = -1
  var bestFilled = -1
  var limit = Math.min(rows.length, 10)
  for (var i = 0; i < limit; i++) {
    var filled = 0
    var hit = 0
    var row = rows[i] || []
    for (var k = 0; k < row.length; k++) {
      var cell = norm(row[k])
      if (cell === '') continue
      filled++
      if (needCols) {
        for (var a = 0; a < needCols.length; a++) {
          if (norm(needCols[a]) !== '' && norm(needCols[a]) === cell) { hit++; break }
        }
      }
    }
    if (hit > bestHit || (hit === bestHit && filled > bestFilled)) {
      bestHit = hit
      bestFilled = filled
      best = i
    }
  }
  return best
}

function buildColumnMap(header, aliases) {
  var map = {}
  var used = {}
  var heads = header.map(norm)
  Object.keys(aliases).forEach(function (key) {
    var list = aliases[key]
    // 先精确
    for (var i = 0; i < list.length; i++) {
      var want = norm(list[i])
      for (var j = 0; j < heads.length; j++) {
        if (!used[j] && heads[j] === want) { map[key] = j; used[j] = 1; return }
      }
    }
    // 再包含
    for (var m = 0; m < list.length; m++) {
      var w = norm(list[m])
      for (var n = 0; n < heads.length; n++) {
        if (!used[n] && heads[n] && w && (heads[n].indexOf(w) >= 0 || w.indexOf(heads[n]) >= 0)) {
          map[key] = n
          used[n] = 1
          return
        }
      }
    }
  })
  return map
}

// 日期：支持 '2026-09-22 14:33:00' / '2026/9/22' / Excel 序列号
function parseTime(v) {
  var s = clean(v)
  if (!s) return ''
  var serial = Number(s)
  if (!isNaN(serial) && serial > 20000 && serial < 60000) {
    var ms = Math.round((serial - 25569) * 86400000)
    var d = new Date(ms)
    if (isNaN(d.getTime())) return s
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
  }
  return s.replace(/\//g, '-')
}

function pad(n) {
  return (n < 10 ? '0' : '') + n
}

function dayOf(t) {
  var s = String(t || '')
  var m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (!m) return ''
  return m[1] + '-' + pad(Number(m[2])) + '-' + pad(Number(m[3]))
}

function shortDay(d) {
  var m = /(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  if (!m) return ''
  return Number(m[1]) + '.' + Number(m[2]) + '.' + Number(m[3])
}

// ---- 订单导出 ----
function normalizeOrders(rows) {
  var hr = findHeaderRow(rows, [ORDER_ALIASES.rec[0], ORDER_ALIASES.ss[0], ORDER_ALIASES.fr[0]])
  var header = rows[hr] || []
  var map = buildColumnMap(header, ORDER_ALIASES)

  var missing = []
  ORDER_REQUIRED.forEach(function (k) {
    if (map[k] == null) missing.push(ORDER_LABEL[k] || k)
  })

  var keys = Object.keys(map)
  var records = []
  var afterSaleValues = {}
  var provinceAgg = {}
  var totals = {
    rowCount: 0, netSales: 0, refundAmount: 0, refundRows: 0,
    freight: 0, shopCoupon: 0, platformCoupon: 0, discount: 0, qty: 0
  }
  var orderIds = {}
  var minDay = ''
  var maxDay = ''
  var MAX_ROWS = 5000

  for (var i = hr + 1; i < rows.length; i++) {
    var r = rows[i]
    if (!r || !r.length) continue
    var rec = {}
    var any = false
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k]
      var raw = r[map[key]]
      var val = clean(raw)
      if (val === '') continue
      any = true
      if (key === 'q' || key === 'rec' || key === 'pay' || key === 'pr' ||
          key === 'pc' || key === 'sc' || key === 'cc' || key === 'mp' || key === 'fr') {
        var n = toNumber(val)
        if (n != null) rec[key] = n
        else rec[key] = val
      } else if (key === 't') {
        rec[key] = parseTime(val)
      } else {
        rec[key] = val
      }
    }
    if (!any) continue
    if (records.length >= MAX_ROWS) break
    records.push(rec)

    totals.rowCount++
    if (rec.o) orderIds[rec.o] = 1
    var amount = typeof rec.rec === 'number' ? rec.rec : 0
    totals.netSales += amount
    totals.freight += typeof rec.fr === 'number' ? rec.fr : 0
    totals.shopCoupon += typeof rec.sc === 'number' ? rec.sc : 0
    totals.platformCoupon += typeof rec.pc === 'number' ? rec.pc : 0
    totals.discount += typeof rec.mp === 'number' ? rec.mp : 0
    totals.qty += typeof rec.q === 'number' ? rec.q : 0

    var as = rec.as || ''
    if (as) {
      afterSaleValues[as] = (afterSaleValues[as] || 0) + 1
      if (NO_AFTERSALE.indexOf(as) < 0) {
        totals.refundRows++
        totals.refundAmount += amount
      }
    }

    var pv = rec.pv || '未知'
    if (!provinceAgg[pv]) provinceAgg[pv] = { name: pv, rows: 0, sales: 0 }
    provinceAgg[pv].rows++
    provinceAgg[pv].sales += amount

    var d = dayOf(rec.t)
    if (d) {
      if (!minDay || d < minDay) minDay = d
      if (!maxDay || d > maxDay) maxDay = d
    }
  }

  var provinces = Object.keys(provinceAgg).map(function (p) {
    return { name: provinceAgg[p].name, rows: provinceAgg[p].rows, sales: Math.round(provinceAgg[p].sales * 100) / 100 }
  }).sort(function (a, b) { return b.sales - a.sales }).slice(0, 10)

  var orderCount = Object.keys(orderIds).length || totals.rowCount

  return {
    headerRow: hr + 1,
    columns: keys.length,
    missing: missing,
    records: records,
    truncated: records.length >= MAX_ROWS,
    afterSaleValues: afterSaleValues,
    provinces: provinces,
    summary: {
      rowCount: totals.rowCount,
      orderCount: orderCount,
      netSales: Math.round(totals.netSales * 100) / 100,
      refundRows: totals.refundRows,
      refundAmount: Math.round(totals.refundAmount * 100) / 100,
      freight: Math.round(totals.freight * 100) / 100,
      shopCoupon: Math.round(totals.shopCoupon * 100) / 100,
      platformCoupon: Math.round(totals.platformCoupon * 100) / 100,
      discount: Math.round(totals.discount * 100) / 100,
      qty: totals.qty,
      dayFrom: minDay,
      dayTo: maxDay
    }
  }
}

// ---- 成本参数表 ----
function normalizeParams(rows) {
  var hr = findHeaderRow(rows, PARAM_ALIASES.sp)
  var header = rows[hr] || []
  var map = buildColumnMap(header, PARAM_ALIASES)
  var missing = []
  if (map.sp == null) missing.push('规格ID')
  if (map.cost == null) missing.push('拿货价')

  var list = []
  var missingCost = []
  if (map.sp != null) {
    for (var i = hr + 1; i < rows.length; i++) {
      var r = rows[i]
      if (!r) continue
      var sp = clean(r[map.sp])
      if (!sp) continue
      var cost = map.cost == null ? null : toNumber(r[map.cost])
      if (cost == null) missingCost.push(sp)
      list.push({ sp: sp, cost: cost })
      if (list.length >= 5000) break
    }
  }
  return {
    headerRow: hr + 1,
    missing: missing,
    rows: list,
    missingCost: missingCost,
    summary: { specs: list.length, withCost: list.length - missingCost.length, missingCostCount: missingCost.length }
  }
}

// ---- 其他表格：原样带回表头与前若干行 ----
function normalizeGeneric(rows) {
  var hr = findHeaderRow(rows, null)
  var header = (rows[hr] || []).map(function (h) { return clean(h) })
  var out = []
  var MAX = 300
  for (var i = hr + 1; i < rows.length && out.length < MAX; i++) {
    var r = rows[i]
    if (!r || !r.length) continue
    var line = []
    for (var j = 0; j < header.length; j++) line.push(clean(r[j]))
    if (line.join('') === '') continue
    out.push(line)
  }
  return { headerRow: hr + 1, header: header, rows: out, truncated: out.length >= MAX, summary: { rows: out.length, columns: header.length } }
}

function normalize(docKey, sheets) {
  // 选表：优先含该文档特征列的工作表
  var pick = null
  var need = docKey === 'params' ? PARAM_ALIASES.sp : docKey === 'orders' ? ORDER_ALIASES.rec : null
  if (need) {
    for (var i = 0; i < sheets.length; i++) {
      var flat = sheets[i].rows.slice(0, 5).reduce(function (a, r) { return a.concat(r.map(norm)) }, [])
      for (var j = 0; j < need.length; j++) {
        if (flat.indexOf(norm(need[j])) >= 0) { pick = sheets[i]; break }
      }
      if (pick) break
    }
  }
  if (!pick) pick = sheets[0]

  if (docKey === 'orders') {
    var o = normalizeOrders(pick.rows)
    o.sheet = pick.name
    return o
  }
  if (docKey === 'params') {
    var p = normalizeParams(pick.rows)
    p.sheet = pick.name
    return p
  }
  var g = normalizeGeneric(pick.rows)
  g.sheet = pick.name
  return g
}

function periodFromSummary(summary) {
  if (!summary || !summary.dayFrom || !summary.dayTo) return ''
  return shortDay(summary.dayFrom) + '-' + shortDay(summary.dayTo)
}

module.exports = {
  normalize: normalize,
  normalizeOrders: normalizeOrders,
  normalizeParams: normalizeParams,
  normalizeGeneric: normalizeGeneric,
  periodFromSummary: periodFromSummary,
  toNumber: toNumber,
  parseTime: parseTime,
  ORDER_LABEL: ORDER_LABEL,
  NO_AFTERSALE: NO_AFTERSALE
}
