'use strict';
'require view';
'require poll';
'require rpc';
'require ui';

var callNpuStatus = rpc.declare({ object: 'luci.airoha_npu', method: 'getStatus' });
var callPpeEntries = rpc.declare({ object: 'luci.airoha_npu', method: 'getPpeEntries' });
var callTokenInfo = rpc.declare({ object: 'luci.airoha_npu', method: 'getTokenInfo' });
var callFrameEngine = rpc.declare({ object: 'luci.airoha_npu', method: 'getFrameEngine' });
var callSetGovernor = rpc.declare({ object: 'luci.airoha_npu', method: 'setGovernor', params: ['governor'] });
var callSetMaxFreq = rpc.declare({ object: 'luci.airoha_npu', method: 'setMaxFreq', params: ['freq'] });
var callSetOverclock = rpc.declare({ object: 'luci.airoha_npu', method: 'setOverclock', params: ['freq_mhz'] });

/* ── Theme-adaptive CSS ── */
var themeCSS = '\
.soc-card{background:var(--soc-card-bg);border:1px solid var(--soc-border);border-radius:8px;padding:14px;transition:border-color .3s}\
.soc-card-accent{border-left-width:3px;border-left-style:solid}\
.soc-muted{color:var(--soc-muted)}\
.soc-text{color:var(--soc-text)}\
.soc-label{font-size:11px;color:var(--soc-muted)}\
.soc-bar-track{background:var(--soc-bar-track);border-radius:4px;overflow:hidden}\
.soc-pse-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px}\
.soc-pse-cell{background:var(--soc-card-bg);border:1px solid var(--soc-border);border-radius:5px;padding:6px 8px;font-size:12px}\
.soc-band-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}\
.soc-gdm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px}\
.soc-cdm-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:10px}\
';

function isDarkMode() {
	// Sample multiple elements to get a reliable reading
	var els = [document.body, document.querySelector('.main-content'), document.querySelector('#maincontent'), document.querySelector('.cbi-map')];
	for (var i = 0; i < els.length; i++) {
		if (!els[i]) continue;
		var bg = window.getComputedStyle(els[i]).backgroundColor;
		var m = bg.match(/\d+/g);
		if (m && m.length >= 3) {
			var a = m.length >= 4 ? parseFloat(m[3]) : 1;
			if (a < 0.1) continue; // transparent, skip
			var lum = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
			return lum < 128;
		}
	}
	// Fallback: check if any known dark theme stylesheet is loaded
	var sheets = document.querySelectorAll('link[href*="dark"], link[href*="glass"]');
	return sheets.length > 0;
}

var _lastDarkMode = null;

function injectCSS() {
	var el = document.getElementById('soc-theme-css');
	if (!el) { el = document.createElement('style'); el.id = 'soc-theme-css'; document.head.appendChild(el); }

	var dark = isDarkMode();
	if (dark === _lastDarkMode) return;
	_lastDarkMode = dark;

	var vars = dark
		? ':root{--soc-card-bg:#1e1e1e;--soc-border:#333;--soc-muted:#999;--soc-text:#e0e0e0;--soc-bar-track:#333}'
		: ':root{--soc-card-bg:#fff;--soc-border:#d0d0d0;--soc-muted:#666;--soc-text:#222;--soc-bar-track:#e0e0e0}';
	el.textContent = themeCSS + vars;
}

/* ── Helpers ── */
var bandInfo = [
	{ name: '2.4 GHz', accent: '#ff9800' },
	{ name: '5 GHz', accent: '#2196f3' },
	{ name: '6 GHz', accent: '#9c27b0' }
];

