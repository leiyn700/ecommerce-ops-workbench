// 计算引擎：订单导出 + 拿货价参数表 → 一份完整的经营快照
// 这是全项目唯一的利润口径实现，页面只负责展示，不重复算一遍。
//
// 口径（页面上照此向使用者交代，避免出现两套数）：
//   净销售额   = 全部行的「商家应收金额」− 退款 / 取消行的金额
//   有效订单   = 至少有一行未退款、且不是整单退款的订单数
//   退款率     = 整单退款数 ÷（有效订单 + 整单退款）
//   毛利       = 净销售额 − 拿货价 × 有效件数
//   履约后利润 = 毛利 − 包裹运费合计
//   经营利润   = 履约后利润 − 平台扣费 − 推广费
//
// 除「退款额 / 退款率」外，所有金额与件数只统计有效行（退款行不重复计入
// 运费与优惠），这样「有效行」就是全篇唯一的统计基准，不会一头扣销售额、
// 一头又扣运费。
//
// 平台扣费与推广费订单表里没有，由使用者在「传数据」页手工填；
// 不填就按 0 计，并在预警里明说「利润为上限估值」，不假装精确。

const { NO_AFTERSALE } = require('./ingest')

function r2(v) {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

// 售后状态非空、且不在「无售后」白名单里 → 这一行是退款/取消行
function isRefundRow(rec) {
  const as = String((rec && rec.as) || '').replace(/\s+/g, '')
  if (!as) return false
  return NO_AFTERSALE.indexOf(as) < 0
}

function monthKey(t) {
  const m = /(\d{4})-(\d{1,2})/.exec(String(t || ''))
  if (!m) return ''
  const mm = Number(m[2])
  return m[1] + '-' + (mm < 10 ? '0' : '') + mm
}

function skuKeyOf(rec) {
  const sp = String((rec && rec.sp) || '').trim()
  if (sp) return sp
  const ss = String((rec && rec.ss) || '').trim()
  if (ss) return ss
  const sn = String((rec && rec.sn) || '').trim()
  if (sn) return sn
  return '未标注规格'
}

// 分层：按净销售额排序，前 25% 爆款、25%–50% 潜力款，其余常规款；零成交单独一档
function assignLayers(list) {
  const withSales = list.filter(s => s.orders > 0).sort((a, b) => b.sales - a.sales)
  const n = withSales.length
  const top = Math.ceil(n * 0.25)
  const mid = Math.ceil(n * 0.5)
  withSales.forEach((s, i) => {
    if (i < top) s.layer = '爆款'
    else if (i < mid) s.layer = '潜力款'
    else s.layer = '常规款'
  })
  list.forEach(s => {
    if (s.orders === 0) s.layer = '滞销款'
  })
}

// 基于已有数据的标签（没有流量数据，只标能从订单与成本推出来的问题）
function tagOf(s) {
  const tags = []
  if (s.orders === 0) tags.push('零成交')
  if (s.refund_rate > 0.15) tags.push('退款异常')
  if (s.missing_cost) tags.push('缺拿货价')
  if (s.post !== null && s.post < 0) tags.push('履约后亏损')
  if (s.unit !== null && s.unit >= 0 && s.unit <= 5 && s.orders > 0) tags.push('几乎不赚')
  return tags
}

function buildSnapshot(input) {
  const src = input || {}
  const orders = src.orders || {}
  const params = src.params || {}
  const opts = src.options || {}

  const records = orders.records || []
  const warnings = []

  // ---- 拿货价索引 ----
  const costMap = {}
  let paramRows = 0
  let paramWithCost = 0
  ;(params.rows || []).forEach(function (p) {
    if (!p || !p.sp) return
    paramRows++
    const key = String(p.sp).trim()
    if (p.cost !== null && p.cost !== undefined && isFinite(Number(p.cost))) {
      costMap[key] = Number(p.cost)
      paramWithCost++
    } else if (!(key in costMap)) {
      costMap[key] = null
    }
  })
  const hasParams = paramRows > 0
  if (!hasParams) {
    warnings.push('没有读到拿货价参数表，成本按 0 计，利润会明显虚高 —— 请把参数表一起传进来')
  }

  // ---- 订单级聚合（判定整单退款） ----
  const orderMeta = {}
  const flat = []
  records.forEach(function (rec, i) {
    if (!rec) return
    const key = rec.o ? String(rec.o) : '#' + i
    const amount = typeof rec.rec === 'number' ? rec.rec : 0
    const refund = isRefundRow(rec)
    if (!orderMeta[key]) orderMeta[key] = { rows: 0, refundRows: 0, sales: 0, refund: 0 }
    const m = orderMeta[key]
    m.rows++
    if (refund) {
      m.refundRows++
      m.refund += amount
    } else {
      m.sales += amount
    }
    flat.push({ rec: rec, key: key, refund: refund })
  })

  const orderKeys = Object.keys(orderMeta)
  const refundOrders = orderKeys.filter(k => orderMeta[k].refundRows === orderMeta[k].rows)
  const refundOrderSet = {}
  refundOrders.forEach(k => { refundOrderSet[k] = 1 })
  const validOrders = orderKeys.length - refundOrders.length

  // ---- 全局合计 ----
  const total = {
    sales: 0, refund: 0, freight: 0, coupon: 0, discount: 0, qty: 0, refundRows: 0, rows: 0
  }
  const bySku = {}
  const monthAgg = {}

  flat.forEach(function (item) {
    const rec = item.rec
    const amount = typeof rec.rec === 'number' ? rec.rec : 0
    const qty = typeof rec.q === 'number' ? rec.q : 1
    const freight = typeof rec.fr === 'number' ? rec.fr : 0
    const shopCoupon = typeof rec.sc === 'number' ? rec.sc : 0
    const platCoupon = typeof rec.pc === 'number' ? rec.pc : 0
    const mp = typeof rec.mp === 'number' ? rec.mp : 0

    total.rows++

    const sp = skuKeyOf(rec)
    if (!bySku[sp]) {
      bySku[sp] = {
        spec: sp,
        name: (rec.sn || rec.ss || sp),
        item: (rec.nm || '').trim(),
        sales: 0, refund: 0, refundRows: 0, qty: 0, freight: 0, coupon: 0, discount: 0,
        orders: {}, refundOrderIds: {}, rows: 0
      }
    }
    const s = bySku[sp]
    s.rows++

    if (item.refund) {
      s.refund += amount
      s.refundRows++
      total.refund += amount
      total.refundRows++
      s.refundOrderIds[item.key] = 1
    } else {
      // 口径统一：除退款额本身外，金额与件数一律只统计有效行。
      // 退款行不再重复计入运费/优惠，免得同一单一头扣销售额、一头又扣运费。
      total.freight += freight
      total.coupon += shopCoupon + platCoupon
      total.discount += mp
      s.freight += freight
      s.coupon += shopCoupon + platCoupon
      s.discount += mp
      s.sales += amount
      s.qty += qty
      total.sales += amount
      total.qty += qty
      s.orders[item.key] = 1
    }

    const mk = monthKey(rec.t)
    if (mk) {
      if (!monthAgg[mk]) monthAgg[mk] = { month: mk, sales: 0 }
      if (!item.refund) monthAgg[mk].sales += amount
    }
  })

  // ---- 逐 SKU 收口 ----
  const skus = Object.keys(bySku).map(function (sp) {
    const s = bySku[sp]

    // 同一订单既有有效行又有退款行时，算部分退款：订单仍计有效，金额已单列
    Object.keys(s.orders).forEach(function (k) {
      if (s.refundOrderIds[k]) delete s.refundOrderIds[k]
    })

    const orderCount = Object.keys(s.orders).length
    const refundCount = Object.keys(s.refundOrderIds).length

    const known = hasParams && costMap[sp] !== undefined && costMap[sp] !== null
    const unitCost = known ? costMap[sp] : 0
    const cost = r2(unitCost * s.qty)
    const gross = r2(s.sales - cost)
    const post = r2(gross - s.freight)
    const grossMargin = s.sales > 0 ? gross / s.sales : null
    const totalOrders = orderCount + refundCount

    return {
      spec: sp,
      name: s.name || sp,
      item: s.item,
      sales: r2(s.sales),
      orders: orderCount,
      qty: s.qty,
      unit: orderCount > 0 ? r2(post / orderCount) : null,
      avg_price: orderCount > 0 ? r2(s.sales / orderCount) : null,
      cost: cost,
      gross_profit: gross,
      gross_margin: grossMargin,
      freight: r2(s.freight),
      post: post,
      refund_amount: r2(s.refund),
      refund_orders: refundCount,
      refund_rate: totalOrders > 0 ? refundCount / totalOrders : 0,
      missing_cost: hasParams ? !known : true,
      coupon: r2(s.coupon),
      discount: r2(s.discount),
      rows: s.rows,
      layer: '常规款'
    }
  })

  // 参数表里列了、本期却一行订单都没有的规格：也要建卡片。
  // 早先这些只写进预警，结果「哪些款一件没卖」被埋在文字里 —— 而滞销款恰恰是
  // 最该被看见、要清仓处理的那一批。参数表本身就是店主的在售清单，数量可控。
  const costOnly = Object.keys(costMap).filter(k => !bySku[k])
  costOnly.forEach(function (key) {
    const known = costMap[key] !== null && costMap[key] !== undefined
    skus.push({
      spec: key,
      name: key,
      item: '',
      sales: 0,
      orders: 0,
      qty: 0,
      unit: null,
      avg_price: null,
      cost: 0,
      gross_profit: 0,
      gross_margin: null,
      freight: 0,
      post: 0,
      refund_amount: 0,
      refund_orders: 0,
      refund_rate: 0,
      missing_cost: !known,
      coupon: 0,
      discount: 0,
      rows: 0,
      layer: '滞销款'
    })
  })

  assignLayers(skus)
  skus.sort((a, b) => b.sales - a.sales)
  skus.forEach(s => {
    const tags = tagOf(s)
    s.tags = tags
    s.actions = tags.length ? tags.slice() : []
  })

  // ---- 成本与利润 ----
  const totalCost = r2(skus.reduce((sum, s) => sum + s.cost, 0))
  const grossProfit = r2(total.sales - totalCost)
  const grossMargin = total.sales > 0 ? grossProfit / total.sales : null
  const postProfit = r2(grossProfit - total.freight)

  const ads = Math.max(0, Number(opts.ads) || 0)
  const platformFee = Math.max(0, Number(opts.platformFee) || 0)
  const operatingProfit = r2(postProfit - ads - platformFee)
  const roi = ads > 0 ? r2(total.sales / ads) : null

  // ---- 月度趋势：利润按销售额占比分摊（口径写清楚，不假装是按月实算）----
  const monthly = Object.keys(monthAgg)
    .sort()
    .map(function (k) {
      const m = monthAgg[k]
      const share = total.sales > 0 ? m.sales / total.sales : 0
      return { month: m.month, sales: r2(m.sales), profit: r2(operatingProfit * share) }
    })

  // ---- 预警 ----
  // 只对本期真有成交的款说「利润虚高」：零成交的款没有利润可言，说了是无意义噪音
  const missingCostSkus = skus.filter(s => s.missing_cost && s.orders > 0)
  if (missingCostSkus.length) {
    warnings.push(
      '这些规格没有拿货价，利润按 0 成本算，明显偏高：' +
      missingCostSkus.slice(0, 6).map(s => s.spec).join('、') +
      (missingCostSkus.length > 6 ? ' 等 ' + missingCostSkus.length + ' 个' : '')
    )
  }
  if (!ads) warnings.push('没填推广费，所以算不出真实 ROI，经营利润是按「零投放」估的上限')
  if (!platformFee) warnings.push('没填平台扣费，佣金与技术服务费没被扣掉，经营利润偏高')
  if (orders.truncated) warnings.push('订单行数超过 5000，只用了前 5000 行')
  if (params.summary && params.summary.missingCostCount) {
    warnings.push('参数表里有 ' + params.summary.missingCostCount + ' 个规格没填拿货价')
  }
  if (costOnly.length) {
    warnings.push('参数表里有 ' + costOnly.length + ' 个规格本期没有成交：' + costOnly.slice(0, 6).join('、'))
  }

  // ---- 期次 ----
  let label = String(opts.periodLabel || '').trim()
  if (!label && orders.summary && orders.summary.dayFrom) {
    label = orders.summary.dayFrom + ' ~ ' + orders.summary.dayTo
  }
  if (!label) {
    const now = new Date()
    label = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate() + ' 上传'
  }

  const days = orders.summary && orders.summary.dayFrom && orders.summary.dayTo
    ? Math.max(
        1,
        Math.round(
          (new Date(orders.summary.dayTo.replace(/-/g, '/')).getTime() -
            new Date(orders.summary.dayFrom.replace(/-/g, '/')).getTime()) /
            86400000
        ) + 1
      )
    : null

  const gen = new Date()
  const generated =
    gen.getFullYear() + '-' +
    ('0' + (gen.getMonth() + 1)).slice(-2) + '-' +
    ('0' + gen.getDate()).slice(-2) + ' ' +
    ('0' + gen.getHours()).slice(-2) + ':' +
    ('0' + gen.getMinutes()).slice(-2)

  return {
    v: 2,
    meta: {
      label: label,
      generated: generated,
      warnings: warnings,
      period_days: days,
      sources: {
        orders: (orders.summary && orders.summary.rowCount) || 0,
        orders_sheet: orders.sheet || '',
        params: paramRows,
        params_with_cost: paramWithCost
      },
      inputs: { ads: ads, platform_fee: platformFee }
    },
    kpi: {
      net_sales: r2(total.sales),
      orders: validOrders,
      refund_orders: refundOrders.length,
      avg_order_value: validOrders > 0 ? r2(total.sales / validOrders) : null,
      coupon: r2(total.coupon),
      discount: r2(total.discount),
      refund_amount: r2(total.refund),
      refund_rate: orderKeys.length > 0 ? refundOrders.length / orderKeys.length : 0,
      qty: total.qty,
      cost: totalCost,
      gross_profit: grossProfit,
      gross_margin: grossMargin,
      freight: r2(total.freight),
      post_fulfill_profit: postProfit,
      ads: ads,
      platform_fee: platformFee,
      operating_profit: operatingProfit,
      net_profit: operatingProfit,
      roi: roi
    },
    monthly: monthly,
    skus: skus
  }
}

module.exports = { buildSnapshot, isRefundRow, monthKey, skuKeyOf }
