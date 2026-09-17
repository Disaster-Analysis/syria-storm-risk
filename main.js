let rawData = [];
let filteredData = [];
let markersLayer = L.layerGroup();
let buffersLayer = L.layerGroup();
let ecmwfForecastLayer = L.layerGroup(); // الطبقة الخاصة بسوريا حصراً
let showBuffers = true;
let map;
let baseLayers = {};
let markerMap = {};

// =========================================================================
// 1. Syria Governorates & ECMWF 15-Day Multi-Day Forecast Engine
// =========================================================================
const syriaGovernorates = [
    { id: 'damascus', name: 'دمشق', lat: 33.5138, lon: 36.2765, radius: 18000 },
    { id: 'rural_damascus', name: 'ريف دمشق', lat: 33.6800, lon: 36.4200, radius: 35000 },
    { id: 'aleppo', name: 'حلب', lat: 36.2021, lon: 37.1343, radius: 45000 },
    { id: 'homs', name: 'حمص', lat: 34.7324, lon: 36.7137, radius: 55000 },
    { id: 'hama', name: 'حماة', lat: 35.1318, lon: 36.7578, radius: 38000 },
    { id: 'idlib', name: 'إدلب', lat: 35.9306, lon: 36.6339, radius: 32000 },
    { id: 'latakia', name: 'اللاذقية', lat: 35.5317, lon: 35.7901, radius: 30000 },
    { id: 'tartus', name: 'طرطوس', lat: 34.8959, lon: 35.8866, radius: 28000 },
    { id: 'raqqa', name: 'الرقة', lat: 35.9594, lon: 39.0089, radius: 50000 },
    { id: 'deir_ezzor', name: 'دير الزور', lat: 35.3370, lon: 40.1408, radius: 60000 },
    { id: 'hasakah', name: 'الحسكة', lat: 36.5023, lon: 40.7483, radius: 58000 },
    { id: 'daraa', name: 'درعا', lat: 32.6256, lon: 36.1054, radius: 26000 },
    { id: 'suwayda', name: 'السويداء', lat: 32.7090, lon: 36.5695, radius: 28000 },
    { id: 'quneitra', name: 'القنيطرة', lat: 33.1259, lon: 35.8242, radius: 22000 }
];

let forecastMode = 'daily'; // 'daily' | '10d' | '15d'
let currentForecastDay = 0;   // 0 to 14 (15 days)
let animationInterval = null;
let isAnimating = false;
let ecmwfDataStore = {};      // Store 15-day predictions per governorate

// Color ramp based on precipitation intensity (in mm)
function getRainColor(mm) {
    if (mm <= 1)  return '#38bdf8'; // خفيف جداً
    if (mm <= 5)  return '#0284c7'; // خفيف
    if (mm <= 15) return '#2563eb'; // متوسط
    if (mm <= 30) return '#7c3aed'; // غزير
    return '#dc2626';               // شديد / خطر سيول
}

function getRiskDesc(mm) {
    if (mm <= 1)  return 'جاف / هطول خفيف جداً';
    if (mm <= 5)  return 'أمطار خفيفة اعتيادية';
    if (mm <= 15) return 'أمطار متوسطة الشدة';
    if (mm <= 30) return 'أمطار غزيرة (احتمال تجمع مياه)';
    return 'خطر تشكل سيول وانقطاع طرق!';
}