var psePortMap = [
	{ name: 'CDM1', label: 'CPU DMA 1',   color: '#607d8b' }, // P0
	{ name: 'GDM1', label: 'Switch 1G',   color: '#ff9800' }, // P1
	{ name: 'GDM3', label: 'GDM3',        color: '#607d8b' }, // P3
	{ name: 'PPE1', label: 'PPE Eng 1',   color: '#2196f3' }, // P4
	{ name: 'CDM3', label: 'CDM3',        color: '#607d8b' }, // P6
	{ name: 'PPE2', label: 'PPE Eng 2',   color: '#2196f3' },  // P8
	{ name: 'GDM2', label: '2.5G Port',     color: '#4caf50' }, //P2
	{ name: 'CDM2', label: 'CPU DMA 2',   color: '#607d8b' }, //P5
];


function fmtFreq(khz) { return (!khz || khz === 0) ? 'N/A' : (khz / 1000).toFixed(0) + ' MHz'; }
function fmtK(n) {
	if (!n || n === 0) return '0';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return n.toString();
}

function calcTotalMem(regions) {
	var t = 0;
	(regions || []).forEach(function(r) {
		var m = (r.size || '').match(/(\d+)\s*(KiB|MiB|GiB)/i);
		if (m) { var s = parseInt(m[1]); var u = m[2][0].toUpperCase(); t += u === 'G' ? s*1048576 : u === 'M' ? s*1024 : s; }
	});
	return t >= 1024 ? (t/1024).toFixed(0)+' MiB' : t+' KiB';
}

function tokenHealth(c, s) {
	if (!s) return { text: 'N/A', color: '#888' };
	var p = c/s*100;
	return p < 50 ? { text:'Healthy', color:'#4caf50' } : p < 80 ? { text:'Warning', color:'#ff9800' } : { text:'Critical', color:'#f44336' };
}

function getBandStats(ti, b) {
	var c = Array.isArray(ti.station_counts) ? ti.station_counts : [];
	for (var i=0;i<c.length;i++) if (c[i].band===b) return c[i];
	return { band:b, count:0, tx_packets:0, tx_retries:0 };
}

function getTxQueue(ti, b) {
	var q = Array.isArray(ti.tx_queues) ? ti.tx_queues : [];
	for (var i=0;i<q.length;i++) if (q[i].band===b) return q[i];
	return null;
}

function bandHealth(s) {
	if (!s || s.count===0) return { text:'No clients', color:'#888' };
	if (!s.tx_packets) return { text:'Idle', color:'#888' };
	var r = s.tx_retries/(s.tx_packets+s.tx_retries);
	return r>0.5 ? {text:'Poor',color:'#f44336'} : r>0.2 ? {text:'Fair',color:'#ff9800'} : {text:'Good',color:'#4caf50'};
}

function retryPct(s) {
	if (!s || !s.tx_packets) return '-';
	return (s.tx_retries/(s.tx_packets+s.tx_retries)*100).toFixed(1)+'%';
}

/* ── Mini Band Chip (compact for FE diagram) ── */
function renderBandChip(band, txQ, stats) {
	var info = bandInfo[band] || { name: 'Band '+band, accent: '#888' };
	var id = 'band-'+band;
	var h = bandHealth(stats);
	var type = txQ ? txQ.type : '?';
	var rp = retryPct(stats);

	return E('div', { 'id': id, 'style': 'background:var(--soc-card-bg);border:1px solid var(--soc-border);border-left:2px solid '+info.accent+';border-radius:6px;padding:10px 12px' }, [
		E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' }, [
			E('span', { 'class': 'soc-text', 'style': 'font-size:13px;font-weight:bold' }, info.name),
			E('span', { 'style': 'background:'+(type==='npu'?'#1565c0':'#666')+';color:#fff;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:600' }, type.toUpperCase())
		]),
		E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;font-size:12px' }, [
			E('div', { 'id': id+'-health', 'style': 'display:flex;align-items:center;gap:4px' }, [
				E('span', { 'style': 'width:7px;height:7px;border-radius:50%;background:'+h.color+';display:inline-block' }),
				E('span', { 'style': 'color:'+h.color+';font-weight:500' }, h.text)
			]),
			E('span', { 'id': id+'-clients', 'class': 'soc-muted' }, stats.count + ' sta'),
			(stats.tx_packets > 0) ? E('span', { 'id': id+'-retries', 'class': 'soc-muted' }, rp) : E('span')
		])
	]);
}

