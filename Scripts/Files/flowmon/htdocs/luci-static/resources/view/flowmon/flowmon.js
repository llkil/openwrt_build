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

/* 把峰值抬到 1/2/2.5/5/10 x 10^n 的整刻度, 避免曲线贴顶 */
function niceMax(v) {
	if (!(v > 0)) return 1024;
	var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
	var n = v / e;
	var m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
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
			keyPrefix === 'live' ? fmtBytes(c.day_rx) + ' / ' + fmtBytes(c.day_tx) : fmtBytes((c.rx + c.tx) * 1024)
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

		/* ================= 趋势图: 当日分时(0–24) + 实时滚窗(近 24 小时) ================= */
		var hourly = [];        /* 24 × {rx,tx,has} 当日某天 */
		var roll = [];          /* ROLL_N × {rx,tx,has,label} 滚动窗口 */
		var chartDate = '';
		var ROLL_N = 24;

		var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

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

		var dayChart = mkChart('全屋分时速率');
		var rollChart = mkChart('实时滚窗');

		var SERIES = [
			['rx', '#2f86d8', 'rgba(47,134,216,.16)'],
			['tx', '#f08c2e', 'rgba(240,140,46,.15)']
		];

		/* 当前小时只过了几分钟, 用 3600 当分母会把尾巴压成假的低谷;
		   按已过秒数折算, 整点对齐后自然收敛到真值 */
		var curHourSecs = function (day, hour, now) {
			if (day !== ymd(now) || hour !== now.getHours()) return 3600;
			return Math.max(now.getMinutes() * 60 + now.getSeconds(), 120);
		};

		/* 通用绘制: slots 定长, 每格一个点, 点居格中; 无采集的格子断开折线 */
		var paintSeries = function (chart, slots, opt) {
			var W = 800, H = 150, PT = 8, PB = 4, HH = H - PT - PB, BASE = PT + HH;
			var n = slots.length;
			while (chart.svg.firstChild) chart.svg.removeChild(chart.svg.firstChild);
			while (chart.axis.firstChild) chart.axis.removeChild(chart.axis.firstChild);

			var max = 0, pkSum = -1, pkH = 0, pts = 0;
			for (var i = 0; i < n; i++) {
				var s0 = slots[i];
				if (!s0 || !s0.has) continue;
				pts++;
				if (s0.rx > max) max = s0.rx;
				if (s0.tx > max) max = s0.tx;
				if (s0.rx + s0.tx > pkSum) { pkSum = s0.rx + s0.tx; pkH = i; }
			}
			var yMax = niceMax(max);
			var xAt = function (k) { return (k + 0.5) / n * W; };
			var yAt = function (v) { return PT + (1 - Math.min(v / yMax, 1)) * HH; };

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

			var segs = [], cur = [];
			for (var j = 0; j < n; j++) {
				if (slots[j] && slots[j].has) cur.push(j);
				else if (cur.length) { segs.push(cur); cur = []; }
			}
			if (cur.length) segs.push(cur);

			/* 先铺面积再压线, 避免两色互相遮挡 */
			for (var a = 0; a < SERIES.length; a++) {
				var ka = SERIES[a][0];
				for (var sa = 0; sa < segs.length; sa++) {
					var ga = segs[sa];
					if (ga.length < 2) continue;
					var dd = '';
					for (var p = 0; p < ga.length; p++)
						dd += (p ? 'L' : 'M') + xAt(ga[p]).toFixed(1) + ',' + yAt(slots[ga[p]][ka]).toFixed(1);
					chart.svg.appendChild(svgEl('path', {
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
					if (!gt.length) continue;
					/* 孤立单点画一小段短线, 否则那一格什么都看不见 */
					if (gt.length === 1) {
						chart.svg.appendChild(svgEl('line', {
							'x1': xAt(gt[0]) - 1.5, 'y1': yAt(slots[gt[0]][kt]),
							'x2': xAt(gt[0]) + 1.5, 'y2': yAt(slots[gt[0]][kt]),
							'stroke': SERIES[t][1], 'stroke-width': 2.4, 'stroke-linecap': 'round',
							'vector-effect': 'non-scaling-stroke'
						}));
						continue;
					}
					var pd = '';
					for (var q = 0; q < gt.length; q++)
						pd += (q ? 'L' : 'M') + xAt(gt[q]).toFixed(1) + ',' + yAt(slots[gt[q]][kt]).toFixed(1);
					chart.svg.appendChild(svgEl('path', {
						'd': pd, 'fill': 'none', 'stroke': SERIES[t][1],
						'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
						'vector-effect': 'non-scaling-stroke'
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

			chart.scale.textContent = max > 0 ? fmtBps(yMax) : '';
			chart.peak.textContent = pts ? opt.peak(pkH) : '暂无采样数据';
			return { 'max': max, 'pts': pts, 'pkH': pkH, 'yMax': yMax };
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

		/* 刻度落在格中心(时刻标签); 最后一格是当前小时, 不管步长都要标出来 */
		var axisCenter = function (chart, labels, step) {
			var n = labels.length;
			for (var k = 0; k < n; k++) {
				if (k % step && k !== n - 1) continue;
				chart.axis.appendChild(E('span', {
					'style': 'position:absolute;top:0;font-size:.72em;opacity:.6;white-space:nowrap;left:' +
						((k + 0.5) / n * 100) + '%;transform:translateX(-50%)'
				}, labels[k]));
			}
		};

		/* ---- 当日分时: 固定 0–24 时, 跟随「统计日期」 ---- */
		var paintDay = function (hoursArr) {
			var now = new Date();
			chartDate = historyDate || ymd(now);
			hourly = [];
			for (var z = 0; z < 24; z++) hourly.push({ 'rx': 0, 'tx': 0, 'has': false });
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
				hourly[u].rx = hourly[u].rx * 1024 * 8 / secs;
				hourly[u].tx = hourly[u].tx * 1024 * 8 / secs;
			}
			paintSeries(dayChart, hourly, {
				'vstep': 6,
				'tip': function (i, d) {
					return (d && d.has) ? (i + ':00  ↓ ' + fmtBps(d.rx) + '  ↑ ' + fmtBps(d.tx)) : (i + ':00  无采样');
				},
				'peak': function (k) {
					return '峰值 ' + k + ':00  ↓ ' + fmtBps(hourly[k].rx) + ' / ↑ ' + fmtBps(hourly[k].tx);
				}
			});
			axisBoundary(dayChart, 24, 3);
			dayChart.title.textContent = '全屋分时速率 · ' + chartDate + '（每小时平均，0–24 时）';
		};

		/* ---- 实时滚窗: 右端是当前小时(还在长), 整点一过冻结并左移一格 ---- */
		var paintRoll = function (hoursArr) {
			var now = new Date();
			var keys = [], labels = [];
			for (var i = ROLL_N - 1; i >= 0; i--) {
				var d = new Date(now.getTime());
				d.setHours(d.getHours() - i, 0, 0, 0);
				keys.push(ymd(d) + ' ' + pad2(d.getHours()));
				labels.push(pad2(d.getHours()) + ':00');
			}
			var idx = {}, k;
			for (k = 0; k < ROLL_N; k++) idx[keys[k]] = k;
			roll = [];
			for (k = 0; k < ROLL_N; k++) roll.push({ 'rx': 0, 'tx': 0, 'has': false, 'label': labels[k] });
			/* hours[].h 形如 "YYYY-MM-DD HH"，截前 13 位正好是键 */
			for (var q = 0; q < hoursArr.length; q++) {
				var pos = idx[(hoursArr[q].h || '').substring(0, 13)];
				if (pos === undefined) continue;
				roll[pos].has = true;
				roll[pos].rx += Number(hoursArr[q].rx) || 0;
				roll[pos].tx += Number(hoursArr[q].tx) || 0;
			}
			for (var u = 0; u < ROLL_N; u++) {
				var secs = curHourSecs(keys[u].substring(0, 10), parseInt(keys[u].substring(11, 13), 10), now);
				roll[u].rx = roll[u].rx * 1024 * 8 / secs;
				roll[u].tx = roll[u].tx * 1024 * 8 / secs;
			}
			paintSeries(rollChart, roll, {
				'vstep': 6,
				'tip': function (i, d) {
					var lab = (d && d.label) || '';
					return (d && d.has) ? (lab + '  ↓ ' + fmtBps(d.rx) + '  ↑ ' + fmtBps(d.tx)) : (lab + '  无采样');
				},
				'peak': function (k) {
					return '峰值 ' + roll[k].label + '  ↓ ' + fmtBps(roll[k].rx) + ' / ↑ ' + fmtBps(roll[k].tx);
				}
			});
			axisCenter(rollChart, labels, 3);
			rollChart.title.textContent = '实时滚窗（近 24 小时，每小时一格；当前小时按已过时间折算）';
		};
		/* 表头与表体必须在同一个 <table> 内, 否则列宽各算各的, 上下永远对不齐 */
		var mkTable = function (title, heads, body, rightFrom, titleEl) {
			return E('div', { 'class': 'cbi-map' }, [
				titleEl || E('h3', {}, title),
				E('table', { 'class': 'table' }, [
					E('thead', {}, [
						E('tr', { 'class': 'tr table-titles' }, heads.map(function (h, i) {
							return E('th', {
								'class': 'th',
								'style': (rightFrom != null && i >= rightFrom) ? 'text-align:right' : ''
							}, h);
						}))
					]),
					body
				])
			]);
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

		var root = E('div', {}, [
			E('h2', {}, '实时流量（按客户端）'),
			E('p', {}, [
				'基于 nft 钩子层字节计数（forward + TPROXY input/output），每 2 秒采样；',
				rangesNote,
				'。经过代理（Xray/PassWall）的流量计入发起客户端。'
			]),
			staleNote,
			header,
			dayChart.box,
			rollChart.box,
			controls,
			mkTable('客户端实时速率', ['客户端', 'IP', '↓ 速率', '↑ 速率', '今日累计 ↓/↑'], liveBody, 2),
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

				var cl = (d.clients || []).slice();
				cl.unshift({
					ip: '__ROUTER__',
					rx: d.router && d.router.rx, tx: d.router && d.router.tx,
					day_rx: (d.router && d.router.day_rx) || 0,
					day_tx: (d.router && d.router.day_tx) || 0
				});
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
				/* 单日 -> 每小时一格; 全部 -> 每天一格 */
				var buckets = {}, order = [];
				var hours = d.hours || [];

				/* 两张图: 当日分时直接吃本次响应; 滚窗要看跨零点的 24 小时,
				   「某日」模式下本次响应被裁剪过, 得另取一次全量 */
				paintDay(hours);
				if (historyDate) loadRoll(); else paintRoll(hours);

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

		/* 滚窗独立取一次全量（含跨零点的小时），只在「某日」模式下才会多这一次调用 */
		var loadRoll = function () {
			return fs.exec('/usr/libexec/flowmon-panel', ['history']).then(function (res) {
				var d;
				try { d = JSON.parse(res.stdout); } catch (e) { return; }
				if (!d) return;
				paintRoll(d.hours || []);
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
		paintRoll([]);
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