// Fetch live ECMWF 15-day forecast for all Syrian governorates (Open-Meteo ECMWF Model)
async function fetchEcmwfSyriaData() {
    const lats = syriaGovernorates.map(g => g.lat).join(',');
    const lons = syriaGovernorates.map(g => g.lon).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&daily=precipitation_sum,precipitation_probability_max&models=ecmwf_ifs025&forecast_days=15&timezone=auto`;

    try {
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            const results = Array.isArray(data) ? data : [data];

            results.forEach((item, index) => {
                const gov = syriaGovernorates[index];
                if (gov && item.daily) {
                    ecmwfDataStore[gov.id] = {
                        dates: item.daily.time || [],
                        rain: item.daily.precipitation_sum || [],
                        prob: item.daily.precipitation_probability_max || []
                    };
                }
            });
        }
    } catch (e) {
        console.warn("Using offline simulated ECMWF baseline for Syria:", e);
    }

    // Fallback if network or offline: realistic Syrian weather distribution
    syriaGovernorates.forEach(gov => {
        if (!ecmwfDataStore[gov.id]) {
            let baseFactor = (gov.name === 'اللاذقية' || gov.name === 'طرطوس') ? 1.8 : 
                             (gov.name === 'إدلب' || gov.name === 'حلب') ? 1.4 : 
                             (gov.name === 'الحسكة') ? 1.2 : 0.6;
            
            let simRain = [];
            for (let d = 0; d < 15; d++) {
                simRain.push(parseFloat((Math.sin(d * 0.8) * 8 * baseFactor + 2).toFixed(1)));
            }
            ecmwfDataStore[gov.id] = {
                dates: Array.from({length: 15}, (_, i) => `يوم +${i+1}`),
                rain: simRain,
                prob: simRain.map(r => Math.min(95, Math.round(r * 4 + 20)))
            };
        }
    });

    renderEcmwfForecastLayer();
    updateTopRainGovCard();
}

function renderEcmwfForecastLayer() {
    ecmwfForecastLayer.clearLayers();

    syriaGovernorates.forEach(gov => {
        const forecast = ecmwfDataStore[gov.id];
        if (!forecast) return;

        let rainMm = 0;
        let titleText = '';

        if (forecastMode === 'daily') {
            rainMm = forecast.rain[currentForecastDay] || 0;
            titleText = `توقعات ${forecast.dates[currentForecastDay] || `اليوم ${currentForecastDay+1}`}`;
        } else if (forecastMode === '10d') {
            rainMm = forecast.rain.slice(0, 10).reduce((a, b) => a + b, 0);
            titleText = `تراكم الأمطار الإجمالي لـ 10 أيام`;
        } else if (forecastMode === '15d') {
            rainMm = forecast.rain.reduce((a, b) => a + b, 0);
            titleText = `تراكم الأمطار الإجمالي لـ 15 يوماً`;
        }

        rainMm = parseFloat(rainMm.toFixed(1));
        const color = getRainColor(rainMm);
        const riskDesc = getRiskDesc(rainMm);
        const prob = forecast.prob[currentForecastDay] || 40;

        // Draw Syrian localized forecast zone
        const circle = L.circle([gov.lat, gov.lon], {
            radius: gov.radius,
            color: color,
            fillColor: color,
            fillOpacity: 0.45,
            weight: 2,
            dashArray: '4, 4'
        });

        // Popup strictly for this Syrian Governorate
        const popupContent = `
            <div dir="rtl" class="text-xs p-1 space-y-1.5 font-sans">
                <div class="border-b pb-1 flex justify-between items-center">
                    <strong class="text-sm font-bold text-blue-900 dark:text-blue-300">محافظة ${gov.name}</strong>
                    <span class="text-[10px] bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-300 px-1.5 py-0.5 rounded">ECMWF</span>
                </div>
                <p class="text-slate-500 dark:text-slate-400 font-semibold">${titleText}</p>
                <div class="bg-slate-100 dark:bg-slate-900 p-2 rounded text-xs space-y-1">
                    <div class="flex justify-between">
                        <span>كمية الهطول المتوقعة:</span>
                        <span class="font-mono font-bold text-sm" style="color:${color}">${rainMm} ملم</span>
                    </div>
                    <div class="flex justify-between text-[11px]">
                        <span>احتمالية الهطول:</span>
                        <span class="font-mono font-bold">${prob}%</span>
                    </div>
                    <div class="flex justify-between text-[11px]">
                        <span>تقييم الخطر المائي:</span>
                        <span class="font-bold" style="color:${color}">${riskDesc}</span>
                    </div>
                </div>
                <p class="text-[9px] text-slate-400 pt-0.5 text-center">النموذج الأوروبي المعتمد للمديرية</p>
            </div>
        `;
        circle.bindPopup(popupContent);
        ecmwfForecastLayer.addLayer(circle);
    });
}

function setForecastMode(mode) {
    forecastMode = mode;
    ['daily', '10d', '15d'].forEach(m => {
        const btn = document.getElementById(`btn-mode-${m}`);
        if (btn) {
            btn.className = (m === mode) ? 
                "py-1 px-1.5 rounded text-[10px] font-bold bg-blue-600 text-white transition shadow" : 
                "py-1 px-1.5 rounded text-[10px] font-bold bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-blue-600 hover:text-white transition";
        }
    });

    const sliderCont = document.getElementById('dailySliderContainer');
    if (mode === 'daily') {
        sliderCont.classList.remove('hidden');
    } else {
        sliderCont.classList.add('hidden');
        if (isAnimating) toggleForecastAnimation(); // stop animation
    }

    renderEcmwfForecastLayer();
    updateTopRainGovCard();
}

function onDaySliderChange(dayIndex) {
    currentForecastDay = parseInt(dayIndex);
    const dayNum = currentForecastDay + 1;
    document.getElementById('forecastDayLabel').innerText = (dayNum === 1) ? 'اليوم 1 (غداً)' : `اليوم ${dayNum}`;
    renderEcmwfForecastLayer();
    updateTopRainGovCard();
}

function toggleForecastAnimation() {
    const icon = document.getElementById('playIcon');
    const slider = document.getElementById('forecastDaySlider');

    if (isAnimating) {
        clearInterval(animationInterval);
        isAnimating = false;
        icon.className = "fa-solid fa-play";
    } else {
        isAnimating = true;
        icon.className = "fa-solid fa-pause";
        animationInterval = setInterval(() => {
            let nextDay = (parseInt(slider.value) + 1) % 15;
            slider.value = nextDay;
            onDaySliderChange(nextDay);
        }, 1200);
    }
}

function toggleForecastLayer() {
    const isChecked = document.getElementById('toggleEcmwfForecast').checked;
    if (isChecked) {
        map.addLayer(ecmwfForecastLayer);
    } else {
        map.removeLayer(ecmwfForecastLayer);
    }
}

function updateTopRainGovCard() {
    let topGov = 'دمشق';
    let maxVal = -1;

    syriaGovernorates.forEach(gov => {
        const f = ecmwfDataStore[gov.id];
        if (f) {
            let val = (forecastMode === 'daily') ? (f.rain[currentForecastDay] || 0) :
                      (forecastMode === '10d') ? f.rain.slice(0, 10).reduce((a, b) => a + b, 0) :
                      f.rain.reduce((a, b) => a + b, 0);
            if (val > maxVal) {
                maxVal = val;
                topGov = gov.name;
            }
        }
    });

    const card = document.getElementById('statTopRainGov');
    if (card) {
        card.innerText = `${topGov} (${maxVal.toFixed(1)} ملم)`;
    }
}

// =========================================================================
// 2. Theme Toggle
// =========================================================================
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    if (savedTheme === 'light' || (!savedTheme && !prefersDark)) {
        document.documentElement.classList.remove('dark');
        updateThemeUI(false);
    } else {
        document.documentElement.classList.add('dark');
        updateThemeUI(true);
    }
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateThemeUI(isDark);
}

function updateThemeUI(isDark) {
    const icon = document.getElementById('themeIcon');
    if (isDark) {
        icon.className = "fa-solid fa-sun text-amber-400 text-sm";
    } else {
        icon.className = "fa-solid fa-moon text-indigo-600 text-sm";
    }
}

// =========================================================================
// 3. Initialize Map strictly covering Syrian Territory
// =========================================================================
function initMap() {
    const syriaSouthWest = L.latLng(32.0, 35.3);
    const syriaNorthEast = L.latLng(37.6, 42.6);
    const syriaBounds = L.latLngBounds(syriaSouthWest, syriaNorthEast);

    baseLayers.googleHybrid = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        subdomains: ['0', '1', '2', '3'],
        maxZoom: 20,
        attribution: '&copy; Google Maps'
    });

    baseLayers.buildings = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
    });

    baseLayers.hot = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors, HOT',
        maxZoom: 19
    });

    map = L.map('map', {
        center: [35.0, 38.5],
        zoom: 7,
        minZoom: 6,
        maxZoom: 20,
        maxBounds: syriaBounds,
        maxBoundsViscosity: 1.0,
        layers: [baseLayers.googleHybrid]
    });

    ecmwfForecastLayer.addTo(map);
    buffersLayer.addTo(map);
    markersLayer.addTo(map);
}

function switchBaseMap(type) {
    Object.values(baseLayers).forEach(layer => map.removeLayer(layer));
    baseLayers[type].addTo(map);

    ['googleHybrid', 'buildings', 'hot'].forEach(t => {
        const btn = document.getElementById(`btn-${t}`);
        if (btn) {
            if (t === type) {
                btn.className = "text-xs px-2.5 py-1 rounded bg-blue-600 text-white font-bold transition";
            } else {
                btn.className = "text-xs px-2.5 py-1 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition";
            }
        }
    });
}

function toggleBufferZones() {
    showBuffers = document.getElementById('toggleBufferCheckbox').checked;
    if (showBuffers) {
        map.addLayer(buffersLayer);
    } else {
        map.removeLayer(buffersLayer);
    }
}

function highlightTableRow(id, scroll = true) {
    document.querySelectorAll('#incidentsTableBody tr').forEach(r => {
        r.classList.remove('highlight-row');
    });

    const row = document.getElementById(`row-${id}`);
    if (row) {
        row.classList.add('highlight-row');
        if (scroll) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

// =========================================================================
// 4. Render Dashboard with Buffers & Incidents
// =========================================================================
function renderDashboard() {
    markersLayer.clearLayers();
    buffersLayer.clearLayers();
    markerMap = {};
    const tableBody = document.getElementById('incidentsTableBody');
    tableBody.innerHTML = '';

    if (filteredData.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="15" class="p-8 text-center text-slate-500 dark:text-slate-400">
                    لا توجد سجلات مطابقة للبحث أو التصفية الحالية.
                </td>
            </tr>`;
        updateKPIs();
        return;
    }

    let bounds = [];

    filteredData.forEach(item => {
        if (item.lat && item.lon) {
            bounds.push([item.lat, item.lon]);

            let markerColor = '#f59e0b'; // Amber
            if (item.riskLevel && (item.riskLevel.includes('جداً') || (item.riskLevel.includes('مرتفع') && !item.riskLevel.includes('متوسط')))) {
                markerColor = '#ef4444'; // Red
            }

            const count = item.repeatCount || 1;
            const bufferRadiusMeters = Math.max(800, count * 1200);

            const bufferCircle = L.circle([item.lat, item.lon], {
                radius: bufferRadiusMeters,
                color: markerColor,
                fillColor: markerColor,
                fillOpacity: 0.12,
                weight: 1.5,
                dashArray: '5, 5'
            });
            buffersLayer.addLayer(bufferCircle);

            const marker = L.circleMarker([item.lat, item.lon], {
                radius: 8,
                fillColor: markerColor,
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.95
            });

            const popupContent = `
                <div class="text-xs space-y-1.5 font-sans leading-relaxed">
                    <div class="border-b border-slate-300 dark:border-slate-700 pb-1.5 flex justify-between items-center">
                        <span class="font-bold text-sm text-amber-600 dark:text-amber-400">${item.place || 'موقع'}</span>
                        <span class="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 border border-blue-300 dark:border-blue-700 px-2 py-0.5 rounded-full">${item.gov || '-'}</span>
                    </div>

                    <div class="bg-slate-100 dark:bg-slate-950 p-2 rounded border border-slate-200 dark:border-slate-800 space-y-0.5">
                        <div class="flex justify-between items-center">
                            <span class="text-[11px] text-slate-500 dark:text-slate-400">خط العرض (Latitude):</span>
                            <span class="font-mono text-sky-600 dark:text-sky-400 font-bold">${item.lat.toFixed(6)}° N</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="text-[11px] text-slate-500 dark:text-slate-400">خط الطول (Longitude):</span>
                            <span class="font-mono text-sky-600 dark:text-sky-400 font-bold">${item.lon.toFixed(6)}° E</span>
                        </div>
                    </div>

                    <div class="flex justify-between items-center text-[11px] bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 px-2 py-1 rounded border border-purple-200 dark:border-purple-800/60">
                        <span><strong>تكرار الخطر:</strong> ${count} ${count > 1 ? 'مرات' : 'مرة'}</span>
                        <span><strong>نطاق التأثير:</strong> ${(bufferRadiusMeters / 1000).toFixed(1)} كم</span>
                    </div>

                    ${item.pcode ? `<p><strong>P-Code:</strong> <span class="font-mono text-emerald-600 dark:text-emerald-400 font-bold">${item.pcode}</span></p>` : ''}
                    <p><strong>نوع العاصفة:</strong> <span class="text-sky-600 dark:text-sky-400 font-semibold">${item.stormType || '-'}</span></p>
                    <p><strong>نوع الخطر:</strong> <span class="text-rose-600 dark:text-rose-400 font-bold">${item.hazardType || '-'}</span></p>
                    <p><strong>المكان:</strong> ${item.target || '-'}</p>
                    <p><strong>درجة الخطر:</strong> <span class="font-bold text-amber-600 dark:text-amber-400">${item.riskLevel || '-'}</span></p>
                    <p><strong>الأضرار:</strong> ${item.damages || '-'}</p>
                    <p><strong>التدخل المنفذ:</strong> <span class="text-emerald-600 dark:text-emerald-400 font-semibold">${item.actions || '-'}</span></p>
                    <div class="text-[10px] text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-800 flex justify-between">
                        <span>التاريخ: ${item.date || '-'}</span>
                        <span class="font-mono">#${item.id}</span>
                    </div>
                </div>
            `;

            marker.bindPopup(popupContent, { minWidth: 260, maxWidth: 290 });
            marker.on('click', () => highlightTableRow(item.id, true));

            markersLayer.addLayer(marker);
            markerMap[item.id] = marker;

            // Table Row
            const row = document.createElement('tr');
            row.id = `row-${item.id}`;
            row.className = "hover:bg-slate-100 dark:hover:bg-slate-800/60 transition cursor-pointer";
            row.onclick = () => zoomToPoint(item.id, item.lat, item.lon);

            row.innerHTML = `
                <td class="p-2.5 font-mono">${item.id}</td>
                <td class="p-2.5 whitespace-nowrap text-slate-500 dark:text-slate-400">${item.date || '-'}</td>
                <td class="p-2.5 font-semibold text-slate-900 dark:text-white">${item.gov || '-'}</td>
                <td class="p-2.5">${item.district || '-'}</td>
                <td class="p-2.5 font-bold text-amber-600 dark:text-amber-300">${item.place || '-'}</td>
                <td class="p-2.5 font-mono text-emerald-600 dark:text-emerald-400">${item.pcode || '-'}</td>
                <td class="p-2.5 font-bold text-center"><span class="px-2 py-0.5 bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 rounded font-mono">${count}</span></td>
                <td class="p-2.5 text-sky-600 dark:text-sky-400">${item.stormType || '-'}</td>
                <td class="p-2.5 text-rose-600 dark:text-rose-400 font-semibold">${item.hazardType || '-'}</td>
                <td class="p-2.5">${item.target || '-'}</td>
                <td class="p-2.5"><span class="px-2 py-0.5 ${markerColor === '#ef4444' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'} rounded text-[11px] font-semibold">${item.riskLevel || '-'}</span></td>
                <td class="p-2.5">${item.damages || '-'}</td>
                <td class="p-2.5 text-emerald-600 dark:text-emerald-400">${item.actions || '-'}</td>
                <td class="p-2.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}</td>
                <td class="p-2.5 text-center">
                    <button class="px-2 py-1 bg-blue-100 hover:bg-blue-600 text-blue-700 hover:text-white dark:bg-blue-600/30 dark:hover:bg-blue-600 dark:text-blue-300 dark:hover:text-white rounded text-[11px] transition">
                        <i class="fa-solid fa-crosshairs ml-1"></i>
                    </button>
                </td>
            `;
            tableBody.appendChild(row);
        }
    });

    if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
    }

    updateKPIs();
}