function updateBandChip(band, stats) {
	var id = 'band-'+band, h = bandHealth(stats);
	var el = document.getElementById(id+'-health');
	if (el) { el.innerHTML = ''; el.appendChild(E('span',{'style':'width:6px;height:6px;border-radius:50%;background:'+h.color+';display:inline-block'})); el.appendChild(E('span',{'style':'color:'+h.color+';font-weight:500;font-size:11px'},h.text)); }
	var cl = document.getElementById(id+'-clients');
	if (cl) cl.textContent = stats.count+'sta';
	var re = document.getElementById(id+'-retries');
	if (re) { var rp2 = retryPct(stats); re.textContent = rp2; }
}

/* ── Frame Engine Diagram (with WiFi bands, NPU, PPE flows) ── */
/* ── Frame Engine Diagram (Optimized for 040g-md) ── */
function renderFeDiagram(fe, ti, st) {
	if (!fe || fe.error) return E('div', { 'class': 'soc-muted' }, 'devmem not available on this build');
	ti = ti || {}; st = st || {};

	var ports = Array.isArray(fe.pse_ports) ? fe.pse_ports : [];
	// Helper: GDM card
	function gdmCard(key, name, label, color, pse) {
		var d = fe[key] || {};
		var active = d.tx > 0 || d.rx > 0;
		return E('div', { 'class': 'soc-card soc-card-accent', 'style': 'border-left-color:'+color + (active?';border-color:'+color:'') }, [
			E('div', { 'style': 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px' }, [
				E('span', { 'style': 'font-weight:bold;color:'+color+';font-size:14px' }, name),
				E('span', { 'class': 'soc-label' }, pse)
			]),
			E('div', { 'class': 'soc-label', 'style': 'margin-bottom:6px' }, label),
			E('div', { 'style': 'display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px' }, [
				E('span', { 'class': 'soc-muted' }, 'TX'), E('span', { 'class': 'soc-text', 'style': 'text-align:right' }, fmtK(d.tx)),
				E('span', { 'class': 'soc-muted' }, 'RX'), E('span', { 'class': 'soc-text', 'style': 'text-align:right' }, fmtK(d.rx))
			])
		]);
	}

	// Helper: CDM offload bar
	function cdmCard(key, name, label, pse) {
		var d = fe[key] || {};
		var total = (d.rx_cpu||0) + (d.rx_hwf||0);
		var pct = total > 0 ? ((d.rx_hwf/total)*100).toFixed(1) : '0.0';
		var barCol = total===0 ? 'var(--soc-border)' : parseFloat(pct)>80 ? '#4caf50' : parseFloat(pct)>50 ? '#ff9800' : '#f44336';
		return E('div', { 'class': 'soc-card' }, [
			E('div', { 'style': 'display:flex;justify-content:space-between;margin-bottom:4px' }, [
				E('span', { 'style': 'font-weight:bold;color:#607d8b;font-size:13px' }, name+' '+pse),
				E('span', { 'class': 'soc-label' }, label)
			]),
			E('div', { 'class': 'soc-text', 'style': 'font-size:12px;margin-bottom:4px' }, 'HW Offload: '+pct+'%'),
			E('div', { 'class': 'soc-bar-track', 'style': 'height:6px' }, [
				E('div', { 'style': 'background:'+barCol+';height:100%;width:'+pct+'%;transition:width .5s;border-radius:4px' })
			]),
			E('div', { 'style': 'display:flex;justify-content:space-between;font-size:11px;margin-top:4px' }, [
				E('span', { 'class': 'soc-muted' }, 'CPU: '+fmtK(d.rx_cpu||0)),
				E('span', { 'class': 'soc-muted' }, 'HWF: '+fmtK(d.rx_hwf||0)),
				E('span', { 'class': 'soc-muted' }, 'TX: '+fmtK(d.tx||0))
			])
		]);
	}

	// NPU indicator
	var npuActive = st.npu_loaded;
	var npuCard = E('div', { 'class': 'soc-card', 'style': 'border-color:'+(npuActive?'#00bcd4':'var(--soc-border)') }, [
		E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px' }, [
			E('span', { 'style': 'font-weight:bold;color:#00bcd4;font-size:14px' }, 'NPU'),
			E('span', { 'style': 'background:'+(npuActive?'#00695c':'#666')+';color:#fff;padding:1px 7px;border-radius:3px;font-size:10px;font-weight:600' }, npuActive ? 'ACTIVE' : 'OFF')
		]),
		E('div', { 'class': 'soc-label', 'style': 'margin-bottom:4px' }, '4x RISC-V via PCIe RAM'),
		E('div', { 'style': 'font-size:11px' }, [
			E('span', { 'class': 'soc-muted' }, 'Manages: '),
			E('span', { 'class': 'soc-text', 'style': 'font-size:11px' }, 'PPE init, WDMA rings, flow stats')
		])
	]);

	// PPE engines with flow count
	var ppeCard = E('div', { 'class': 'soc-card', 'style': 'border-color:#2196f3' }, [
		E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px' }, [
			E('span', { 'style': 'font-weight:bold;color:#2196f3;font-size:14px' }, 'PPE Engines'),
			E('span', { 'class': 'soc-label' }, 'P4 + P4')
		]),
		E('div', { 'style': 'display:flex;gap:16px;font-size:12px' }, [
			E('span', {}, [
				E('span', { 'class': 'soc-muted' }, 'Bound '),
				E('span', { 'class': 'soc-text', 'style': 'font-weight:bold', 'id': 'fe-ppe-bound' }, (st.offload_bound||0).toString())
			]),
			E('span', {}, [
				E('span', { 'class': 'soc-muted' }, 'Total '),
				E('span', { 'class': 'soc-text', 'id': 'fe-ppe-total' }, (st.offload_total||0).toString())
			])
		])
	]);

	// PSE buffer
	var pseT = (fe.pse_used||0)+(fe.pse_free||0);
	var pseP = pseT>0 ? ((fe.pse_used/pseT)*100).toFixed(1) : '0';
	var pseCol = parseFloat(pseP)>80?'#f44336':parseFloat(pseP)>50?'#ff9800':'#4caf50';

	// PSE port cells (skip P7 since it's shown in CDM4/WiFi section)
	var portCells = ports.filter(function(p){ return p.port !== 7; }).map(function(p) {
		var info = psePortMap[p.port] || { name:'P'+p.port, label:'?', color:'#666' };
		var drop = p.drops > 0;
		return E('div', { 'class': 'soc-pse-cell', 'style': drop ? 'border-color:#f44336' : '' }, [
			E('div', { 'style': 'font-weight:600;color:'+info.color+';font-size:11px' }, 'P'+p.port+' '+info.name),
			E('div', { 'style': 'display:flex;gap:8px;font-size:11px;margin-top:2px' }, [
				E('span', { 'class': 'soc-muted' }, 'IQ '+p.iq),
				E('span', { 'class': 'soc-muted' }, 'OQ '+p.oq),
				drop ? E('span', { 'style': 'color:#f44336' }, fmtK(p.drops)) : null
			].filter(Boolean))
		]);
	});

	// 返回精簡佈局
	return E('div', { 'class': 'fe-diagram-container' }, [
		// PSE buffer bar
		E('div', { 'class': 'soc-card', 'style': 'margin-bottom:10px' }, [
			E('div', { 'style': 'display:flex;justify-content:space-between;margin-bottom:4px' }, [
				E('span', { 'class': 'soc-text', 'style': 'font-weight:bold;font-size:13px' }, 'PSE Shared Buffer'),
				E('span', { 'class': 'soc-muted', 'style': 'font-size:12px' }, (fe.pse_used||0)+' used / '+(fe.pse_free||0)+' free ('+pseP+'%)')
			]),
			E('div', { 'class': 'soc-bar-track', 'style': 'height:8px' }, [
				E('div', { 'style': 'background:'+pseCol+';height:100%;width:'+pseP+'%;border-radius:4px;transition:width .5s' })
			])
		]),
		// 上排：只顯示 GDM1 (Switch) 和 CDM1 (CPU DMA 1)
		E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:12px;margin-bottom:12px' }, [
			gdmCard('gdm1', 'GDM1', 'Internal Switch (1G LAN2/4)', '#ff9800', 'P1'),
			cdmCard('cdm1', 'CDM1', 'CPU DMA 1', 'P0')
		]),
		E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:12px;margin-bottom:12px' }, [
			gdmCard('gdm2', 'GDM2', '2.5G Port', '#ff9800', 'P2'),
			cdmCard('cdm2', 'CDM2', 'CPU DMA 2', 'P0')
		]),
		// 下排：PPE 和 NPU
		E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:12px' }, [
			ppeCard,
			npuCard
		])
		// E('div', { 'class': 'soc-text', 'style': 'font-size:12px;font-weight:600;margin-bottom:6px' }, 'PSE Port Queue Status'),
		// E('div', { 'class': 'soc-pse-grid' }, portCells)
	]);
}


