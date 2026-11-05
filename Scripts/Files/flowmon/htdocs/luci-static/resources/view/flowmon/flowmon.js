'use strict';
'require view';
'require poll';
'require ui';
'require fs';

var nameMap = {};

function fmtBps(v) {
	v = Number(v) || 0;
	if (v >= 1e9) return (v / 1e9).toFixed(2) + ' Gbps';
	if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
	if (v >= 1e3) return (v / 1e3).toFixed(1) + ' Kbps';
	return Math.round(v) + ' bps';
}

function fmtBytes(b) {
	b = Number(b) || 0;
	var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], i = 0;
	while (b >= 1024 && i < 4) { b /= 1024; i++; }
	return b.toFixed(i ? 2 : 0) + ' ' + u[i];
}

/* 把峰值抬到 1/2/2.5/3/5/10 x 10^n 的整刻度; 少了 3 这一档, 峰值落在 2.1~3 之间会白扔四成高度 */
function niceMax(v) {
	if (!(v > 0)) return 1024;
	var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
	var n = v / e;
	var m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 5 ? 5 : 10;
	return m * e;
}

function svgEl(tag, attrs) {
	var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (var k in attrs) el.setAttribute(k, attrs[k]);
	return el;
}

/* 浏览器本地日期 -> YYYY-MM-DD（不用 toISOString，避免 UTC 偏移把日期推到前一天） */
function ymd(d) {
	return d.getFullYear() + '-' +
		(d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-' +
		(d.getDate() < 10 ? '0' : '') + d.getDate();
}

function cliName(ip) {
	if (ip === '__ROUTER__') return '路由器本机';
	return (nameMap[ip] != null && nameMap[ip] !== '') ? nameMap[ip] : ip;
}

function summaryCard(el, label) {
	el.style.margin = '0';
	el.style.fontSize = '1.5em';
	el.style.fontVariantNumeric = 'tabular-nums';
	el.textContent = '-';
	return E('div', { 'class': 'cbi-map', 'style': 'flex:1;min-width:180px' }, [
		E('div', { 'class': 'cbi-map-descr' }, label),
		el
	]);
}

var dayCum = {};        /* 「某日」模式: ip -> {rx,tx} 该日累计(字节) */
var dayCumOn = false;

/* 实时表第 5 列: 全部模式看今天的累计, 某日模式看所选那天的累计。
   live 接口里的 day_rx 永远是"采集器当天"的数, 不随日历走, 所以不能直接用 */
function cumCell(c) {
	if (dayCumOn) {
		var v = dayCum[c.ip];
		/* 该日压根没有这个 IP 的记录, 与"有记录但为 0"是两件事, 用破折号区分 */
		return v ? (fmtBytes(v.rx) + ' / ' + fmtBytes(v.tx))
		         : E('span', { 'style': 'opacity:.45' }, '—');
	}
	return fmtBytes(c.day_rx) + ' / ' + fmtBytes(c.day_tx);
}

function buildClientTable(bodyEl, clients, keyPrefix) {
	var rows = [];
	for (var i = 0; i < clients.length; i++) {
		var c = clients[i];
		rows.push([
			E('strong', {}, cliName(c.ip)),
			E('span', { 'style': 'color:#777;margin-left:.5em' },
				(c.ip !== cliName(c.ip) && c.ip !== '__ROUTER__') ? c.ip : ''),
			keyPrefix === 'live' ? fmtBps(c.rx) : fmtBytes(c.rx * 1024),
			keyPrefix === 'live' ? fmtBps(c.tx) : fmtBytes(c.tx * 1024),
			keyPrefix === 'live' ? cumCell(c) : fmtBytes((c.rx + c.tx) * 1024)
		]);
	}
	while (bodyEl.firstChild) { bodyEl.removeChild(bodyEl.firstChild); }
	for (var j = 0; j < rows.length; j++) {
		var tr = bodyEl.appendChild(E('tr', { 'class': 'tr' }));
		for (var k = 0; k < rows[j].length; k++) {
			tr.appendChild(E('td', {
				'class': 'td',
				'style': k >= 2 ? 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap' : ''
			}, rows[j][k]));
		}
	}
	if (!rows.length) {
		var tr2 = bodyEl.appendChild(E('tr', { 'class': 'tr placeholder' }));
		tr2.appendChild(E('td', { 'class': 'td', 'colspan': '5' }, E('em', {}, '暂无数据')));
	}
}

return view.extend({
	render: function () {
		var liveTotalRx = E('h3'), liveTotalTx = E('h3'), liveDaySum = E('h3'), cpuUsage = E('h3'), cpuFreq = E('h3');
		var liveBody = E('tbody', { 'id': 'flowmon_live' });
		var histBody = E('tbody', { 'id': 'flowmon_hist' });
		var hoursBody = E('tbody', { 'id': 'flowmon_hours' });
		var staleNote = E('div', { 'class': 'alert alert-warning', 'style': 'display:none' }, '采集器数据超时，可能已停止运行');

		var header = E('div', { 'style': 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:1em' }, [
			summaryCard(liveTotalRx, '全屋 ↓ 下行'),
			summaryCard(liveTotalTx, '全屋 ↑ 上行'),
			summaryCard(liveDaySum, '今日累计 ↓/↑'),
			summaryCard(cpuUsage, 'CPU 使用率'),
			summaryCard(cpuFreq, 'CPU 频率')
		]);

		/* ================= 趋势图: 当日分时 0–24 时（折线 + 柱状） ================= */
		var hourly = [];        /* 24 × {rx,tx,rxkb,txkb,has} 当日某天 */
		var chartDate = '';

		var legendEl = function (label, color) {
			return E('span', { 'style': 'font-size:.85em' }, [
				E('span', { 'style': 'display:inline-block;width:10px;height:10px;border-radius:2px;background:' + color + ';margin-right:5px;vertical-align:middle' }),
				label
			]);
		};

		var mkChart = function (titleText) {
			var c = {};
			c.title = E('h3', { 'style': 'margin:0' }, titleText);
			c.peak = E('span', { 'style': 'opacity:.7;font-size:.85em' }, '');
			c.svg = svgEl('svg', {
				'viewBox': '0 0 800 150',
				'preserveAspectRatio': 'none',
				'style': 'display:block;width:100%;height:150px'
			});
			c.scale = E('span', {
				'style': 'position:absolute;left:2px;top:0;font-size:.72em;opacity:.45;pointer-events:none'
			}, '');
			c.wrap = E('div', {
				'style': 'position:relative;border-bottom:1px solid rgba(128,128,128,.35)'
			}, [c.svg, c.scale]);
			/* 刻度用绝对定位 HTML, 不用 SVG <text>, 否则被 preserveAspectRatio:none 横向拉变形 */
			c.axis = E('div', { 'style': 'position:relative;height:1.2em;margin-top:2px' });
			c.box = E('div', { 'class': 'cbi-map', 'style': 'margin-bottom:1.2em' }, [
				E('div', { 'style': 'display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:10px;margin-bottom:.5em' }, [
					c.title,
					E('div', { 'style': 'display:flex;gap:14px;align-items:baseline;flex-wrap:wrap' }, [
						legendEl('下行', '#2f86d8'),
						legendEl('上行', '#f08c2e'),
						c.peak
					])
				]),
				c.wrap,
				c.axis
			]);
			return c;
		};

		var liveChart = mkChart('实时速率');
		var barChart = mkChart('分时柱状');

		var SERIES = [
			['rx', '#2f86d8', 'rgba(47,134,216,.16)'],
			['tx', '#f08c2e', 'rgba(240,140,46,.15)']
		];

		/* ---- 实时波形: 最近 10 分钟, 每 2 秒一个点 (与采集器 spark.txt 条数一致) ---- */
		var MAXPTS = 300;
		var sparkData = [];
		var lastTs = 0;

		var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
		var hms = function (t) {
			var d = new Date(t * 1000);
			return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
		};

		var drawSpark = function () {
			var W = 800, H = 150, PT = 8, PB = 4, HH = H - PT - PB, BASE = PT + HH;
			while (liveChart.svg.firstChild) liveChart.svg.removeChild(liveChart.svg.firstChild);
			while (liveChart.axis.firstChild) liveChart.axis.removeChild(liveChart.axis.firstChild);

			var n = sparkData.length;
			var win = Math.min(n, MAXPTS);
			if (win < 1) {
				liveChart.scale.textContent = '';
				liveChart.peak.textContent = '等待采样…';
				return;
			}
			var start = n - win;
			var pkRx = 0, pkTx = 0;
			for (var i = 0; i < win; i++) {
				var p = sparkData[start + i];
				if (p.rx > pkRx) pkRx = p.rx;
				if (p.tx > pkTx) pkTx = p.tx;
			}
			var yMax = niceMax(Math.max(pkRx, pkTx));
			/* 铺满整个宽度: 刚打开时只有几十个点也不留白, 与最初那版一致 */
			var xAt = function (k) { return win > 1 ? k / (win - 1) * W : W; };
			var yAt = function (v) { return PT + (1 - Math.min(v / yMax, 1)) * HH; };

			for (var g = 0; g <= 4; g++) {
				var gy = PT + HH * g / 4;
				liveChart.svg.appendChild(svgEl('line', {
					'x1': 0, 'y1': gy, 'x2': W, 'y2': gy,
					'stroke': 'currentColor',
					'stroke-opacity': (g === 4 ? 0.28 : 0.1),
					'stroke-width': 1,
					'vector-effect': 'non-scaling-stroke'
				}));
			}
			/* 每 30 个点(约 1 分钟)一条竖线, 给个时间参照 */
			for (var vx = 0; vx < win; vx += 30) {
				liveChart.svg.appendChild(svgEl('line', {
					'x1': xAt(vx), 'y1': PT, 'x2': xAt(vx), 'y2': BASE,
					'stroke': 'currentColor', 'stroke-opacity': 0.07,
					'stroke-width': 1, 'vector-effect': 'non-scaling-stroke'
				}));
			}

			/* 采集中断(重启/卡顿)处断线, 否则会把两段连成一条假直线 */
			var segs = [], cur = [0];
			for (var j = 1; j < win; j++) {
				if (sparkData[start + j].t - sparkData[start + j - 1].t > 8) { segs.push(cur); cur = [j]; }
				else cur.push(j);
			}
			segs.push(cur);

			/* 先铺面积再压线, 避免两色互相遮挡 */
			for (var a = 0; a < SERIES.length; a++) {
				var ka = SERIES[a][0];
				for (var sa = 0; sa < segs.length; sa++) {
					var ga = segs[sa];
					if (ga.length < 2) continue;
					var dd = '';
					for (var q = 0; q < ga.length; q++)
						dd += (q ? 'L' : 'M') + xAt(ga[q]).toFixed(1) + ',' + yAt(sparkData[start + ga[q]][ka]).toFixed(1);
					liveChart.svg.appendChild(svgEl('path', {
						'd': dd + 'L' + xAt(ga[ga.length - 1]).toFixed(1) + ',' + BASE +
							'L' + xAt(ga[0]).toFixed(1) + ',' + BASE + 'Z',
						'fill': SERIES[a][2], 'stroke': 'none'
					}));
				}
			}
			for (var t = 0; t < SERIES.length; t++) {
				var kt = SERIES[t][0];
				for (var st = 0; st < segs.length; st++) {
					var gt = segs[st];
					if (gt.length < 2) continue;
					var pd = '';
					for (var e = 0; e < gt.length; e++)
						pd += (e ? 'L' : 'M') + xAt(gt[e]).toFixed(1) + ',' + yAt(sparkData[start + gt[e]][kt]).toFixed(1);
					liveChart.svg.appendChild(svgEl('path', {
						'd': pd, 'fill': 'none', 'stroke': SERIES[t][1],
						'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
						'vector-effect': 'non-scaling-stroke'
					}));
				}
			}

			liveChart.scale.textContent = fmtBps(yMax);
			liveChart.peak.textContent = '峰值 ↓ ' + fmtBps(pkRx) + ' / ↑ ' + fmtBps(pkTx);
			liveChart.axis.appendChild(E('span', {
				'style': 'position:absolute;left:0;top:0;font-size:.72em;opacity:.6;white-space:nowrap'
			}, hms(sparkData[start].t)));
			liveChart.axis.appendChild(E('span', {
				'style': 'position:absolute;right:0;top:0;font-size:.72em;opacity:.6;white-space:nowrap'
			}, '现在 ' + hms(sparkData[n - 1].t)));
		};

		var loadSeries = function () {
			return fs.exec('/usr/libexec/flowmon-panel', ['series']).then(function (res) {
				var d;
				try { d = JSON.parse(res.stdout); } catch (e) { return; }
				if (!d || !d.points) return;
				sparkData = d.points.slice(-MAXPTS);
				if (sparkData.length) lastTs = sparkData[sparkData.length - 1].t;
				drawSpark();
			}).catch(function () { });
		};

		/* 当前小时只过了几分钟, 用 3600 当分母会把尾巴压成假的低谷;
		   按已过秒数折算, 整点对齐后自然收敛到真值 */
		var curHourSecs = function (day, hour, now) {
			if (day !== ymd(now) || hour !== now.getHours()) return 3600;
			return Math.max(now.getMinutes() * 60 + now.getSeconds(), 120);
		};

		/* 刻度落在格边界(0/6/12/18/24) */
		var axisBoundary = function (chart, n, step) {
			for (var k = 0; k <= n; k += step) {
				chart.axis.appendChild(E('span', {
					'style': 'position:absolute;top:0;font-size:.72em;opacity:.6;white-space:nowrap;left:' +
						(k / n * 100) + '%;transform:translateX(' +
						(k === 0 ? '0' : k === n ? '-100%' : '-50%') + ')'
				}, String(k)));
			}
		};

		/* ---- 分时柱状: 固定 0–24 时, 跟随「统计日期」 ---- */
		var dayTip = function (i, d) {
			return (d && d.has) ? (i + ':00  ↓ ' + fmtBps(d.rx) + '  ↑ ' + fmtBps(d.tx)) : (i + ':00  无采样');
		};

		var paintDay = function (hoursArr) {
			var now = new Date();
			chartDate = historyDate || ymd(now);
			hourly = [];
			for (var z = 0; z < 24; z++) hourly.push({ 'rx': 0, 'tx': 0, 'rxkb': 0, 'txkb': 0, 'has': false });
			for (var q = 0; q < hoursArr.length; q++) {
				var hq = hoursArr[q].h || '';
				if (hq.substring(0, 10) !== chartDate) continue;
				var hr = parseInt(hq.substring(11, 13), 10);
				if (!(hr >= 0 && hr < 24)) continue;
				hourly[hr].has = true;
				hourly[hr].rx += Number(hoursArr[q].rx) || 0;
				hourly[hr].tx += Number(hoursArr[q].tx) || 0;
			}
			for (var u = 0; u < 24; u++) {
				var secs = curHourSecs(chartDate, u, now);
				/* 留一份原始 KiB, 柱状图标题行要显示当天合计流量 */
				hourly[u].rxkb = hourly[u].rx;
				hourly[u].txkb = hourly[u].tx;
				hourly[u].rx = hourly[u].rx * 1024 * 8 / secs;
				hourly[u].tx = hourly[u].tx * 1024 * 8 / secs;
			}
			paintBars(barChart, hourly, { 'vstep': 6, 'tip': dayTip });
			axisBoundary(barChart, 24, 3);
			barChart.title.textContent = '分时柱状 · ' + chartDate + '（每小时平均，0–24 时）';
		};

		/* ---- 柱状: 与折线同一份数据、同一 y 刻度, 只换呈现方式 ---- */
		var paintBars = function (chart, slots, opt) {
			var W = 800, H = 150, PT = 8, PB = 4, HH = H - PT - PB, BASE = PT + HH;
			var n = slots.length;
			while (chart.svg.firstChild) chart.svg.removeChild(chart.svg.firstChild);
			while (chart.axis.firstChild) chart.axis.removeChild(chart.axis.firstChild);

			var max = 0;
			for (var m0 = 0; m0 < n; m0++) {
				var d0 = slots[m0];
				if (!d0 || !d0.has) continue;
				if (d0.rx > max) max = d0.rx;
				if (d0.tx > max) max = d0.tx;
			}
			var yMax = (opt.yMax > 0) ? opt.yMax : niceMax(max);
			var slot = W / n, bw = slot * 0.32, gap = slot * 0.08;

			for (var g = 0; g <= 4; g++) {
				var gy = PT + HH * g / 4;
				chart.svg.appendChild(svgEl('line', {
					'x1': 0, 'y1': gy, 'x2': W, 'y2': gy,
					'stroke': 'currentColor',
					'stroke-opacity': (g === 4 ? 0.28 : 0.1),
					'stroke-width': 1,
					'vector-effect': 'non-scaling-stroke'
				}));
			}
			for (var vx = 0; vx <= n; vx += opt.vstep) {
				chart.svg.appendChild(svgEl('line', {
					'x1': vx / n * W, 'y1': PT, 'x2': vx / n * W, 'y2': BASE,
					'stroke': 'currentColor', 'stroke-opacity': 0.07,
					'stroke-width': 1, 'vector-effect': 'non-scaling-stroke'
				}));
			}

			var pts = 0, sumRx = 0, sumTx = 0;
			for (var i = 0; i < n; i++) {
				var d = slots[i];
				if (!d || !d.has) continue;
				pts++;
				sumRx += Number(d.rxkb) || 0;
				sumTx += Number(d.txkb) || 0;
				var xc = (i + 0.5) * slot;
				for (var s = 0; s < SERIES.length; s++) {
					var v = d[SERIES[s][0]];
					var hgt = Math.min(v / yMax, 1) * HH;
					/* 有流量但不足 1px 时给个保底, 否则那一小时看着像没数据 */
					if (v > 0 && hgt < 1) hgt = 1;
					if (!(hgt > 0)) continue;
					var x0 = xc - bw - gap / 2 + s * (bw + gap);
					chart.svg.appendChild(svgEl('rect', {
						'x': x0.toFixed(1), 'y': (BASE - hgt).toFixed(1),
						'width': bw.toFixed(1), 'height': hgt.toFixed(1),
						'fill': SERIES[s][1], 'fill-opacity': 0.85, 'rx': 0.6
					}));
				}
			}

			/* 悬停热区: 每格一个透明矩形 + 原生 title */
			for (var hz = 0; hz < n; hz++) {
				var rect = svgEl('rect', {
					'x': (hz / n * W).toFixed(1), 'y': PT,
					'width': (W / n).toFixed(1), 'height': HH, 'fill': 'transparent'
				});
				var ttl = svgEl('title', {});
				ttl.textContent = opt.tip(hz, slots[hz]);
				rect.appendChild(ttl);
				chart.svg.appendChild(rect);
			}

			chart.scale.textContent = pts ? fmtBps(yMax) : '';
			chart.peak.textContent = pts
				? ('合计 ↓ ' + fmtBytes(sumRx * 1024) + ' / ↑ ' + fmtBytes(sumTx * 1024))
				: '暂无采样数据';
		};

		/* 表头与表体必须在同一个 <table> 内, 否则列宽各算各的, 上下永远对不齐 */
		var mkTable = function (title, heads, body, rightFrom, titleEl) {
			var ths = [];
			var box = E('div', { 'class': 'cbi-map' }, [
				titleEl || E('h3', {}, title),
				E('table', { 'class': 'table' }, [
					E('thead', {}, [
						E('tr', { 'class': 'tr table-titles' }, heads.map(function (h, i) {
							var th = E('th', {
								'class': 'th',
								'style': (rightFrom != null && i >= rightFrom) ? 'text-align:right' : ''
							}, h);
							ths.push(th);
							return th;
						}))
					]),
					body
				])
			]);
			/* 把表头元素暴露出去: 「今日累计」这列要随统计日期改标题 */
			box.thEls = ths;
			return box;
		};

		/* 统计日期控件: 全部（按天聚合） / 指定某日（按小时聚合，日历选择） */
		var modeSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '' }, '全部'),
			E('option', { 'value': 'day' }, '某日')
		]);
		var dateInp = E('input', {
			'class': 'cbi-input-text',
			'type': 'date',
			'style': 'width:auto;min-width:11em;display:none'
		});
		var keepSel = E('select', { 'class': 'cbi-input-select' }, [2, 7, 14, 30].map(function (n) {
			return E('option', { 'value': String(n) }, n + ' 天');
		}));
		var usageNote = E('span', { 'style': 'color:#777;font-size:.9em' }, '');
		var rangesNote = E('span', { 'style': 'color:#777;font-size:.9em' }, '历史数据保留 2 天');

		var controls = E('div', {
			'style': 'display:flex;gap:.6em;align-items:center;flex-wrap:wrap;margin-bottom:1em'
		}, [
			E('label', {}, '统计日期'), modeSel, dateInp,
			E('label', { 'style': 'margin-left:1em' }, '保留天数'), keepSel,
			usageNote
		]);

		var hoursTitle = E('h3', {}, '全屋分时段');
		var histTitle = E('h3', {}, '客户端累计');
		var historyDate = '';
		var lastLiveClients = [];   /* 最近一次实时快照, 切日期时用它立刻重画 */

		var liveTable = mkTable('客户端实时速率',
			['客户端', 'IP', '↓ 速率', '↑ 速率', '今日累计 ↓/↑'], liveBody, 2);

		var root = E('div', {}, [
			E('h2', {}, '实时流量（按客户端）'),
			E('p', {}, [
				'基于 nft 钩子层字节计数（forward + TPROXY input/output），每 2 秒采样；',
				rangesNote,
				'。经过代理（Xray/PassWall）的流量计入发起客户端。'
			]),
			staleNote,
			header,
			liveChart.box,
			barChart.box,
			controls,
			liveTable,
			mkTable('客户端累计', ['客户端', 'IP', '↓ 累计', '↑ 累计', '合计'], histBody, 2, histTitle),
			mkTable('全屋分时段', ['时段', '↓ 流量', '↑ 流量'], hoursBody, 1, hoursTitle)
		]);

		poll.add(function () {
			return fs.exec('/usr/libexec/flowmon-panel', ['live']).then(function (res) {
				var d;
				try { d = JSON.parse(res.stdout); } catch (e) { return; }
				if (!d || d.error) {
					ui.showNotification(null, _('flowmon: ' + (d && d.error ? d.error : '无数据')));
					return;
				}
				if (d.clients) {
					for (var i = 0; i < d.clients.length; i++) {
						if (d.clients[i].name && d.clients[i].name !== d.clients[i].ip) {
							nameMap[d.clients[i].ip] = d.clients[i].name;
						}
					}
				}
				var fresh = (Date.now() / 1000 - (d.ts || 0)) < 15;
				staleNote.style.display = fresh ? 'none' : '';
				liveTotalRx.textContent = fmtBps(d.total && d.total.rx);
				liveTotalTx.textContent = fmtBps(d.total && d.total.tx);
				liveDaySum.textContent = fmtBytes(d.total && d.total.day_rx) + ' / ' + fmtBytes(d.total && d.total.day_tx);
				cpuUsage.textContent = (d.cpu && d.cpu.usage != null) ? d.cpu.usage.toFixed(1) + ' %' : '-';
				cpuFreq.textContent = (d.cpu && d.cpu.mhz) ? (d.cpu.mhz + ' MHz') : '-';

				/* 波形: 仅在新采样点时追加, 避免同一 tick 重复画 */
				if (d.ts && d.ts > lastTs) {
					lastTs = d.ts;
					sparkData.push({
						't': d.ts,
						'rx': Number(d.total && d.total.rx) || 0,
						'tx': Number(d.total && d.total.tx) || 0
					});
					if (sparkData.length > MAXPTS) sparkData.shift();
					drawSpark();
				}

				var cl = (d.clients || []).slice();
				cl.unshift({
					ip: '__ROUTER__',
					rx: d.router && d.router.rx, tx: d.router && d.router.tx,
					day_rx: (d.router && d.router.day_rx) || 0,
					day_tx: (d.router && d.router.day_tx) || 0
				});
				lastLiveClients = cl;
				buildClientTable(liveBody, cl, 'live');
			}).catch(function () { });
		}, 2);

		var loadHistory = function () {
			var args = historyDate ? ['history', historyDate] : ['history'];
			return fs.exec('/usr/libexec/flowmon-panel', args).then(function (res) {
				var d;
				try { d = JSON.parse(res.stdout); } catch (e) { return; }
				if (!d) return;
				buildClientTable(histBody, d.clients || [], 'hist');
				histTitle.textContent = historyDate ? ('客户端累计 ' + historyDate)
				                                    : '客户端累计（全部保留期）';

				/* 某日模式: 实时表第 5 列改吃该日的累计(history 的单位是 KiB)。
				   采集器给的 day_rx 永远是"今天", 不跟着日历走, 直接显示会让用户以为选日期没生效 */
				dayCumOn = !!historyDate;
				dayCum = {};
				if (dayCumOn) {
					var dc = d.clients || [];
					for (var ci = 0; ci < dc.length; ci++) {
						dayCum[dc[ci].ip] = {
							'rx': (Number(dc[ci].rx) || 0) * 1024,
							'tx': (Number(dc[ci].tx) || 0) * 1024
						};
					}
				}
				if (liveTable.thEls && liveTable.thEls[4]) {
					liveTable.thEls[4].textContent = dayCumOn
						? (historyDate.substring(5) + ' 累计 ↓/↑')
						: '今日累计 ↓/↑';
				}
				/* 立刻重画一次实时表, 别让用户等下一个 2 秒 tick 才看到新口径 */
				if (lastLiveClients.length) buildClientTable(liveBody, lastLiveClients, 'live');
				/* 单日 -> 每小时一格; 全部 -> 每天一格 */
				var buckets = {}, order = [];
				var hours = d.hours || [];

				/* 折线与柱状吃同一份当日小时数据, 一次绘制同时更新两张图 */
				paintDay(hours);

				for (var i = 0; i < hours.length; i++) {
					var h = hours[i].h || '';
					var day = h.substring(0, 10), hh = parseInt(h.substring(11, 13), 10) || 0;
					var key = historyDate ? (hh < 10 ? '0' + hh : String(hh)) + ':00' : day;
					if (!buckets[key]) { buckets[key] = { rx: 0, tx: 0 }; order.push(key); }
					buckets[key].rx += hours[i].rx;
					buckets[key].tx += hours[i].tx;
				}
				order.sort();
				var rows = [];
				for (var j = 0; j < order.length; j++) {
					var k = order[j];
					rows.push([k, fmtBytes(buckets[k].rx * 1024), fmtBytes(buckets[k].tx * 1024)]);
				}
				hoursTitle.textContent = historyDate ? ('全屋分时段 ' + historyDate + '（每小时）')
				                                     : '全屋分时段（每天）';
				while (hoursBody.firstChild) { hoursBody.removeChild(hoursBody.firstChild); }
				for (var m = rows.length - 1; m >= 0; m--) {
					var tr = hoursBody.appendChild(E('tr', { 'class': 'tr' }));
					for (var n = 0; n < 3; n++) tr.appendChild(E('td', {
						'class': 'td',
						'style': n >= 1 ? 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap' : ''
					}, rows[m][n]));
				}
				if (!rows.length) {
					var tr2 = hoursBody.appendChild(E('tr', { 'class': 'tr placeholder' }));
					tr2.appendChild(E('td', { 'class': 'td', 'colspan': '3' }, E('em', {}, '暂无历史数据（需运行一段时间后累积）')));
				}
			}).catch(function () { });
		};

		/* 保留设置 + 日历可选范围（min = 保留期首日, max = 今天） */
		var loadDates = function () {
			return fs.exec('/usr/libexec/flowmon-panel', ['dates']).then(function (res) {
				var d;
				try { d = JSON.parse(res.stdout); } catch (e) { return; }
				if (!d) return;
				var days = (d.days || []).slice().sort();
				var cur = Number(d.retention) || 2;
				var today = ymd(new Date());
				var startD = new Date();
				startD.setDate(startD.getDate() - (cur - 1));
				var start = ymd(startD);

				/* 先放开边界再收紧: 直接把 min 改大会把旧值夹掉, 浏览器会清空输入框 */
				dateInp.removeAttribute('min');
				dateInp.removeAttribute('max');
				dateInp.min = start;
				dateInp.max = today;
				/* 默认看最新有数据的一天（通常是今天）; 若旧值越界则回落到该日 */
				var fallback = days.length ? days[days.length - 1] : today;
				if (!dateInp.value || dateInp.value < start || dateInp.value > today) {
					dateInp.value = fallback;
				}
				if (historyDate) historyDate = dateInp.value;

				/* 保留天数可能被 SSH 改成 1/3/60/90 这类非预设值，重建时补进去，
				   否则 <select> 会静默显示成第一个选项，误导用户 */
				while (keepSel.firstChild) keepSel.removeChild(keepSel.firstChild);
				var keepOpts = [2, 7, 14, 30];
				if (keepOpts.indexOf(cur) < 0) keepOpts.push(cur);
				keepOpts.sort(function (a, b) { return a - b; });
				for (var q = 0; q < keepOpts.length; q++) {
					keepSel.appendChild(E('option', { 'value': String(keepOpts[q]) }, keepOpts[q] + ' 天'));
				}
				keepSel.value = String(cur);
				rangesNote.textContent = '历史数据保留 ' + cur + ' 天';
				usageNote.textContent = d.used_kb ? '· 已占用 ' + fmtBytes(d.used_kb * 1024) : '';
			}).catch(function () { });
		};

		var applyDate = function () {
			historyDate = (modeSel.value === 'day' && dateInp.value) ? dateInp.value : '';
			loadHistory();
		};

		modeSel.addEventListener('change', function () {
			var isDay = modeSel.value === 'day';
			dateInp.style.display = isDay ? '' : 'none';
			applyDate();
		});

		dateInp.addEventListener('change', applyDate);

		keepSel.addEventListener('change', function () {
			var n = keepSel.value;
			keepSel.disabled = true;
			fs.exec('/usr/libexec/flowmon-panel', ['setretention', n]).then(function (res) {
				var d;
				try { d = JSON.parse(res.stdout); } catch (e) { d = null; }
				if (!d || d.error) throw new Error('setretention failed');
				return loadDates();
			}).then(function () {
				return loadHistory();
			}).catch(function () {
				ui.showNotification(null, 'flowmon: 修改保留天数失败');
			}).then(function () { keepSel.disabled = false; });
		});

		/* 先画出空网格, 数据到了再填, 避免首屏一片空白 */
		paintDay([]);
		drawSpark();
		loadSeries();
		loadDates().then(loadHistory);
		poll.add(loadHistory, 60);
		/* 跨天后日历的 max 要跟进到新的"今天"，每小时重扫一次 */
		poll.add(loadDates, 3600);

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
