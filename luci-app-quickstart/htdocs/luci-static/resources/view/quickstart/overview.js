'use strict';
'require view';
'require rpc';
'require fs';

/*
 * iStore-style start page (read-only).
 *
 * Same contract as v1: no fs.exec, no uci writes, no ubus setters.
 * Every rpc result goes through L.resolveDefault(), so a missing backend
 * degrades a single tile instead of blanking the page.
 */

var callBoard = rpc.declare({ object: 'system', method: 'board' });
var callInfo = rpc.declare({ object: 'system', method: 'info' });
var callIfaces = rpc.declare({ object: 'network.interface', method: 'dump' });
var callDevices = rpc.declare({ object: 'iwinfo', method: 'devices' });
var callWifiInfo = rpc.declare({ object: 'iwinfo', method: 'info', params: [ 'device' ] });
var callAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ] });
var callServices = rpc.declare({ object: 'service', method: 'list', params: [ 'name' ], expect: { '': {} } });
var callMounts = rpc.declare({ object: 'luci', method: 'getMountPoints' });

var APPS = [
	{ icon: '🛰', name: 'PassWall', service: 'passwall', url: 'admin/services/passwall' },
	{ icon: '🕳', name: 'honk', service: 'honk', url: null },
	{ icon: '🛡', name: '应用过滤', service: 'appfilter', url: null },
	{ icon: '⌨', name: '终端', service: 'ttyd', url: 'admin/services/ttyd' },
	{ icon: '🔌', name: 'UPnP', service: 'miniupnpd', url: 'admin/services/upnp' },
	{ icon: '⚙', name: '系统设置', service: null, url: 'admin/system/system' }
];

function injectCss() {
	if (document.querySelector('link[data-qs-style]'))
		return;

	document.head.appendChild(E('link', {
		'rel': 'stylesheet',
		'href': L.resource('view/quickstart/overview.css'),
		'data-qs-style': '1'
	}));
}

function bytes(n) {
	if (n == null || isNaN(n))
		return '—';

	var unit = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], i = 0;

	while (n >= 1024 && i < unit.length - 1) {
		n /= 1024;
		i++;
	}

	return (i > 0 ? n.toFixed(1) : String(n)) + ' ' + unit[i];
}

function duration(sec) {
	if (sec == null || isNaN(sec))
		return '—';

	var d = Math.floor(sec / 86400),
	    h = Math.floor(sec % 86400 / 3600),
	    m = Math.floor(sec % 3600 / 60);

	return (d > 0 ? d + '天 ' : '') + h + '小时 ' + m + '分';
}

function tint(percent) {
	return percent >= 85 ? '#c25b56' : (percent >= 65 ? '#d99b3d' : '#4a9e5c');
}

function ring(percent, value, label, sub) {
	var safe = Math.max(0, Math.min(100, percent || 0)),
	    radius = 30,
	    circumference = 2 * Math.PI * radius,
	    offset = circumference * (1 - safe / 100);

	return E('div', { 'class': 'qs-metric' }, [
		E('svg', { 'width': '78', 'height': '78', 'viewBox': '0 0 78 78' }, [
			E('circle', { 'cx': '39', 'cy': '39', 'r': String(radius), 'fill': 'none',
				'stroke': 'currentColor', 'stroke-opacity': '.14', 'stroke-width': '7' }),
			E('circle', { 'cx': '39', 'cy': '39', 'r': String(radius), 'fill': 'none',
				'stroke': tint(safe), 'stroke-width': '7', 'stroke-linecap': 'round',
				'stroke-dasharray': String(circumference), 'stroke-dashoffset': String(offset),
				'transform': 'rotate(-90 39 39)' }),
			E('text', { 'x': '39', 'y': '43', 'text-anchor': 'middle',
				'font-size': '14', 'font-weight': '600', 'fill': 'currentColor' }, Math.round(safe) + '%')
		]),
		E('div', { 'class': 'qs-metric-text' }, [
			E('strong', {}, value),
			E('span', {}, label),
			sub ? E('em', {}, sub) : ''
		])
	]);
}

function kv(label, value) {
	return E('div', { 'class': 'qs-kv' }, [
		E('span', {}, label),
		E('span', {}, value)
	]);
}

function card(title, count, body) {
	return E('section', { 'class': 'qs-card' }, [
		E('header', {}, [
			E('span', {}, title),
			E('span', { 'class': 'qs-count' }, count || '')
		]),
		E('div', {}, body)
	]);
}

function serviceState(services, name) {
	var entry = services ? services[name] : null;

	if (!entry || !entry.instances)
		return null;

	var running = false;

	Object.keys(entry.instances).forEach(function(key) {
		if (entry.instances[key].running)
			running = true;
	});

	return running;
}