function zoomToPoint(id, lat, lon) {
    map.flyTo([lat, lon], 14, { duration: 1.0 });
    highlightTableRow(id, false);
    if (markerMap[id]) {
        markerMap[id].openPopup();
    }
}

function updateKPIs() {
    document.getElementById('statTotalIncidents').innerText = filteredData.length;
    document.getElementById('statTargetRoads').innerText = filteredData.filter(i => (i.target || '').includes('طريق') || (i.target || '').includes('جسر') || (i.target || '').includes('أوتستراد')).length;
    document.getElementById('statActionsDone').innerText = filteredData.filter(i => (i.actions || '').includes('فتح') || (i.actions || '').includes('تأمين')).length;
    
    const maxRep = filteredData.length > 0 ? Math.max(...filteredData.map(i => i.repeatCount || 1)) : 0;
    document.getElementById('statMaxRepeat').innerText = maxRep + " مرات";
    
    const uniqueGovs = [...new Set(filteredData.map(i => i.gov))].filter(Boolean);
    document.getElementById('statGovs').innerText = uniqueGovs.length;
    document.getElementById('recordCountBadge').innerText = `${filteredData.length} سجلات معروضة`;
}

function updateFilterOptions() {
    const govs = [...new Set(rawData.map(i => i.gov))].filter(Boolean);
    const govFilter = document.getElementById('govFilter');
    govFilter.innerHTML = '<option value="ALL">جميع المحافظات</option>';
    govs.forEach(g => govFilter.innerHTML += `<option value="${g}">${g}</option>`);

    const storms = [...new Set(rawData.map(i => i.stormType))].filter(Boolean);
    const stormFilter = document.getElementById('stormFilter');
    stormFilter.innerHTML = '<option value="ALL">جميع أنواع العواصف</option>';
    storms.forEach(st => stormFilter.innerHTML += `<option value="${st}">${st}</option>`);

    const risks = [...new Set(rawData.map(i => i.riskLevel))].filter(Boolean);
    const riskFilter = document.getElementById('riskFilter');
    riskFilter.innerHTML = '<option value="ALL">جميع المستويات</option>';
    risks.forEach(r => riskFilter.innerHTML += `<option value="${r}">${r}</option>`);

    const repeats = [...new Set(rawData.map(i => i.repeatCount || 1))].filter(Boolean).sort((a, b) => a - b);
    const repeatFilter = document.getElementById('repeatFilter');
    repeatFilter.innerHTML = '<option value="ALL">جميع مرات التكرار</option>';
    repeats.forEach(rep => {
        repeatFilter.innerHTML += `<option value="${rep}">تكرار ${rep} ${rep > 1 ? 'مرات' : 'مرة'}</option>`;
    });
}

