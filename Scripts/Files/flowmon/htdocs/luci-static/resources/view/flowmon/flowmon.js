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

var MAXPTS = 300;  /* 10 分钟窗口, 与采集器 spark.txt 保留条数一致 */

function svgEl(tag, attrs) {
	var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (var k in attrs) el.setAttribute(k, attrs[k]);
	return el;
}

/* 把峰值抬到 1/2/2.5/5/10 x 10^n 的整刻度, 避免曲线贴顶或抖动 */
function niceMax(v) {
	if (!(v > 0)) return 1024;
	var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
	var n = v / e;
	var m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
	return m * e;
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

		/* ---- 全屋速率趋势波形 (SVG, 无外部依赖) ---- */
		var sparkData = [];
		var lastTs = 0;
		var sparkSvg = svgEl('svg', {
			'viewBox': '0 0 800 150',
			'preserveAspectRatio': 'none',
			'style': 'display:block;width:100%;height:150px'
		});
		var sparkPeak = E('span', { 'style': 'opacity:.7;font-size:.85em' }, '');
		var sparkSpan = E('span', { 'style': 'opacity:.55;font-size:.8em' }, '');

		var drawSpark = function () {
			var W = 800, H = 150, PT = 8, PB = 4, HH = H - PT - PB;
			var n = sparkData.length;
			while (sparkSvg.firstChild) sparkSvg.removeChild(sparkSvg.firstChild);

			for (var g = 0; g <= 4; g++) {
				var gy = PT + HH * g / 4;
				sparkSvg.appendChild(svgEl('line', {
					'x1': 0, 'y1': gy, 'x2': W, 'y2': gy,
					'stroke': 'currentColor',
					'stroke-opacity': (g === 4 ? 0.22 : 0.08),
					'stroke-width': 1,
					'vector-effect': 'non-scaling-stroke'
				}));
			}

			if (n < 2) {
				sparkPeak.textContent = n ? ('当前 ↓ ' + fmtBps(sparkData[0].rx) + ' / ↑ ' + fmtBps(sparkData[0].tx)) : '';
				sparkSpan.textContent = n ? '等待更多采样…' : '';
				return;
			}

			var peakRx = 0, peakTx = 0;
			for (var i = 0; i < n; i++) {
				if (sparkData[i].rx > peakRx) peakRx = sparkData[i].rx;
				if (sparkData[i].tx > peakTx) peakTx = sparkData[i].tx;
			}
			var top = niceMax(Math.max(peakRx, peakTx));

			/* 点数不足时铺满整宽, 满窗(300 点)后按固定步长向左滚动 */
			var win = Math.min(n, MAXPTS);
			var xAt = function (i) { return win > 1 ? i / (win - 1) * W : W; };
			var yAt = function (v) { return PT + (1 - Math.min(v / top, 1)) * HH; };
			var base = PT + HH;

			var series = [
				{ k: 'tx', c: '#f08c2e', f: 'rgba(240,140,46,0.15)' },
				{ k: 'rx', c: '#2f86d8', f: 'rgba(47,134,216,0.17)' }
			];

			/* 先铺面积, 再压折线, 避免互相遮挡 */
			for (var s = 0; s < series.length; s++) {
				var dd = '';
				for (var j = 0; j < n; j++)
					dd += (j ? 'L' : 'M') + xAt(j).toFixed(1) + ',' + yAt(sparkData[j][series[s].k]).toFixed(1);
				sparkSvg.appendChild(svgEl('path', {
					'd': dd + 'L' + xAt(n - 1).toFixed(1) + ',' + base + 'L' + xAt(0).toFixed(1) + ',' + base + 'Z',
					'fill': series[s].f, 'stroke': 'none'
				}));
			}
			for (var t = 0; t < series.length; t++) {
				var pd = '';
				for (var m = 0; m < n; m++)
					pd += (m ? 'L' : 'M') + xAt(m).toFixed(1) + ',' + yAt(sparkData[m][series[t].k]).toFixed(1);
				sparkSvg.appendChild(svgEl('path', {
					'd': pd, 'fill': 'none', 'stroke': series[t].c,
					'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
					'vector-effect': 'non-scaling-stroke'
				}));
			}

			sparkPeak.textContent = '窗口峰值 ↓ ' + fmtBps(peakRx) + ' / ↑ ' + fmtBps(peakTx);
			sparkSpan.textContent = '最近 ' + (n * 2 >= 60 ? Math.round(n * 2 / 60) + ' 分钟' : (n * 2) + ' 秒') + '（每 2 秒采样）';
		};

		var sparkBox = E('div', { 'class': 'cbi-map', 'style': 'margin-bottom:1.2em' }, [
			E('div', { 'style': 'display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:10px;margin-bottom:.3em' }, [
				E('h3', { 'style': 'margin:0' }, '全屋实时速率趋势'),
				E('div', { 'style': 'display:flex;gap:14px;align-items:baseline;flex-wrap:wrap' }, [
					E('span', { 'style': 'font-size:.85em' }, [
						E('span', { 'style': 'display:inline-block;width:10px;height:10px;border-radius:2px;background:#2f86d8;margin-right:5px;vertical-align:middle' }),
						'下行'
					]),
					E('span', { 'style': 'font-size:.85em' }, [
						E('span', { 'style': 'display:inline-block;width:10px;height:10px;border-radius:2px;background:#f08c2e;margin-right:5px;vertical-align:middle' }),
						'上行'
					]),
					sparkPeak
				])
			]),
			sparkSvg,
			E('div', { 'style': 'display:flex;justify-content:flex-end;margin-top:2px' }, sparkSpan)
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

		/* 历史范围控件: 日期选择 + 保留天数; 选单日时按小时展示, 选全部时按天展示 */
		var rangeSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '' }, '全部（累计）')
		]);
		var keepSel = E('select', { 'class': 'cbi-input-select' }, [2, 7, 14, 30].map(function (n) {
			return E('option', { 'value': String(n) }, n + ' 天');
		}));
		var usageNote = E('span', { 'style': 'color:#777;font-size:.9em' }, '');
		var rangesNote = E('span', { 'style': 'color:#777;font-size:.9em' }, '历史数据保留 2 天');

		var controls = E('div', {
			'style': 'display:flex;gap:.6em;align-items:center;flex-wrap:wrap;margin-bottom:1em'
		}, [
			E('label', {}, '历史范围'), rangeSel,
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
			sparkBox,
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

		/* 可用日期列表 + 当前保留设置（日期降序，最新在前） */
		var loadDates = function () {
			return fs.exec('/usr/libexec/flowmon-panel', ['dates']).then(function (res) {
				var d;
				try { d = JSON.parse(res.stdout); } catch (e) { return; }
				if (!d) return;
				var days = (d.days || []).slice().sort().reverse();
				while (rangeSel.firstChild) rangeSel.removeChild(rangeSel.firstChild);
				rangeSel.appendChild(E('option', { 'value': '' }, '全部（累计 ' + days.length + ' 天）'));
				for (var i = 0; i < days.length; i++) {
					rangeSel.appendChild(E('option', { 'value': days[i] }, days[i]));
				}
				rangeSel.value = historyDate;
				/* 保留天数可能被 SSH 改成 1/3/60/90 这类非预设值，重建时补进去，
				   否则 <select> 会静默显示成第一个选项，误导用户 */
				while (keepSel.firstChild) keepSel.removeChild(keepSel.firstChild);
				var keepOpts = [2, 7, 14, 30], cur = Number(d.retention) || 2;
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

		rangeSel.addEventListener('change', function () {
			historyDate = rangeSel.value || '';
			loadHistory();
		});

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

		/* 页面加载时先从采集器拉一次环形缓冲, 刷新/换设备都能看到历史波形 */
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

		drawSpark();
		loadSeries();
		loadDates().then(loadHistory);
		poll.add(loadHistory, 60);
		/* 跨天后新日期要出现在下拉框里，每小时重扫一次文件列表 */
		poll.add(loadDates, 3600);

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