/* ── CPU Frequency ── */
function freqBarState(hw, min, max, pll, gov) {
	var oc = gov==='performance' && pll>0 && (pll*1000)>max;
	return { freq: oc ? pll*1000 : Math.min(hw,max), max: oc ? pll*1000 : max, oc: oc };
}

function renderFreqBar(hw, min, max, pll, gov) {
    if (!max) return E('span', {}, 'N/A');

	// 修改這裡：取 PLL 和當前頻率中的最大值，並處理單位
    var val = Math.max(pll || 0, (hw > 2000 ? Math.round(hw / 1000) : hw));
    
    var current_mhz = val;
    var display_min = 700;
    var display_max = 1500; // 固定顯示上限為 1500，確保 1400 不爆表
    
    // 2. 重新定義 OC 判定：只有當頻率 > 1200 MHz 時才算超頻
    var is_oc = (current_mhz > 1200);
    
    // 3. 計算百分比：基於固定座標 (700-1500)
    var pct = Math.round(((current_mhz - display_min) / (display_max - display_min)) * 100);
    pct = Math.max(0, Math.min(100, pct));
    
    // 4. 設定顏色與文字標籤
    var bg = is_oc ? 'linear-gradient(90deg,#e65100,#ff9800)' : 'linear-gradient(90deg,#2e7d32,#66bb6a)';
    
    // 文字邏輯：超頻顯示 (OC)，普通狀態顯示 MHz
    var label = current_mhz + ' MHz' + (is_oc ? ' (OC)' : '');

    return E('div', { 'id': 'cpu-freq-bar-wrap', 'style': 'display:flex;align-items:center;gap:10px' }, [
        E('span', { 'class': 'soc-muted', 'style': 'font-size:90%' }, display_min + ' MHz'),
        E('div', { 'style': 'flex:1;border-radius:4px;height:22px;position:relative;min-width:180px;max-width:350px;overflow:hidden', 'class': 'soc-bar-track' }, [
            E('div', { 'id': 'cpu-freq-fill', 'style': 'background:' + bg + ';height:100%;border-radius:4px;width:' + pct + '%;transition:width .5s' }),
            E('span', { 'id': 'cpu-freq-text', 'style': 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:13px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)' }, label)
        ]),
        E('span', { 'id': 'cpu-freq-max-label', 'class': 'soc-muted', 'style': 'font-size:90%' }, display_max + ' MHz')
    ]);
}

function updateFreqBar(hw, min, max, pll, gov) {
    var el = document.getElementById('cpu-freq-text'), fl = document.getElementById('cpu-freq-fill'), ml = document.getElementById('cpu-freq-max-label');
    
    // 1. 數值與單位修正：處理 Hz (1400000) 或 MHz (1400)
    var val = Math.max(pll || 0, (hw > 2000 ? Math.round(hw / 1000) : hw));
    
    // 2. 座標設定：保持 700 到 1500 的顯示範圍
    var d_min = 700;
    var d_max = 1500;
    
    // 3. 修正 OC 判定：只有當頻率高於 1200 MHz 時才顯示為超頻狀態
    // 加入 pll > 1200 的判定，確保手動超頻也被正確識別
    var is_oc = (val > 1200);
    
    // 4. 更新中間文字：只有超頻時才加 (OC)
    if (el) el.textContent = val + ' MHz' + (is_oc ? ' (OC)' : '');
    
    // 5. 更新進度條百分比與顏色
    if (fl) {
        // 計算百分比：(當前值 - 最小值) / (最大值 - 最小值)
        var pct = Math.max(0, Math.min(100, Math.round(((val - d_min) / (d_max - d_min)) * 100)));
        fl.style.width = pct + '%';
        
        // 超頻顯示橘色漸層，普通顯示綠色漸層
        fl.style.background = is_oc ? 'linear-gradient(90deg,#e65100,#ff9800)' : 'linear-gradient(90deg,#2e7d32,#66bb6a)';
    }
    
    // 6. 更新右側最大標籤
    if (ml) ml.textContent = d_max + ' MHz';
}


function renderGovSelect(avail, active) {
	var gs = (avail||'').trim().split(/\s+/).filter(Boolean);
	if (!gs.length) return E('span',{},'N/A');
	return E('select', { 'id':'cpu-governor-select','class':'cbi-input-select','style':'min-width:140px','change':function(ev){
		var g=ev.target.value; ev.target.disabled=true;
		callSetGovernor(g).then(function(r){ev.target.disabled=false;if(r&&r.error) ui.addNotification(null,E('p',{},_('Error: ')+r.error),'error');}).catch(function(){ev.target.disabled=false;});
	}}, gs.map(function(g){return E('option',{'value':g,'selected':g===active?'':null},g);}));
}

function renderMaxFreqSelect(avail, cur) {
	var fs = (avail||'').trim().split(/\s+/).filter(Boolean);
	if (!fs.length) return E('span',{},'N/A');
	return E('select', { 'id':'cpu-maxfreq-select','class':'cbi-input-select','style':'min-width:140px','change':function(ev){
		var f=ev.target.value; ev.target.disabled=true;
		callSetMaxFreq(parseInt(f)).then(function(r){ev.target.disabled=false;if(r&&r.error) ui.addNotification(null,E('p',{},_('Error: ')+r.error),'error');}).catch(function(){ev.target.disabled=false;});
	}}, fs.map(function(f){return E('option',{'value':f,'selected':parseInt(f)===parseInt(cur)?'':null},(parseInt(f)/1000).toFixed(0)+' MHz');}));
}

function renderOcControls() {
	var inp = E('input',{'id':'oc-freq-input','type':'number','min':'700','max':'1400','step':'50','value':'1400','class':'cbi-input-text','style':'width:100px'});
	var btn = E('button',{'class':'cbi-button cbi-button-action','style':'margin-left:8px','click':function(){
		var f=parseInt(document.getElementById('oc-freq-input').value);
		if(isNaN(f)||f<500||f>1400){ui.addNotification(null,E('p',{},_('Must be 500-1400 MHz')),'error');return;}
		if(f>1500&&!confirm('Frequencies above 1500 MHz may be unstable. Continue?')) return;
		btn.disabled=true;btn.textContent=_('Applying...');
		callSetOverclock(f).then(function(r){btn.disabled=false;btn.textContent=_('Apply');
			if(r&&r.error) ui.addNotification(null,E('p',{},_('Failed: ')+r.error),'error');
			else if(r&&r.result==='ok') ui.addNotification(null,E('p',{},_('CPU set to ')+r.actual_mhz+' MHz'),'info');
		}).catch(function(e){btn.disabled=false;btn.textContent=_('Apply');});
	}},_('Apply'));
	return E('div',{'style':'display:flex;align-items:center;gap:8px;flex-wrap:wrap'},[
		inp, E('span',{'class':'soc-muted'},'MHz'), btn,
		E('span',{'class':'soc-muted','style':'font-size:85%;margin-left:8px'},_('Direct PLL. Stock max 1400 MHz. Stable up to 1500 MHz.'))
	]);
}

/* ── PPE Table ── */
function renderPpeRows(entries) {
	return entries.slice(0,100).map(function(e) {
		var eth = e.eth||''; if(eth==='00:00:00:00:00:00->00:00:00:00:00:00') eth='-';
		return E('tr',{'class':'tr'},[
			E('td',{'class':'td'},e.index), E('td',{'class':'td'},E('span',{'class':e.state==='BND'?'label-success':''},e.state)),
			E('td',{'class':'td'},e.type), E('td',{'class':'td'},e.orig||'-'), E('td',{'class':'td'},e.new_flow||'-'), E('td',{'class':'td'},eth)
		]);
	});
}

/* ── Main View ── */
return view.extend({
	load: function() {
		return Promise.all([ callNpuStatus(), callPpeEntries(), callTokenInfo(), callFrameEngine() ]);
	},

	render: function(data) {
		injectCSS();
		var st = data[0]||{}, ppe = data[1]||{}, ti = data[2]||{}, fe = data[3]||{};
		var entries = Array.isArray(ppe.entries) ? ppe.entries : [];
		var memR = Array.isArray(st.memory_regions) ? st.memory_regions : [];

		var view = E('div',{'class':'cbi-map'},[
			E('h2',{},_('Airoha SoC Status')),

			// CPU Frequency
			E('div',{'class':'cbi-section'},[
				E('h3',{},_('CPU Frequency')),
				E('table',{'class':'table'},[
					E('tr',{'class':'tr'},[ E('td',{'class':'td','width':'33%'},E('strong',{},_('Current Frequency'))), E('td',{'class':'td'}, renderFreqBar(st.cpu_hw_freq,st.cpu_min_freq,st.cpu_max_freq,st.pll_freq_mhz,st.cpu_governor)) ]),
					E('tr',{'class':'tr'},[ E('td',{'class':'td'},E('strong',{},_('Governor'))), E('td',{'class':'td'}, renderGovSelect(st.cpu_avail_governors,st.cpu_governor)) ]),
					E('tr',{'class':'tr'},[ E('td',{'class':'td'},E('strong',{},_('Max Frequency'))), E('td',{'class':'td'}, renderMaxFreqSelect(st.cpu_avail_freqs,st.cpu_max_freq)) ]),
					E('tr',{'class':'tr'},[ E('td',{'class':'td'},E('strong',{},_('Overclock'))), E('td',{'class':'td'}, renderOcControls()) ]),
					E('tr',{'class':'tr'},[ E('td',{'class':'td'},E('strong',{},_('CPU Cores'))), E('td',{'class':'td'},(st.cpu_count||0).toString()) ]),
					E('tr',{'class':'tr'},[ E('td',{'class':'td'},E('strong',{},_('Temperature'))), E('td',{'class':'td'}, st.cpu_temp ? (st.cpu_temp / 1000).toFixed(1) + ' °C' : 'N/A') ])
				])
			]),

			// NPU & Frame Engine (unified)
			E('div',{'class':'cbi-section'},[
				E('h3',{},_('NPU & Offload Engine')),
				E('table',{'class':'table'},[
					E('tr',{'class':'tr'},[ E('td',{'class':'td','width':'33%'},E('strong',{},_('NPU Status'))),
						E('td',{'class':'td','id':'npu-status'}, st.npu_loaded ?
							E('span',{'class':'label-success'},_('Active')+(st.npu_device?' ('+st.npu_device+')':'')) :
							E('span',{'class':'label-danger'},_('Not Active'))) ]),
					E('tr',{'class':'tr'},[ E('td',{'class':'td'},E('strong',{},_('Firmware / Clock / Cores'))),
						E('td',{'class':'td','id':'npu-info'}, (st.npu_version||'N/A')+' | '+(st.npu_clock?(st.npu_clock/1e6).toFixed(0)+' MHz':'N/A')+' | '+(st.npu_cores||0)+' cores') ]),
					E('tr',{'class':'tr'},[ E('td',{'class':'td'},E('strong',{},_('Reserved Memory'))),
						E('td',{'class':'td','id':'npu-memory'}, calcTotalMem(memR)+' ('+memR.length+' regions)') ])
				]),

				// Frame Engine diagram (includes WiFi bands, PPE flows, NPU indicator)
				E('div',{'style':'margin-top:12px'},[ E('h4',{'class':'soc-text','style':'font-size:14px;margin-bottom:8px'},_('Frame Engine'))]),
				E('div',{'id':'fe-container'}, renderFeDiagram(fe, ti, st))
			]),

			// PPE Flow Table
			E('div',{'class':'cbi-section'},[
				E('h3',{},_('PPE Flow Offload Entries')),
				E('table',{'class':'table','id':'ppe-entries-table'},[
					E('tr',{'class':'tr cbi-section-table-titles'},[
						E('th',{'class':'th'},_('Index')), E('th',{'class':'th'},_('State')), E('th',{'class':'th'},_('Type')),
						E('th',{'class':'th'},_('Original Flow')), E('th',{'class':'th'},_('New Flow')), E('th',{'class':'th'},_('Ethernet'))
					])
				].concat(renderPpeRows(entries)))
			])
		]);

		poll.add(L.bind(function() {
			return Promise.all([ callNpuStatus(), callPpeEntries(), callTokenInfo(), callFrameEngine() ]).then(L.bind(function(d) {
				injectCSS();
				var st=d[0]||{}, ppe=d[1]||{}, ti=d[2]||{}, fe=d[3]||{};
				var entries = Array.isArray(ppe.entries)?ppe.entries:[];

				updateFreqBar(st.cpu_hw_freq,st.cpu_min_freq,st.cpu_max_freq,st.pll_freq_mhz,st.cpu_governor);
				var gs=document.getElementById('cpu-governor-select'); if(gs&&!gs.matches(':focus')) gs.value=st.cpu_governor||'';
				var fs=document.getElementById('cpu-maxfreq-select'); if(fs&&!fs.matches(':focus')) fs.value=(st.cpu_max_freq||0).toString();

				var se=document.getElementById('npu-status');
				if(se){se.innerHTML='';var sp=document.createElement('span');sp.className=st.npu_loaded?'label-success':'label-danger';sp.textContent=st.npu_loaded?(_('Active')+(st.npu_device?' ('+st.npu_device+')':'')):_('Not Active');se.appendChild(sp);}

				var fc=document.getElementById('fe-container'); if(fc){fc.innerHTML='';fc.appendChild(renderFeDiagram(fe, ti, st));}

				var tb=document.getElementById('ppe-entries-table');
				if(tb){while(tb.rows.length>1)tb.deleteRow(1);renderPpeRows(entries).forEach(function(r){tb.appendChild(r);});}
			},this));
		},this), 5);

		return view;
	},

	handleSaveApply: null, handleSave: null, handleReset: null
});
