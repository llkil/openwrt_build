'use strict';
'require view';
'require rpc';

/*
 * Quick Start - read-only dashboard.
 *
 * Design rules:
 *  - No fs.exec, no uci writes, no ubus setters. Every action is a link
 *    to the canonical LuCI page, so this view can never break the device.
 *  - Every rpc call goes through L.resolveDefault(), a missing backend
 *    degrades to "-" instead of a JS exception.
 */

var callBoard = rpc.declare({ object: 'system', method: 'board' });
var callInfo = rpc.declare({ object: 'system', method: 'info' });
var callIfaces = rpc.declare({ object: 'network.interface', method: 'dump' });
var callDevices = rpc.declare({ object: 'iwinfo', method: 'devices' });
var callWifiInfo = rpc.declare({ object: 'iwinfo', method: 'info', params: [ 'device' ] });
var callAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ] });
var callServices = rpc.declare({ object: 'service', method: 'list', params: [ 'name' ], expect: { '': {} } });
var callMounts = rpc.declare({ object: 'luci', method: 'getMountPoints' });

/* LuCI 页面路由，只放已确认存在的三个，避免点出 404 */
var LINKS = [
	{ service: 'passwall',  label: 'PassWall', url: 'admin/services/passwall' },
	{ service: 'ttyd',      label: 'ttyd 终端', url: 'admin/services/ttyd' },
	{ service: 'miniupnpd', label: 'UPnP', url: 'admin/services/upnp' }
];

var WATCH = [
	{ service: 'passwall',  label: 'PassWall 透明代理' },
	{ service: 'honk',      label: 'honk 代理核心' },
	{ service: 'appfilter', label: 'OAF 应用过滤' },
	{ service: 'ttyd',      label: 'ttyd 终端' },
	{ service: 'miniupnpd', label: 'UPnP 端口映射' }
];

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

	return (d > 0 ? d + ' 天 ' : '') + h + ' 小时 ' + m + ' 分';
}

function bar(used, total) {
	if (!total)
		return E('span', {}, '—');

	var percent = Math.min(100, Math.round(used / total * 100));

	return E('span', {}, [
		E('span', { 'style': 'display:inline-block;width:120px;height:8px;background:var(--border-color-medium,rgba(127,127,127,.3));border-radius:4px;overflow:hidden;vertical-align:middle;margin-right:8px' },
			E('span', { 'style': 'display:block;height:100%;width:%d%%;background:%s'.format(percent, percent > 85 ? '#d9534f' : (percent > 65 ? '#e8a33d' : '#4a9e5c')) })),
		E('span', {}, '%d%% (%s / %s)'.format(percent, bytes(used), bytes(total)))
	]);
}

function card(title, rows, hint) {
	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, title),
		E('div', { 'class': 'cbi-section-node' },
			E('table', { 'class': 'table' },
				E('tbody', {}, rows))),
		hint ? E('p', { 'style': 'opacity:.65;font-size:90%;margin:.4rem 0 0' }, hint) : ''
	]);
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td', 'style': 'width:32%;white-space:nowrap;opacity:.8' }, label),
		E('td', { 'class': 'td' }, value)
	]);
}

function interfaceRow(iface, label) {
	if (!iface)
		return row(label, E('em', {}, '未配置'));

	var addresses = [];

	(iface['ipv4-address'] || []).forEach(function(entry) {
		addresses.push(entry.address + '/' + entry.mask);
	});

	(iface['ipv6-address'] || []).forEach(function(entry) {
		if (entry.address && entry.address.indexOf('fe80') !== 0)
			addresses.push(entry.address + '/' + entry.mask);
	});

	var state = iface.up ? '已连接' : '未连接';

	return row(label, E('span', {}, [
		E('strong', {}, state),
		addresses.length ? E('span', {}, ' · ' + addresses.join(', ')) : '',
		iface.device ? E('span', { 'style': 'opacity:.65' }, ' · ' + iface.device + (iface.proto ? ' (' + iface.proto + ')' : '')) : ''
	]));
}