function interfaceSummary(ifaces, name) {
	var found = ifaces.filter(function(iface) { return iface.interface === name; })[0];

	if (!found)
		return { state: '未配置', detail: '' };

	var address = '';

	(found['ipv4-address'] || []).forEach(function(entry) {
		if (!address)
			address = entry.address + '/' + entry.mask;
	});

	if (!address) {
		(found['ipv6-address'] || []).forEach(function(entry) {
			if (!address && entry.address && entry.address.indexOf('fe80') !== 0)
				address = entry.address + '/' + entry.mask;
		});
	}

	return {
		state: found.up ? '已连接' : '未连接',
		detail: address + (found.device ? ' · ' + found.device : '') + (found.proto ? ' · ' + found.proto : '')
	};
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callBoard(), {}),
			L.resolveDefault(callInfo(), {}),
			L.resolveDefault(callIfaces(), {}),
			L.resolveDefault(callDevices(), []),
			L.resolveDefault(callServices(), {}),
			L.resolveDefault(callMounts(), []),
			L.resolveDefault(fs.read('/proc/cpuinfo'), '')
		]).then(function(result) {
			var devices = Array.isArray(result[3]) ? result[3] : [];

			return Promise.all(devices.map(function(device) {
				return Promise.all([
					L.resolveDefault(callWifiInfo(device), null),
					L.resolveDefault(callAssoc(device), null)
				]).then(function(info) {
					return { device: device, info: info[0], assoc: info[1] };
				});
			})).then(function(wifi) {
				result.push(wifi);
				return result;
			});
		});
	},

	render: function(result) {
		injectCss();

		var board = result[0] || {},
		    info = result[1] || {},
		    ifaces = (result[2] || {}).interface || [],
		    services = result[4] || {},
		    mounts = Array.isArray(result[5]) ? result[5] : [],
		    cpuinfo = result[6] || '',
		    wifi = result[7] || [];

		var release = board.release || {},
		    memory = info.memory || {},
		    load = info.load || [],
		    cores = (cpuinfo.match(/^processor\s*:/gm) || []).length || 1;

		var usedMem = (memory.total && memory.available != null) ? memory.total - memory.available : null;
		var memPercent = (usedMem && memory.total) ? usedMem / memory.total * 100 : 0;
		var loadPercent = load.length ? load[0] / cores * 100 : 0;

		var rootMount = mounts.filter(function(mount) {
			return mount.mount_point === '/overlay';
		})[0] || mounts.filter(function(mount) {
			return mount.mount_point === '/';
		})[0] || null;

		var diskPercent = (rootMount && rootMount.size) ? (rootMount.used || 0) / rootMount.size * 100 : 0;

		var wan = interfaceSummary(ifaces, 'wan'),
		    wan6 = interfaceSummary(ifaces, 'wan6'),
		    lan = interfaceSummary(ifaces, 'lan');

		var wifiRows = wifi.map(function(entry) {
			var w = entry.info || {},
			    clients = (entry.assoc && entry.assoc.results) ? entry.assoc.results.length : null;

			return kv(entry.device,
				(w.ssid || '—') +
				(w.channel ? ' · ' + w.channel + 'ch' : '') +
				(w.frequency ? ' · ' + w.frequency + 'M' : '') +
				(clients != null ? ' · ' + clients + '台' : ''));
		});

		if (!wifiRows.length)
			wifiRows = [ kv('无线', '未检测到射频') ];

		var wifiClients = 0;

		wifi.forEach(function(entry) {
			if (entry.assoc && entry.assoc.results)
				wifiClients += entry.assoc.results.length;
		});

		var apps = APPS.map(function(app) {
			var running = app.service ? serviceState(services, app.service) : true,
			    disabled = (running === null);

			var body = [
				E('div', { 'class': 'qs-app-icon' }, [
					E('span', {}, app.icon),
					app.service ? E('i', { 'class': 'qs-status' + (running === true ? '' : ' stop') }) : ''
				]),
				E('div', { 'class': 'qs-app-name' }, app.name)
			];

			if (app.url && !disabled)
				return E('a', { 'class': 'qs-app', 'href': L.url(app.url) }, body);

			return E('div', { 'class': 'qs-app' + (disabled ? ' off' : ''), 'title': disabled ? '未安装' : '' }, body);
		});

		return E('div', { 'class': 'qs' }, [
			E('div', { 'class': 'qs-hero' }, [
				E('div', { 'class': 'qs-hero-icon' }, '🛰'),
				E('div', { 'class': 'qs-hero-main' }, [
					E('h2', {}, board.model || 'OpenWrt'),
					E('p', { 'class': 'qs-hero-sub' },
						(release.description || release.version || '') +
						' · 内核 ' + (board.kernel || '—') +
						' · 已运行 ' + duration(info.uptime))
				]),
				E('span', { 'class': 'qs-pill' }, [
					E('i', { 'class': 'qs-dot' + (wan.state === '已连接' ? '' : ' off') }),
					wan.state === '已连接' ? '外网已连接' : '外网未连接'
				])
			]),

			E('div', { 'class': 'qs-metrics' }, [
				ring(loadPercent, load.length ? load[0].toFixed(2) : '—', 'CPU 负载', cores + ' 核 · 1 分钟'),
				ring(memPercent, bytes(usedMem), '内存占用', bytes(memory.total)),
				ring(diskPercent, bytes(rootMount ? rootMount.used : null), '存储占用',
					rootMount ? bytes(rootMount.size) + ' 可用' : '—')
			]),

			E('div', { 'class': 'qs-grid' }, [
				card('网络', wan.state, [
					kv('WAN', wan.state),
					kv('WAN 地址', wan.detail || '—'),
					kv('IPv6', wan6.detail || wan6.state),
					kv('LAN', lan.detail || lan.state)
				]),
				card('无线', wifiClients + ' 台在线', wifiRows)
			]),

			E('div', { 'class': 'qs-grid' }, [
				card('应用', '', [ E('div', { 'class': 'qs-apps' }, apps) ]),
				card('系统', '', [
					kv('固件', release.distribution ? release.distribution + ' ' + (release.version || '') : (release.description || '—')),
					kv('内核', board.kernel || '—'),
					kv('架构', board.system || '—'),
					kv('主机名', board.hostname || '—'),
					kv('负载 5/15', load.length > 1 ? load[1].toFixed(2) + ' / ' + load[2].toFixed(2) : '—')
				])
			]),

			E('p', { 'class': 'qs-foot' }, '只读总览 · 修改请进入对应页面')
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