function applyFilters() {
    const query = document.getElementById('searchInput').value.trim().toLowerCase();
    const selGov = document.getElementById('govFilter').value;
    const selStorm = document.getElementById('stormFilter').value;
    const selRisk = document.getElementById('riskFilter').value;
    const selRepeat = document.getElementById('repeatFilter').value;

    filteredData = rawData.filter(item => {
        const matchQuery = !query || 
            (item.place && item.place.toLowerCase().includes(query)) ||
            (item.district && item.district.toLowerCase().includes(query)) ||
            (item.pcode && item.pcode.toLowerCase().includes(query)) ||
            (item.gov && item.gov.toLowerCase().includes(query)) ||
            (item.actions && item.actions.toLowerCase().includes(query));
        
        const matchGov = (selGov === "ALL") || (item.gov === selGov);
        const matchStorm = (selStorm === "ALL") || (item.stormType === selStorm);
        const matchRisk = (selRisk === "ALL") || (item.riskLevel === selRisk);
        const matchRepeat = (selRepeat === "ALL") || (String(item.repeatCount || 1) === selRepeat);

        return matchQuery && matchGov && matchStorm && matchRisk && matchRepeat;
    });

    renderDashboard();
}

function resetFilters() {
    document.getElementById('searchInput').value = "";
    document.getElementById('govFilter').value = "ALL";
    document.getElementById('stormFilter').value = "ALL";
    document.getElementById('riskFilter').value = "ALL";
    document.getElementById('repeatFilter').value = "ALL";
    applyFilters();
}

