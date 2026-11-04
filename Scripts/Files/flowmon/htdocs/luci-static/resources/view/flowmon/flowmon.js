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

		/* ---- 全屋分时速率: 0–24 时折线, 每小时平均 bps ---- */
		var hourly = [];               /* 24 × {rx,tx,has} */
		var chartDate = '';
		var hourTitle = E('h3', { 'style': 'margin:0' }, '全屋分时速率');
		var hourPeak = E('span', { 'style': 'opacity:.7;font-size:.85em' }, '');
		var hourSvg = svgEl('svg', {
			'viewBox': '0 0 800 150',
			'preserveAspectRatio': 'none',
			'style': 'display:block;width:100%;height:150px'
		});
		var hourScale = E('span', {
			'style': 'position:absolute;left:2px;top:0;font-size:.72em;opacity:.45;pointer-events:none'
		}, '');
		var chartWrap = E('div', {
			'style': 'position:relative;border-bottom:1px solid rgba(128,128,128,.35)'
		}, [hourSvg, hourScale]);
		/* 刻度用绝对定位的 HTML, 不放进 SVG —— 否则会被 preserveAspectRatio:none 横向拉变形 */
		var hourAxis = E('div', { 'style': 'position:relative;height:1.2em;margin-top:2px' });

		var drawHourly = function () {
			var W = 800, H = 150, PT = 8, PB = 4, HH = H - PT - PB, BASE = PT + HH;
			while (hourSvg.firstChild) hourSvg.removeChild(hourSvg.firstChild);
			while (hourAxis.firstChild) hourAxis.removeChild(hourAxis.firstChild);

			var max = 0, pkSum = -1, pkH = 0, pts = 0;
			for (var i = 0; i < 24; i++) {
				var o = hourly[i];
				if (!o || !o.has) continue;
				pts++;
				if (o.rx > max) max = o.rx;
				if (o.tx > max) max = o.tx;
				if (o.rx + o.tx > pkSum) { pkSum = o.rx + o.tx; pkH = i; }
			}
			var yMax = niceMax(max);

			for (var g = 0; g <= 4; g++) {
				var gy = PT + HH * g / 4;
				hourSvg.appendChild(svgEl('line', {
					'x1': 0, 'y1': gy, 'x2': W, 'y2': gy,
					'stroke': 'currentColor',
					'stroke-opacity': (g === 4 ? 0.28 : 0.1),
					'stroke-width': 1,
					'vector-effect': 'non-scaling-stroke'
				}));
			}
			/* 每 6 小时一条竖线, 与刻度对齐 */
			for (var vx = 0; vx <= 4; vx++) {
				hourSvg.appendChild(svgEl('line', {
					'x1': W * vx / 4, 'y1': PT, 'x2': W * vx / 4, 'y2': BASE,
					'stroke': 'currentColor', 'stroke-opacity': 0.07,
					'stroke-width': 1, 'vector-effect': 'non-scaling-stroke'
				}));
			}

			/* 点取小时中点; 无采集的小时断开折线, 不用 0 值冒充"没流量" */
			var xAt = function (h) { return (h + 0.5) / 24 * W; };
			var yAt = function (v) { return PT + (1 - Math.min(v / yMax, 1)) * HH; };
			var segs = [], cur = [];
			for (var hh = 0; hh < 24; hh++) {
				if (hourly[hh] && hourly[hh].has) cur.push(hh);
				else if (cur.length) { segs.push(cur); cur = []; }
			}
			if (cur.length) segs.push(cur);

			var series = [
				['rx', '#2f86d8', 'rgba(47,134,216,.16)'],
				['tx', '#f08c2e', 'rgba(240,140,46,.15)']
			];

			/* 先铺面积再压线, 避免两色互相遮挡 */
			for (var a = 0; a < series.length; a++) {
				var ka = series[a][0];
				for (var sa = 0; sa < segs.length; sa++) {
					var ga = segs[sa];
					if (ga.length < 2) continue;
					var dd = '';
					for (var p = 0; p < ga.length; p++)
						dd += (p ? 'L' : 'M') + xAt(ga[p]).toFixed(1) + ',' + yAt(hourly[ga[p]][ka]).toFixed(1);
					hourSvg.appendChild(svgEl('path', {
						'd': dd + 'L' + xAt(ga[ga.length - 1]).toFixed(1) + ',' + BASE +
							'L' + xAt(ga[0]).toFixed(1) + ',' + BASE + 'Z',
						'fill': series[a][2], 'stroke': 'none'
					}));
				}
			}
			for (var t = 0; t < series.length; t++) {
				var kt = series[t][0];
				for (var st = 0; st < segs.length; st++) {
					var gt = segs[st];
					if (!gt.length) continue;
					/* 孤立单点画一小段短线, 否则那个小时什么都看不见 */
					if (gt.length === 1) {
						hourSvg.appendChild(svgEl('line', {
							'x1': xAt(gt[0]) - 1.5, 'y1': yAt(hourly[gt[0]][kt]),
							'x2': xAt(gt[0]) + 1.5, 'y2': yAt(hourly[gt[0]][kt]),
							'stroke': series[t][1], 'stroke-width': 2.4, 'stroke-linecap': 'round',
							'vector-effect': 'non-scaling-stroke'
						}));
						continue;
					}
					var pd = '';
					for (var q = 0; q < gt.length; q++)
						pd += (q ? 'L' : 'M') + xAt(gt[q]).toFixed(1) + ',' + yAt(hourly[gt[q]][kt]).toFixed(1);
					hourSvg.appendChild(svgEl('path', {
						'd': pd, 'fill': 'none', 'stroke': series[t][1],
						'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
						'vector-effect': 'non-scaling-stroke'
					}));
				}
			}

			/* 悬停热区: 每小时一格, 用原生 title 提示 */
			for (var hz = 0; hz < 24; hz++) {
				var hd = hourly[hz];
				var rect = svgEl('rect', {
					'x': (hz / 24 * W).toFixed(1), 'y': PT,
					'width': (W / 24).toFixed(1), 'height': HH, 'fill': 'transparent'
				});
				var ttl = svgEl('title', {});
				ttl.textContent = (hd && hd.has)
					? hz + ':00  ↓ ' + fmtBps(hd.rx) + '  ↑ ' + fmtBps(hd.tx)
					: hz + ':00  无采样';
				rect.appendChild(ttl);
				hourSvg.appendChild(rect);
			}

			for (var ax = 0; ax <= 8; ax++) {
				var hv = ax * 3, pct = hv / 24 * 100;
				hourAxis.appendChild(E('span', {
					'style': 'position:absolute;top:0;font-size:.72em;opacity:.6;white-space:nowrap;left:' +
						pct + '%;transform:translateX(' + (hv === 0 ? '0' : hv === 24 ? '-100%' : '-50%') + ')'
				}, String(hv)));
			}

			hourScale.textContent = max > 0 ? fmtBps(yMax) : '';
			hourPeak.textContent = pts
				? ('峰值 ' + pkH + ':00  ↓ ' + fmtBps(hourly[pkH].rx) + ' / ↑ ' + fmtBps(hourly[pkH].tx))
				: '当日暂无采样数据';
			hourTitle.textContent = '全屋分时速率' + (chartDate ? ' · ' + chartDate : '') + '（每小时平均，0–24 时）';
		};

		var hourBox = E('div', { 'class': 'cbi-map', 'style': 'margin-bottom:1.2em' }, [
			E('div', { 'style': 'display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:10px;margin-bottom:.5em' }, [
				hourTitle,
				E('div', { 'style': 'display:flex;gap:14px;align-items:baseline;flex-wrap:wrap' }, [
					E('span', { 'style': 'font-size:.85em' }, [
						E('span', { 'style': 'display:inline-block;width:10px;height:10px;border-radius:2px;background:#2f86d8;margin-right:5px;vertical-align:middle' }),
						'下行'
					]),
					E('span', { 'style': 'font-size:.85em' }, [
						E('span', { 'style': 'display:inline-block;width:10px;height:10px;border-radius:2px;background:#f08c2e;margin-right:5px;vertical-align:middle' }),
						'上行'
					]),
					hourPeak
				])
			]),
			chartWrap,
			hourAxis
		]);

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
			hourBox,
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

				/* 分时折线: 固定画 chartDate 这一天（全部模式取今天）;
				   has 标记该小时是否真有采集, 没采集的点断开而不是画成 0 */
				chartDate = historyDate || ymd(new Date());
				hourly = [];
				for (var z = 0; z < 24; z++) hourly.push({ 'rx': 0, 'tx': 0, 'has': false });
				for (var q = 0; q < hours.length; q++) {
					var hq = hours[q].h || '';
					if (hq.substring(0, 10) !== chartDate) continue;
					var hr = parseInt(hq.substring(11, 13), 10);
					if (!(hr >= 0 && hr < 24)) continue;
					hourly[hr].has = true;
					hourly[hr].rx += Number(hours[q].rx) || 0;
					hourly[hr].tx += Number(hours[q].tx) || 0;
				}
				/* CSV 存 KiB: KiB×1024×8÷3600 = 该小时平均 bps */
				for (var u = 0; u < 24; u++) {
					hourly[u].rx = hourly[u].rx * 1024 * 8 / 3600;
					hourly[u].tx = hourly[u].tx * 1024 * 8 / 3600;
				}
				drawHourly();

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

		drawHourly();
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