function serviceRow(entry, services) {
	var state = services[entry.service],
	    running = false,
	    enabled = false;

	if (state && state.instances) {
		Object.keys(state.instances).forEach(function(name) {
			var instance = state.instances[name];
			if (instance.running)
				running = true;
			if (instance.enabled)
				enabled = true;
		});
	}

	var badge = E('span', {
		'style': 'display:inline-block;padding:1px 8px;border-radius:10px;font-size:85%;' +
		         (running ? 'background:rgba(74,158,92,.15);color:#3d8a4d' : 'background:rgba(127,127,127,.15);opacity:.8')
	}, running ? '运行中' : (state ? '已停止' : '未安装'));

	var cells = [ E('td', { 'class': 'td' }, entry.label), E('td', { 'class': 'td' }, badge) ];

	var link = LINKS.find(function(item) { return item.service === entry.service; });

	cells.push(E('td', { 'class': 'td', 'style': 'text-align:right' },
		(link && state) ? E('a', { 'class': 'btn cbi-button cbi-button-apply', 'href': L.url(link.url) }, '进入') : ''));

	return E('tr', { 'class': 'tr' }, cells);
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callBoard(), {}),
			L.resolveDefault(callInfo(), {}),
			L.resolveDefault(callIfaces(), {}),
			L.resolveDefault(callDevices(), []),
			L.resolveDefault(callServices(), {}),
			L.resolveDefault(callMounts(), [])
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
		var board = result[0] || {},
		    info = result[1] || {},
		    ifaces = (result[2] || {}).interface || [],
		    services = result[4] || {},
		    mounts = Array.isArray(result[5]) ? result[5] : [],
		    wifi = result[6] || [];

		var release = board.release || {},
		    memory = info.memory || {},
		    used = (memory.total && memory.available != null) ? (memory.total - memory.available) : null;

		var byName = {};

		ifaces.forEach(function(iface) {
			if (iface.interface)
				byName[iface.interface] = iface;
		});

		var wan = byName.wan || byName.wan6 || null,
		    lan = byName.lan || null;

		var rootMount = mounts.filter(function(mount) {
			return mount.mount_point === '/overlay' || mount.mount_point === '/';
		})[0] || null;

		var wifiRows = wifi.map(function(entry) {
			var w = entry.info || {},
			    clients = (entry.assoc && entry.assoc.results) ? entry.assoc.results.length : null;

			return row(entry.device,
				E('span', {}, [
					E('strong', {}, w.ssid || '—'),
					w.channel ? E('span', {}, ' · 信道 ' + w.channel + (w.frequency ? ' (' + w.frequency + ' MHz)' : '')) : '',
					(w.txpower != null) ? E('span', { 'style': 'opacity:.65' }, ' · ' + w.txpower + ' dBm') : '',
					(clients != null) ? E('span', { 'style': 'opacity:.65' }, ' · ' + clients + ' 个客户端') : ''
				]));
		});

		if (!wifiRows.length)
			wifiRows = [ row('无线', E('em', {}, '未检测到无线接口')) ];

		return E('div', {}, [
			E('h2', {}, '快速设置'),
			E('p', { 'style': 'opacity:.7;margin-top:-.4rem' },
				'只读总览。需要修改请点对应卡片里的入口，这里不会写入任何配置。'),

			card('系统', [
				row('设备型号', board.model || '—'),
				row('固件版本', release.description || release.version || '—'),
				row('内核 / 架构', (board.kernel || '—') + ' / ' + (board.system || '—')),
				row('主机名', board.hostname || '—'),
				row('运行时长', duration(info.uptime)),
				row('负载 (1/5/15 分钟)', (info.load || []).map(function(n) { return n.toFixed(2); }).join(' / ') || '—'),
				row('内存占用', bar(used, memory.total)),
				rootMount ? row('存储 ' + rootMount.mount_point, bar(rootMount.used || 0, rootMount.size || 0)) : ''
			]),

			card('网络', [
				interfaceRow(wan, 'WAN'),
				interfaceRow(lan, 'LAN')
			], '详细配置见 网络 → 接口。'),

			card('无线', wifiRows, '本机为闭源 MTK 驱动，此处只读取 iwinfo 结果，不提供修改入口；改无线请用 网络 → 无线。'),

			card('插件状态', WATCH.map(function(entry) {
				return serviceRow(entry, services);
			}), '显示的是服务实例状态；装了但未启用的会显示“已停止”。')
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