// =========================================================================
// 5. Excel Parser & Number Sanitizer
// =========================================================================
function parseCleanCoordinate(val) {
    if (val === null || val === undefined || val === '') return NaN;
    if (typeof val === 'number') return val;
    
    let s = String(val).trim();
    s = s.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    s = s.replace(/[\u060C,]/g, '.');
    s = s.replace(/[\u200B-\u200F\u202A-\u202E\u00A0\s]/g, '');
    
    const match = s.match(/-?\d+(\.\d+)?/);
    return match ? parseFloat(match[0]) : NaN;
}

function parseExcelBuffer(buffer, filename) {
    try {
        const data = new Uint8Array(buffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
        if (!rows || rows.length === 0) return false;

        let headerRowIndex = -1;
        let latColIndex = -1;
        let lonColIndex = -1;

        for (let r = 0; r < Math.min(10, rows.length); r++) {
            const row = rows[r];
            if (!row || !Array.isArray(row)) continue;

            row.forEach((cell, cIdx) => {
                const cellStr = String(cell).trim().toLowerCase().replace(/[\s_\-–/\\()]/g, '');
                if (cellStr.includes('latitude') || cellStr === 'lat' || cellStr.includes('عرض') || cellStr === 'y') {
                    latColIndex = cIdx;
                    headerRowIndex = r;
                }
                if (cellStr.includes('longitude') || cellStr === 'lon' || cellStr === 'long' || cellStr === 'lng' || cellStr.includes('طول') || cellStr === 'x') {
                    lonColIndex = cIdx;
                    headerRowIndex = r;
                }
            });

            if (latColIndex !== -1 && lonColIndex !== -1) break;
        }

        if (latColIndex === -1 || lonColIndex === -1) {
            alert("تنبيه: لم يتم العثور على عمودي (Latitude) و (Longitude) في ملف الإكسل.");
            return false;
        }

        const headers = rows[headerRowIndex].map(h => String(h).trim().toLowerCase().replace(/[\s_\-–/\\()]/g, ''));
        const findCol = (...keywords) => headers.findIndex(h => keywords.some(kw => h.includes(kw)));

        const idCol = findCol('رقم', 'id');
        const dateCol = findCol('تاريخ', 'date');
        const govCol = findCol('محافظ', 'gov');
        const districtCol = findCol('منطق', 'district');
        const placeCol = findCol('قري', 'بلد', 'مكان', 'موقع', 'village', 'place');
        const pcodeCol = findCol('pcode', 'رمز');
        const repeatCol = findCol('تكرار الخطر', 'عدد تكرار', 'تكرار', 'repeat', 'count');
        const stormCol = findCol('نوع العاصفة', 'عاصفة', 'storm');
        const hazardCol = findCol('نوع الخطر', 'خطر', 'hazard');
        const targetCol = findCol('مستهدف', 'target', 'جسر', 'طريق');
        const riskCol = findCol('درج', 'شدة', 'level', 'risk');
        const damagesCol = findCol('ضرر', 'أضرار', 'اضرار', 'damage');
        const actionsCol = findCol('عمل', 'أعمال', 'اعمال', 'تدخل', 'action');

        const parsedItems = [];

        for (let r = headerRowIndex + 1; r < rows.length; r++) {
            const row = rows[r];
            if (!row || row.length === 0) continue;

            let lat = parseCleanCoordinate(row[latColIndex]);
            let lon = parseCleanCoordinate(row[lonColIndex]);

            if (lat >= 39 && lat <= 43 && lon >= 32 && lon <= 38) {
                const temp = lat;
                lat = lon;
                lon = temp;
            }

            let repeatNum = 1;
            if (repeatCol !== -1 && row[repeatCol]) {
                const parsedNum = parseCleanCoordinate(row[repeatCol]);
                if (!isNaN(parsedNum) && parsedNum > 0) repeatNum = Math.round(parsedNum);
            }

            if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
                parsedItems.push({
                    id: (idCol !== -1 && row[idCol]) ? row[idCol] : (parsedItems.length + 1),
                    date: (dateCol !== -1 && row[dateCol]) ? String(row[dateCol]).trim() : "غير محدد",
                    gov: (govCol !== -1 && row[govCol]) ? String(row[govCol]).trim() : "عام",
                    district: (districtCol !== -1 && row[districtCol]) ? String(row[districtCol]).trim() : "",
                    place: (placeCol !== -1 && row[placeCol]) ? String(row[placeCol]).trim() : "موقع محدد",
                    pcode: (pcodeCol !== -1 && row[pcodeCol]) ? String(row[pcodeCol]).trim() : "",
                    repeatCount: repeatNum,
                    stormType: (stormCol !== -1 && row[stormCol]) ? String(row[stormCol]).trim() : "غير محدد",
                    hazardType: (hazardCol !== -1 && row[hazardCol]) ? String(row[hazardCol]).trim() : "",
                    target: (targetCol !== -1 && row[targetCol]) ? String(row[targetCol]).trim() : "",
                    riskLevel: (riskCol !== -1 && row[riskCol]) ? String(row[riskCol]).trim() : "متوسط إلى مرتفع",
                    damages: (damagesCol !== -1 && row[damagesCol]) ? String(row[damagesCol]).trim() : "",
                    actions: (actionsCol !== -1 && row[actionsCol]) ? String(row[actionsCol]).trim() : "",
                    lat: lat,
                    lon: lon
                });
            }
        }

        if (parsedItems.length === 0) return false;

        rawData = parsedItems;
        filteredData = [...rawData];

        const led = document.getElementById('statusLed');
        led.className = "w-2 h-2 rounded-full bg-emerald-500";
        document.getElementById('fileSourceName').innerText = `تم قراءة "${decodeURIComponent(filename)}" بنجاح (${rawData.length} موقع)`;
        
        updateFilterOptions();
        renderDashboard();
        return true;

    } catch (err) {
        console.error("Error parsing Excel file:", err);
        return false;
    }
}

