/* SPDX-License-Identifier: GPL-3.0-only
 *
 * 状态页概览卡片：显示各 cpufreq policy 的当前频率、最大频率与 governor。
 * 数据全部来自 sysfs，load() 任一步失败都由 resolveDefault 兜住，
 * 读不到节点时 render 返回 null，卡片不渲染（不影响其余概览内容）。
 */

'use strict';
'require baseclass';
'require fs';

var ROOT = '/sys/devices/system/cpu/cpufreq';

function txt(path) {
	return L.resolveDefault(fs.read(path), null).then(function(v) {
		return (v == null) ? null : v.trim();
	}).catch(function() {
		return null;
	});
}

function int(path) {
	return txt(path).then(function(v) {
		var n = parseInt(v, 10);
		return isFinite(n) ? n : null;
	});
}

function mhz(khz) {
	if (khz == null)
		return '—';

	return (khz / 1000).toFixed(0) + ' MHz';
}

function coreLabel(list) {
	if (!list)
		return '?';

	var parts = list.split(/\s+/).filter(Boolean);

	if (parts.length === 0)
		return '?';
	if (parts.length === 1)
		return parts[0];

	return parts[0] + '–' + parts[parts.length - 1];
}

return baseclass.extend({
	title: _('CPU Frequency'),

	load: function() {
		return L.resolveDefault(fs.list(ROOT), []).then(function(entries) {
			return (entries || []).filter(function(e) {
				return e.type === 'directory' && /^policy\d+$/.test(e.name);
			}).sort(function(a, b) {
				return parseInt(a.name.slice(6), 10) - parseInt(b.name.slice(6), 10);
			});
		}).then(function(dirs) {
			return Promise.all(dirs.map(function(d) {
				var base = ROOT + '/' + d.name;

				return Promise.all([
					int(base + '/scaling_cur_freq'),
					int(base + '/cpuinfo_max_freq'),
					int(base + '/cpuinfo_min_freq'),
					txt(base + '/scaling_governor'),
					txt(base + '/affected_cpus')
				]).then(function(r) {
					return { cur: r[0], max: r[1], min: r[2], gov: r[3], cpus: r[4] };
				});
			}));
		}).then(function(rows) {
			return rows.filter(function(r) { return r.cur != null; });
		});
	},

	render: function(policies) {
		if (!policies || !policies.length)
			return null;

		var body = policies.map(function(p) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '32%' }, 'CPU ' + coreLabel(p.cpus)),
				E('td', { 'class': 'td left' }, [
					E('strong', {}, mhz(p.cur)),
					p.max != null ? E('span', { 'style': 'opacity:.6' }, '\u2003/ ' + mhz(p.max)) : ''
				]),
				E('td', { 'class': 'td left' }, p.gov || '—')
			]);
		});

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Core')),
				E('th', { 'class': 'th' }, _('Current / Max')),
				E('th', { 'class': 'th' }, _('Governor'))
			]),
			E('tbody', {}, body)
		]);
	}
});