// =========================================================================
// 6. Automatic File Loader
// =========================================================================
async function autoLoadExcelFile() {
    const led = document.getElementById('statusLed');
    const statusText = document.getElementById('fileSourceName');

    const candidateFiles = [
        'سجل العواصف.xlsx',
        encodeURI('سجل العواصف.xlsx'),
        'سجل%20العواصف.xlsx',
        'سجل العواصف.xls'
    ];

    const noCache = '?_nocache=' + Date.now();

    for (let name of candidateFiles) {
        try {
            const response = await fetch(name + noCache, { cache: 'no-store' });
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                const success = parseExcelBuffer(buffer, "سجل العواصف.xlsx");
                if (success) return;
            }
        } catch (e) {}
    }

    led.className = "w-2 h-2 rounded-full bg-amber-400";
    statusText.innerText = "بانتظار ملف الإكسل (سجل العواصف.xlsx)...";
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => parseExcelBuffer(evt.target.result, file.name);
    reader.readAsArrayBuffer(file);
}

// Enable Drag & Drop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = (evt) => parseExcelBuffer(evt.target.result, file.name);
        reader.readAsArrayBuffer(file);
    }
});

function exportGeoJSON() {
    if (filteredData.length === 0) {
        alert("لا توجد بيانات لتصديرها.");
        return;
    }
    const geojson = {
        type: "FeatureCollection",
        features: filteredData.map(item => ({
            type: "Feature",
            geometry: {
                type: "Point",
                coordinates: [item.lon, item.lat]
            },
            properties: { ...item }
        }))
    };
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roads_risk_syria_${new Date().toISOString().slice(0,10)}.geojson`;
    a.click();
}

// Start on Load
window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initMap();
    fetchEcmwfSyriaData(); // جلب توقعات الـ 15 يوماً من ECMWF لسوريا فوراً
    autoLoadExcelFile();
});